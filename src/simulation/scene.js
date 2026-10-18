import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// This view consumes simulation snapshots only. It has no printer, network, or
// persistence access; edits leave the view through the onMove callback.
const STATE = {
  idle: { color: 0x8ea4ac, text: 'Ready' },
  printing: { color: 0x4de1be, text: 'Printing' },
  cooling: { color: 0x68b5ff, text: 'Cooling' },
  waiting_clear: { color: 0xf2c56a, text: 'Waiting for robot' },
  clearing: { color: 0xb49aff, text: 'Clearing bed' },
  blocked: { color: 0xff887d, text: 'Needs attention' },
  offline: { color: 0x667b86, text: 'Offline' },
};
const ZONE_COLORS = [0x57c7b0, 0x8baff0, 0xe5b56c, 0xb29ae4, 0xd78eaf, 0x8bbbaa];
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const hash = value => [...String(value || '')].reduce((sum, letter) => (Math.imul(sum, 31) + letter.charCodeAt(0)) | 0, 0) >>> 0;
const cssColor = color => `#${color.toString(16).padStart(6, '0')}`;
const applyStyle = (element, styles) => Object.assign(element.style, styles);

function noScene(container, onError, message) {
  container.dataset.webgl = 'unavailable';
  const fallback = document.createElement('div');
  fallback.className = 'sim-webgl-fallback';
  fallback.textContent = '3D view unavailable. The farm list, scenario editor and simulation controls remain available.';
  applyStyle(fallback, { padding: '28px', color: '#c2d6dc', maxWidth: '440px', lineHeight: '1.65' });
  container.append(fallback);
  queueMicrotask(() => onError?.(message));
  return {
    update() {}, setView() {}, focus() {}, resize() {}, select() {}, setEditable() {}, resetCamera() {},
    getDiagnostics: () => ({ available: false, reason: message }),
    dispose() { fallback.remove(); delete container.dataset.webgl; },
  };
}

/** Locally rendered, procedural 3D farm. x/z positions and room sizes are meters. */
export function createFarmScene(container, { onSelect, onMove, onError } = {}) {
  if (!container || typeof container.append !== 'function') throw new Error('A scene container is required.');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  } catch (error) {
    return noScene(container, onError, `WebGL could not start: ${error.message}`);
  }
  // A software GPU is a valid WebGL renderer, but continuously submitting
  // high-resolution shadow passes can starve the rest of a desktop app.
  let softwareRenderer = false;
  try {
    const context = renderer.getContext();
    const debug = context.getExtension('WEBGL_debug_renderer_info');
    const description = debug ? context.getParameter(debug.UNMASKED_RENDERER_WEBGL) : context.getParameter(context.RENDERER);
    softwareRenderer = /swiftshader|llvmpipe|softpipe|software|microsoft basic render/i.test(String(description));
  } catch { /* Restricted graphics information keeps the standard profile. */ }
  const targetFps = softwareRenderer ? 10 : 24;

  let disposed = false;
  let contextLost = false;
  let editing = false;
  let selectedId = null;
  let selectedKind = 'printer';
  let snapshot = null;
  let frame = 0;
  let animationId;
  let roomWidth = 16;
  let roomDepth = 12;
  let roomKey = '';
  let drag = null;
  let pointerStart = null;
  let view = 'perspective';
  let lastDraw = 0;
  let lastAnimationTick = 0;
  let animationSeconds = 0;
  let needsRender = true;
  let needsShadowRender = true;
  let applyingSnapshot = false;
  let snapshotKey = '';
  let lastShadowDraw = 0;
  const motionPreference = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  let reducedMotion = Boolean(motionPreference?.matches);
  const materialPool = new Set();
  const geometryPool = new Set();
  const textures = new Set();
  const printers = new Map();
  const clearers = new Map();
  const pickTargets = [];
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const scratch = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const projected = new THREE.Vector3();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x132730);
  scene.fog = new THREE.Fog(0x132730, 30, 100);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 180);
  const cameraTarget = new THREE.Vector3();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, softwareRenderer ? 1 : 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.3;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  const canvas = renderer.domElement;
  canvas.className = 'sim-three-canvas';
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Interactive 3D print farm. Drag to orbit, scroll to zoom. Select printers in the farm list for keyboard access.');
  applyStyle(canvas, { display: 'block', width: '100%', height: '100%', position: 'absolute', inset: '0', outlineOffset: '-3px' });
  container.append(canvas);
  container.dataset.webgl = 'available';

  const labels = document.createElement('div');
  labels.className = 'sim-scene-labels';
  labels.setAttribute('aria-hidden', 'true');
  applyStyle(labels, { position: 'absolute', inset: '0', overflow: 'hidden', pointerEvents: 'none' });
  container.append(labels);
  const hint = document.createElement('div');
  hint.className = 'sim-scene-hint';
  applyStyle(hint, { position: 'absolute', bottom: '15px', left: '16px', right: '16px', color: '#9db8c0', font: '10px/1.5 system-ui, sans-serif', letterSpacing: '.02em', pointerEvents: 'none', textShadow: '0 1px 3px #132730' });
  hint.textContent = 'Drag to orbit · Scroll to zoom · Click a printer to inspect';
  container.append(hint);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.085;
  controls.maxPolarAngle = Math.PI / 2.12;
  controls.minPolarAngle = 0.035;
  controls.minDistance = 3;
  controls.maxDistance = 55;
  controls.screenSpacePanning = false;
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  function onControlsChange() { needsRender = true; }
  controls.addEventListener('change', onControlsChange);

  scene.add(new THREE.HemisphereLight(0xd8edf4, 0x344445, 2.7));
  const keyLight = new THREE.DirectionalLight(0xfff2d9, 3.1);
  keyLight.position.set(4, 15, 8);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(softwareRenderer ? 512 : 1536, softwareRenderer ? 512 : 1536);
  keyLight.shadow.camera.near = 0.5;
  keyLight.shadow.camera.far = 70;
  keyLight.shadow.bias = -0.0007;
  keyLight.shadow.normalBias = 0.035;
  scene.add(keyLight, keyLight.target);
  const rimLight = new THREE.DirectionalLight(0x8dbddf, 1.6);
  rimLight.position.set(-8, 8, -4);
  scene.add(rimLight);

  const material = options => { const value = new THREE.MeshStandardMaterial(options); materialPool.add(value); return value; };
  const basic = options => { const value = new THREE.MeshBasicMaterial(options); materialPool.add(value); return value; };
  const geometry = value => { geometryPool.add(value); return value; };
  const boxGeometry = geometry(new THREE.BoxGeometry(1, 1, 1));
  const cylinderGeometry = geometry(new THREE.CylinderGeometry(1, 1, 1, 18));
  const sphereGeometry = geometry(new THREE.SphereGeometry(1, 12, 8));
  const ringGeometry = geometry(new THREE.TorusGeometry(0.66, 0.018, 6, 48));
  const pickMaterial = basic({ visible: false });
  const steel = material({ color: 0x263b46, metalness: 0.55, roughness: 0.44 });
  const frameMaterial = material({ color: 0xcad7d7, metalness: 0.35, roughness: 0.48 });
  const dark = material({ color: 0x142630, metalness: 0.3, roughness: 0.6 });
  const glass = material({ color: 0x83b9bb, transparent: true, opacity: 0.16, metalness: 0.04, roughness: 0.1, depthWrite: false });
  const bedMaterial = material({ color: 0x647777, metalness: 0.5, roughness: 0.62 });
  const robotMaterial = material({ color: 0xe5b46d, metalness: 0.3, roughness: 0.36 });
  const white = material({ color: 0xe6eee5, metalness: 0.1, roughness: 0.6 });

  function mesh(parent, meshGeometry, meshMaterial, position, scale, shadow = true) {
    const value = new THREE.Mesh(meshGeometry, meshMaterial);
    if (position) value.position.set(...position);
    if (scale) value.scale.set(...scale);
    value.castShadow = shadow;
    value.receiveShadow = shadow;
    parent.add(value);
    return value;
  }
  const box = (parent, meshMaterial, position, scale, shadow = true) => mesh(parent, boxGeometry, meshMaterial, position, scale, shadow);
  const cylinder = (parent, meshMaterial, position, scale, shadow = true) => mesh(parent, cylinderGeometry, meshMaterial, position, scale, shadow);

  function createLabel(kind) {
    const root = document.createElement('div');
    applyStyle(root, { position: 'absolute', top: '0', left: '0', transform: 'translate(-50%, -100%)', minWidth: '82px', maxWidth: '145px', padding: '6px 9px', background: 'rgba(16,35,44,.9)', border: '1px solid rgba(137,173,183,.25)', borderRadius: '7px', color: '#e9f2ef', font: '11px/1.3 system-ui, sans-serif', textAlign: 'left', boxShadow: '0 3px 10px #10232c33', willChange: 'transform' });
    const name = document.createElement('div');
    applyStyle(name, { fontWeight: '650', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
    const status = document.createElement('div');
    applyStyle(status, { fontSize: '9px', marginTop: '3px', display: 'flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap' });
    const dot = document.createElement('span');
    applyStyle(dot, { width: '5px', height: '5px', borderRadius: '50%', flexShrink: '0' });
    const text = document.createElement('span');
    status.append(dot, text);
    const track = document.createElement('div');
    applyStyle(track, { height: '2px', background: '#ffffff16', borderRadius: '2px', overflow: 'hidden', marginTop: '5px', display: 'none' });
    const bar = document.createElement('div');
    applyStyle(bar, { height: '100%', width: '0', background: '#4de1be' });
    track.append(bar);
    root.append(name, status, track);
    root.dataset.kind = kind;
    labels.append(root);
    return { root, name, status, dot, text, track, bar };
  }

  function textPlaque(text, width, height, color = '#c2d8d7') {
    const textureCanvas = document.createElement('canvas');
    textureCanvas.width = 1024;
    textureCanvas.height = 160;
    const context = textureCanvas.getContext('2d');
    context.clearRect(0, 0, textureCanvas.width, textureCanvas.height);
    context.fillStyle = color;
    context.font = '600 54px system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, 512, 80, 990);
    const texture = new THREE.CanvasTexture(textureCanvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    textures.add(texture);
    const value = basic({ map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    return new THREE.Mesh(geometry(new THREE.PlaneGeometry(width, height)), value);
  }

  let room;
  let roomResources = [];
  function rebuildRoom() {
    if (room) {
      scene.remove(room);
      for (const resource of roomResources) {
        resource.dispose(); materialPool.delete(resource); geometryPool.delete(resource); textures.delete(resource);
      }
    }
    const oldResources = new Set([...materialPool, ...geometryPool, ...textures]);
    room = new THREE.Group();
    scene.add(room);
    const floor = material({ color: 0x243e47, metalness: 0.08, roughness: 0.95 });
    box(room, floor, [roomWidth / 2, -0.13, roomDepth / 2], [roomWidth + 0.6, 0.25, roomDepth + 0.6]);
    const border = material({ color: 0x62808a, metalness: 0.2, roughness: 0.65 });
    box(room, border, [roomWidth / 2, 0.01, 0], [roomWidth, 0.025, 0.045], false);
    box(room, border, [roomWidth / 2, 0.01, roomDepth], [roomWidth, 0.025, 0.045], false);
    box(room, border, [0, 0.01, roomDepth / 2], [0.045, 0.025, roomDepth], false);
    box(room, border, [roomWidth, 0.01, roomDepth / 2], [0.045, 0.025, roomDepth], false);
    const linePositions = [];
    for (let x = 1; x < roomWidth; x++) linePositions.push(x, 0.012, 0, x, 0.012, roomDepth);
    for (let z = 1; z < roomDepth; z++) linePositions.push(0, 0.012, z, roomWidth, 0.012, z);
    const gridGeometry = geometry(new THREE.BufferGeometry());
    gridGeometry.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
    const gridMaterial = new THREE.LineBasicMaterial({ color: 0x55717a, transparent: true, opacity: 0.24 });
    materialPool.add(gridMaterial);
    room.add(new THREE.LineSegments(gridGeometry, gridMaterial));

    // Low back walls preserve the useful overview from every orbit angle.
    box(room, material({ color: 0x334e57, roughness: 0.8 }), [roomWidth / 2, 0.18, -0.2], [roomWidth + 0.6, 0.36, 0.14]);
    box(room, border, [roomWidth / 2, 0.37, -0.2], [roomWidth + 0.6, 0.04, 0.16]);
    const title = textPlaque('Q U I C K P R I N T   /   V I R T U A L   F A R M', Math.min(8, roomWidth * 0.7), 0.7, '#7c9da5');
    title.rotation.x = -Math.PI / 2;
    title.position.set(roomWidth / 2, 0.025, roomDepth - 0.55);
    room.add(title);
    for (let x = 1; x < roomWidth; x += 2) {
      const tick = textPlaque(`${x}m`, 0.55, 0.13, '#77969e');
      tick.rotation.x = -Math.PI / 2;
      tick.position.set(x, 0.025, 0.3);
      room.add(tick);
    }
    keyLight.position.set(roomWidth * 0.25, Math.max(roomWidth, roomDepth), roomDepth * 0.7);
    keyLight.target.position.set(roomWidth / 2, 0, roomDepth / 2);
    const shadowSize = Math.max(roomWidth, roomDepth) * 0.75;
    Object.assign(keyLight.shadow.camera, { left: -shadowSize, right: shadowSize, top: shadowSize, bottom: -shadowSize });
    keyLight.shadow.camera.updateProjectionMatrix();
    controls.maxDistance = Math.max(roomWidth, roomDepth) * 3.5;
    camera.far = Math.max(180, controls.maxDistance * 3);
    camera.updateProjectionMatrix();
    scene.fog.near = Math.max(roomWidth, roomDepth) * 2.5;
    scene.fog.far = Math.max(roomWidth, roomDepth) * 7;
    roomResources = [...materialPool, ...geometryPool, ...textures].filter(value => !oldResources.has(value));
  }

  const printGeometries = (() => {
    const vase = geometry(new THREE.LatheGeometry([
      new THREE.Vector2(0.13, 0), new THREE.Vector2(0.18, 0.02), new THREE.Vector2(0.13, 0.13),
      new THREE.Vector2(0.19, 0.27), new THREE.Vector2(0.15, 0.39), new THREE.Vector2(0.12, 0.4),
      new THREE.Vector2(0.12, 0.37), new THREE.Vector2(0.16, 0.27), new THREE.Vector2(0.1, 0.13),
      new THREE.Vector2(0.1, 0.035), new THREE.Vector2(0, 0.035),
    ], 16));
    const bracket = new THREE.Shape();
    bracket.moveTo(-0.2, 0); bracket.lineTo(0.2, 0); bracket.lineTo(0.2, 0.08); bracket.lineTo(-0.1, 0.08); bracket.lineTo(-0.1, 0.39); bracket.lineTo(-0.2, 0.39); bracket.closePath();
    const bracketGeometry = geometry(new THREE.ExtrudeGeometry(bracket, { depth: 0.3, bevelEnabled: true, bevelSegments: 1, steps: 1, bevelSize: 0.008, bevelThickness: 0.008 }));
    bracketGeometry.translate(0, 0, -0.15);
    const tower = geometry(new THREE.CylinderGeometry(0.16, 0.22, 0.4, 6));
    tower.translate(0, 0.2, 0);
    return [vase, bracketGeometry, tower];
  })();

  function createPrinter(config) {
    const group = new THREE.Group();
    scene.add(group);
    const resources = [];
    const ownedMaterial = options => { const value = material(options); resources.push(value); return value; };
    const accent = ownedMaterial({ color: STATE.idle.color, emissive: STATE.idle.color, emissiveIntensity: 0.3, roughness: 0.35 });
    const partMaterial = ownedMaterial({ color: 0x62cfb4, roughness: 0.55, metalness: 0.04 });
    const zoneMaterial = ownedMaterial({ color: ZONE_COLORS[hash(config.zone) % ZONE_COLORS.length], transparent: true, opacity: 0.12, depthWrite: false, roughness: 1 });
    const zone = box(group, zoneMaterial, [0, 0.015, 0], [1.65, 0.012, 1.75], false);
    for (const x of [-0.44, 0.44]) for (const z of [-0.42, 0.42]) box(group, dark, [x, 0.095, z], [0.15, 0.18, 0.15]);
    box(group, steel, [0, 0.22, 0], [1.08, 0.24, 1.03]);
    box(group, frameMaterial, [0, 0.35, 0], [1.1, 0.06, 1.06]);
    for (const x of [-0.49, 0.49]) for (const z of [-0.47, 0.47]) box(group, frameMaterial, [x, 0.92, z], [0.065, 1.12, 0.065]);
    box(group, frameMaterial, [0, 1.48, 0], [1.1, 0.09, 1.06]);
    box(group, dark, [0, 1.535, 0], [0.94, 0.028, 0.88]);
    box(group, glass, [-0.5, 0.91, 0], [0.018, 1.04, 0.88], false);
    box(group, glass, [0.5, 0.91, 0], [0.018, 1.04, 0.88], false);
    box(group, glass, [0, 0.91, -0.48], [0.93, 1.04, 0.018], false);
    box(group, bedMaterial, [0, 0.43, 0], [0.79, 0.045, 0.75]);
    box(group, dark, [0, 0.46, 0], [0.75, 0.012, 0.71]);
    const gantry = new THREE.Group();
    gantry.position.y = 1.14;
    group.add(gantry);
    box(gantry, steel, [0, 0, 0], [0.9, 0.055, 0.065]);
    const head = new THREE.Group();
    gantry.add(head);
    box(head, dark, [0, -0.025, 0], [0.17, 0.2, 0.14]);
    box(head, frameMaterial, [0, -0.04, 0.075], [0.13, 0.12, 0.018]);
    cylinder(head, robotMaterial, [0, -0.15, 0], [0.025, 0.065, 0.025]);
    for (const x of [-0.39, 0.39]) box(group, steel, [x, 1.16, 0], [0.025, 0.025, 0.88]);
    const spool = new THREE.Group();
    spool.position.set(0.34, 1.67, -0.12);
    spool.rotation.z = Math.PI / 2;
    group.add(spool);
    cylinder(spool, partMaterial, [0, 0, 0], [0.15, 0.13, 0.15]);
    cylinder(spool, steel, [0, -0.08, 0], [0.18, 0.025, 0.18]);
    cylinder(spool, steel, [0, 0.08, 0], [0.18, 0.025, 0.18]);
    const strip = box(group, accent, [0, 1.405, 0.505], [0.8, 0.02, 0.025], false);
    box(group, dark, [0.3, 0.235, 0.522], [0.23, 0.13, 0.025]);
    box(group, accent, [0.3, 0.24, 0.538], [0.18, 0.085, 0.006], false);
    const part = mesh(group, printGeometries[0], partMaterial, [0, 0.472, 0]);
    part.visible = false;
    const selection = mesh(group, ringGeometry, ownedMaterial({ color: 0x8ae9cf, emissive: 0x8ae9cf, emissiveIntensity: 0.6 }), [0, 0.055, 0], null, false);
    selection.rotation.x = -Math.PI / 2;
    selection.visible = false;
    const ejector = box(group, robotMaterial, [0, 0.55, -0.34], [0.66, 0.1, 0.04]);
    ejector.visible = false;
    const bin = new THREE.Group();
    bin.position.set(0, 0, 0.92);
    group.add(bin);
    box(bin, steel, [0, 0.08, 0], [0.68, 0.12, 0.47]);
    box(bin, frameMaterial, [-0.32, 0.17, 0], [0.04, 0.16, 0.47]);
    box(bin, frameMaterial, [0.32, 0.17, 0], [0.04, 0.16, 0.47]);
    box(bin, frameMaterial, [0, 0.17, 0.22], [0.68, 0.16, 0.035]);
    const pick = mesh(group, boxGeometry, pickMaterial, [0, 0.9, 0], [1.15, 1.8, 1.2], false);
    pick.userData = { id: config.id, kind: 'printer' };
    pickTargets.push(pick);
    const label = createLabel('printer');
    const routeGeometry = geometry(new THREE.BufferGeometry());
    resources.push(routeGeometry);
    const routeMaterial = new THREE.LineDashedMaterial({ color: 0x63baa8, dashSize: 0.1, gapSize: 0.15, opacity: 0.3, transparent: true });
    materialPool.add(routeMaterial); resources.push(routeMaterial);
    const route = new THREE.Line(routeGeometry, routeMaterial);
    route.visible = false;
    scene.add(route);
    const packet = mesh(scene, sphereGeometry, accent, [0, 0.15, 0], [0.045, 0.045, 0.045], false);
    packet.visible = false;
    const value = { id: config.id, kind: 'printer', group, config, state: null, part, partMaterial, gantry, head, spool, strip, selection, zone, zoneMaterial, ejector, bin, pick, label, accent, route, routeGeometry, packet, resources, routeKey: '', routeCurve: null };
    printers.set(config.id, value);
    return value;
  }

  function createClearer(config) {
    const group = new THREE.Group();
    scene.add(group);
    cylinder(group, steel, [0, 0.1, 0], [0.32, 0.2, 0.32]);
    cylinder(group, robotMaterial, [0, 0.28, 0], [0.21, 0.24, 0.21]);
    const lower = cylinder(group, robotMaterial, null, [0.105, 1, 0.105]);
    const upper = cylinder(group, frameMaterial, null, [0.085, 1, 0.085]);
    const elbow = mesh(group, sphereGeometry, steel, null, [0.16, 0.16, 0.16]);
    const hand = new THREE.Group();
    group.add(hand);
    cylinder(hand, steel, [0, 0, 0], [0.1, 0.1, 0.1]);
    box(hand, dark, [-0.08, -0.11, 0], [0.035, 0.15, 0.1]);
    box(hand, dark, [0.08, -0.11, 0], [0.035, 0.15, 0.1]);
    const selectionMaterial = material({ color: 0xe5b46d, emissive: 0xe5b46d, emissiveIntensity: 0.3 });
    const selection = mesh(group, ringGeometry, selectionMaterial, [0, 0.04, 0], [0.85, 0.85, 0.85], false);
    selection.rotation.x = -Math.PI / 2;
    const pick = mesh(group, boxGeometry, pickMaterial, [0, 0.85, 0], [1.1, 1.7, 1.1], false);
    pick.userData = { id: config.id, kind: 'clearer' };
    pickTargets.push(pick);
    const label = createLabel('clearer');
    const value = { id: config.id, kind: 'clearer', group, config, state: null, lower, upper, elbow, hand, selection, pick, label, resources: [selectionMaterial] };
    clearers.set(config.id, value);
    return value;
  }

  function removeObject(value) {
    scene.remove(value.group);
    if (value.route) scene.remove(value.route, value.packet);
    value.label.root.remove();
    const index = pickTargets.indexOf(value.pick);
    if (index !== -1) pickTargets.splice(index, 1);
    for (const resource of value.resources) {
      resource.dispose(); materialPool.delete(resource); geometryPool.delete(resource);
    }
  }

  function positionObject(value, config) {
    if (drag?.value !== value) value.group.position.set(number(config.position?.x), 0, number(config.position?.z));
    value.group.rotation.y = THREE.MathUtils.degToRad(number(config.rotation));
    value.config = config;
  }

  function updateLabel(value) {
    const selected = value.id === selectedId && value.kind === selectedKind;
    const state = value.state || {};
    const status = value.kind === 'clearer'
      ? state.state === 'clearing' ? { color: 0xb49aff, text: 'Robot clearing' } : { color: 0xe5b46d, text: 'Robot ready' }
      : STATE[state.state] || STATE.idle;
    value.label.name.textContent = value.config.name || value.id;
    value.label.text.textContent = state.state === 'printing' ? `Printing · ${Math.round(number(state.progress))}%` : status.text;
    if (state.state === 'blocked' && String(state.blockedReason || '').includes('manual')) value.label.text.textContent = 'Awaiting operator';
    value.label.dot.style.background = cssColor(status.color);
    value.label.status.style.color = cssColor(status.color);
    value.label.root.style.borderColor = selected ? '#91e8d1' : '#89adb740';
    value.label.root.style.borderLeftColor = cssColor(status.color);
    value.label.root.style.borderLeftWidth = '2px';
    value.label.root.style.background = selected ? 'rgba(23,61,67,.97)' : 'rgba(16,35,44,.9)';
    value.label.root.style.zIndex = selected ? '3' : '1';
    value.label.track.style.display = state.state === 'printing' ? 'block' : 'none';
    value.label.bar.style.width = `${clamp(number(state.progress), 0, 100)}%`;
    value.selection.visible = selected || value.kind === 'clearer';
    if (value.kind === 'clearer') value.selection.material.emissiveIntensity = selected ? 0.8 : 0.15;
  }

  function update(next, options = {}) {
    if (disposed) return;
    const hadObjects = printers.size + clearers.size > 0;
    snapshot = next;
    if ('editing' in options) setEditable(Boolean(options.editing));
    if ('selectedClearerId' in options || 'selectedPrinterId' in options) {
      selectedId = options.selectedPrinterId || options.selectedClearerId || null;
      selectedKind = options.selectedPrinterId ? 'printer' : 'clearer';
    }
    // The UI polls paused workspaces too. Identical snapshots must not create
    // graphics work just because a network response arrived.
    const nextSnapshotKey = JSON.stringify([next?.scenario, next?.printers, next?.clearers, next?.timeMinutes, next?.running, selectedId, selectedKind, editing]);
    if (nextSnapshotKey === snapshotKey) return;
    snapshotKey = nextSnapshotKey;
    applyingSnapshot = true;
    needsShadowRender = true;
    const scenario = next?.scenario || {};
    roomWidth = Math.max(3, number(scenario.room?.width, 16));
    roomDepth = Math.max(3, number(scenario.room?.depth, 12));
    const nextRoomKey = `${roomWidth}:${roomDepth}`;
    if (nextRoomKey !== roomKey) {
      roomKey = nextRoomKey;
      rebuildRoom();
      resetCamera();
    }
    const configuredPrinters = scenario.printers || next?.printers || [];
    const configuredClearers = scenario.clearers || next?.clearers || [];
    const printerStates = new Map((next?.printers || []).map(value => [value.id, value]));
    const clearerStates = new Map((next?.clearers || []).map(value => [value.id, value]));
    const ids = new Set(configuredPrinters.map(value => value.id));
    const clearerIds = new Set(configuredClearers.map(value => value.id));
    for (const [id, value] of printers) if (!ids.has(id)) { removeObject(value); printers.delete(id); }
    for (const [id, value] of clearers) if (!clearerIds.has(id)) { removeObject(value); clearers.delete(id); }
    for (const config of configuredPrinters) {
      const value = printers.get(config.id) || createPrinter(config);
      positionObject(value, config);
      value.state = printerStates.get(config.id) || { state: config.enabled === false ? 'offline' : 'idle', progress: 0 };
      const status = STATE[value.state.state] || STATE.idle;
      value.accent.color.setHex(status.color);
      value.accent.emissive.setHex(status.color);
      value.zoneMaterial.color.setHex(ZONE_COLORS[hash(config.zone) % ZONE_COLORS.length]);
      const job = (next?.jobs || scenario.jobs || []).find(item => item.id === value.state.currentJobId);
      value.part.geometry = printGeometries[hash(value.state.currentJobId || config.id) % printGeometries.length];
      value.partMaterial.color.setHex(ZONE_COLORS[hash(job?.material || config.materials?.[0]) % ZONE_COLORS.length]);
      value.partMaterial.emissive.setHex(value.state.state === 'cooling' ? 0x214565 : 0x000000);
      value.partMaterial.emissiveIntensity = 0.3;
      value.bin.visible = config.clearing?.mode !== 'manual';
      value.ejector.visible = value.state.state === 'clearing' && config.clearing?.mode === 'automatic';
      updateLabel(value);
      const routeKey = `${value.group.position.x}:${value.group.position.z}:${roomWidth}:${roomDepth}`;
      if (routeKey !== value.routeKey) {
        value.routeKey = routeKey;
        const end = value.group.position.clone(); end.y = 0.045;
        value.routeCurve = new THREE.QuadraticBezierCurve3(
          new THREE.Vector3(roomWidth / 2, 0.045, roomDepth - 1.1),
          new THREE.Vector3(end.x, 0.045, roomDepth - 1.1), end,
        );
        value.routeGeometry.setFromPoints(value.routeCurve.getPoints(28));
        value.routeGeometry.computeBoundingSphere();
        value.route.computeLineDistances();
      }
    }
    for (const config of configuredClearers) {
      const value = clearers.get(config.id) || createClearer(config);
      positionObject(value, config);
      value.state = clearerStates.get(config.id) || { state: 'idle' };
      updateLabel(value);
    }
    if (!hadObjects && printers.size + clearers.size > 0) resetCamera();
    canvas.setAttribute('aria-label', `Interactive 3D farm with ${printers.size} printers and ${clearers.size} clearing robots. ${editing ? 'Layout editing enabled; select an object and use arrow keys to move by half a meter.' : 'Drag to orbit, scroll to zoom, or use the accessible fleet list.'}`);
    container.dataset.sceneReady = 'true';
    applyingSnapshot = false;
    draw(performance.now(), true);
  }

  function updateAnimations(now) {
    if (lastAnimationTick && snapshot?.running !== false && !editing) animationSeconds += Math.min(0.2, (now - lastAnimationTick) / 1000);
    lastAnimationTick = now;
    const t = reducedMotion ? 0 : animationSeconds;
    const time = number(snapshot?.timeMinutes);
    for (const value of printers.values()) {
      const state = value.state || {};
      const printing = state.state === 'printing';
      const clearing = state.state === 'clearing';
      const progress = clamp(number(state.progress) / 100, 0, 1);
      value.part.visible = Boolean(printing || state.bedDirty || ['cooling', 'waiting_clear', 'clearing', 'blocked'].includes(state.state));
      value.part.scale.y = printing ? Math.max(0.02, progress) : 1;
      value.part.position.set(0, 0.472, 0);
      if (printing) {
        const phase = hash(value.id) * 0.1;
        value.gantry.position.z = Math.sin(t * 1.4 + phase) * 0.22;
        value.gantry.position.y = 0.68 + progress * 0.4;
        value.head.position.x = Math.sin(t * 3.2 + phase) * 0.23;
        value.spool.rotation.y = t * 0.18;
      } else {
        value.gantry.position.set(0, 1.14, -0.24);
        value.head.position.x = 0.26;
      }
      if (clearing) {
        const duration = number(state.phaseEndMinutes) - number(state.phaseStartedMinutes);
        const phase = duration > 0 ? clamp((time - number(state.phaseStartedMinutes)) / duration, 0, 1) : 0.5;
        const eject = clamp((phase - 0.18) / 0.6, 0, 1);
        value.part.position.z = eject * 0.96;
        value.part.position.y = 0.472 - clamp((eject - 0.65) / 0.35, 0, 1) * 0.26;
        value.part.rotation.x = -clamp((eject - 0.6) / 0.4, 0, 1) * 0.25;
        value.ejector.position.z = -0.34 + eject * 0.8;
      } else value.part.rotation.x = 0;
      value.accent.emissiveIntensity = printing && !reducedMotion ? 0.4 + Math.sin(t * 2) * 0.12 : 0.3;
      const routeVisible = printing && !editing && (!selectedId || selectedId === value.id);
      value.route.visible = routeVisible;
      value.packet.visible = routeVisible && !reducedMotion;
      if (value.packet.visible && value.routeCurve) value.packet.position.copy(value.routeCurve.getPoint((t * 0.13 + (hash(value.id) % 20) / 20) % 1));
    }
    for (const value of clearers.values()) {
      const assigned = value.state?.state === 'clearing' && printers.get(value.state.printerId);
      const start = new THREE.Vector3(0, 0.44, 0);
      const target = assigned
        ? new THREE.Vector3(assigned.group.position.x - value.group.position.x, 0.86 + Math.sin(t * 1.8) * 0.06, assigned.group.position.z - value.group.position.z + 0.2)
        : new THREE.Vector3(0.65, 0.83, 0.2);
      const middle = new THREE.Vector3(target.x * 0.42, 1.58 + Math.min(0.7, target.length() * 0.09), target.z * 0.42);
      positionLink(value.lower, start, middle);
      positionLink(value.upper, middle, target);
      value.elbow.position.copy(middle);
      value.hand.position.copy(target);
      value.hand.rotation.y = Math.atan2(target.x, target.z);
    }
  }

  function positionLink(link, from, to) {
    scratch.copy(to).sub(from);
    link.position.copy(from).addScaledVector(scratch, 0.5);
    link.scale.y = scratch.length();
    link.quaternion.setFromUnitVectors(up, scratch.normalize());
  }

  function updateLabels() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const cameraDirection = camera.getWorldDirection(scratch).clone();
    const candidates = [];
    for (const value of [...printers.values(), ...clearers.values()]) {
      projected.copy(value.group.position);
      projected.y = value.kind === 'printer' ? 1.95 : 1.95;
      const inFront = projected.clone().sub(camera.position).dot(cameraDirection) > 0;
      const distance = camera.position.distanceTo(projected);
      projected.project(camera);
      const x = (projected.x * 0.5 + 0.5) * width;
      const y = (-projected.y * 0.5 + 0.5) * height;
      const visible = inFront && projected.z < 1 && x > 15 && x < width - 15 && y > 20 && y < height - 20;
      const selected = value.id === selectedId && value.kind === selectedKind;
      candidates.push({ value, visible, selected, x, y, distance });
    }
    // Prioritize the selected machine, then nearby labels. Distant crowded
    // labels disappear rather than obscuring the model or adjacent labels.
    candidates.sort((a, b) => Number(b.selected) - Number(a.selected) || a.distance - b.distance);
    const occupied = [];
    for (const item of candidates) {
      const { value, selected, x } = item;
      let y = item.y;
      const compact = (printers.size + clearers.size > 18 || item.distance > 13) && !selected;
      const labelWidth = compact ? clamp(value.label.name.textContent.length * 5.5 + 20, 82, 125) : 110;
      const labelHeight = compact ? 25 : 42;
      const collides = () => occupied.some(other => Math.abs(other.x - x) < (other.width + labelWidth) / 2 && Math.abs(other.y - y) < labelHeight);
      if (item.visible) {
        for (let attempt = 0; attempt < (compact ? 1 : 2) && collides() && y > labelHeight * 2; attempt++) y -= labelHeight + 4;
      }
      const collision = collides();
      const visible = item.visible && (!collision || selected);
      value.label.root.style.display = visible ? 'block' : 'none';
      if (!visible) continue;
      value.label.root.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -100%)`;
      value.label.root.style.maxWidth = compact ? '125px' : '145px';
      value.label.root.style.padding = compact ? '5px 7px' : '6px 9px';
      value.label.status.style.display = compact ? 'none' : 'flex';
      value.label.track.style.display = !compact && value.state?.state === 'printing' ? 'block' : 'none';
      occupied.push({ x, y, width: labelWidth });
    }
  }

  function draw(now, force = false) {
    if (force) needsRender = true;
    if (disposed || contextLost || !container.isConnected || !container.clientWidth || !container.clientHeight) return;
    if (applyingSnapshot || !needsRender) return;
    if (!force && now - lastDraw < (reducedMotion ? 100 : 1000 / targetFps)) return;
    lastDraw = now;
    controls.update();
    controls.target.x = clamp(controls.target.x, -roomWidth * 0.2, roomWidth * 1.2);
    controls.target.z = clamp(controls.target.z, -roomDepth * 0.2, roomDepth * 1.2);
    controls.target.y = clamp(controls.target.y, 0, 2.5);
    updateAnimations(now);
    renderer.shadowMap.needsUpdate = needsShadowRender;
    if (needsShadowRender) lastShadowDraw = now;
    renderer.render(scene, camera);
    updateLabels();
    frame++;
    needsRender = false;
    needsShadowRender = false;
  }

  function animate(now) {
    if (disposed) return;
    animationId = requestAnimationFrame(animate);
    if (document.visibilityState === 'hidden' || contextLost) return;
    // OrbitControls emits change while damping settles, including when the
    // simulation is paused. Once settled, a paused view submits no GPU frames.
    controls.update();
    const animated = !reducedMotion && snapshot?.running !== false && !editing
      && [...printers.values()].some(value => ['printing', 'clearing'].includes(value.state?.state));
    if (animated) {
      needsRender = true;
      // Shadow maps are independent of the camera and can be reused during
      // orbiting. Animate moving-object shadows at no more than ten fps.
      if (now - lastShadowDraw >= 100) needsShadowRender = true;
    }
    draw(now);
  }

  function resize() {
    if (disposed) return;
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    draw(performance.now(), true);
  }

  function resetCamera() {
    if (disposed) return;
    const objects = [...printers.values(), ...clearers.values()];
    let centerX = roomWidth / 2;
    let centerZ = roomDepth / 2;
    let radius = Math.max(roomWidth, roomDepth);
    if (objects.length) {
      const xs = objects.map(value => value.group.position.x);
      const zs = objects.map(value => value.group.position.z);
      centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
      centerZ = (Math.min(...zs) + Math.max(...zs)) / 2;
      radius = Math.max(6, Math.max(...xs) - Math.min(...xs) + 4, Math.max(...zs) - Math.min(...zs) + 4);
    }
    const narrow = camera.aspect < 1.15 ? 1.25 : 1;
    cameraTarget.set(centerX, 0.45, centerZ);
    controls.target.copy(cameraTarget);
    if (view === 'top') camera.position.set(centerX, radius * 1.55 * narrow, centerZ + 0.01);
    else camera.position.set(centerX + radius * 0.77 * narrow, radius * 0.92 * narrow, centerZ + radius * 0.92 * narrow);
    camera.lookAt(cameraTarget);
    controls.update();
    controls.saveState();
    draw(performance.now(), true);
  }

  function setView(nextView) {
    view = nextView === 'top' ? 'top' : 'perspective';
    resetCamera();
  }

  function focus(id) {
    const value = printers.get(id) || clearers.get(id);
    if (!value || disposed) return;
    const offset = camera.position.clone().sub(controls.target).normalize().multiplyScalar(view === 'top' ? 5 : 5.8);
    controls.target.copy(value.group.position).add(new THREE.Vector3(0, 0.65, 0));
    camera.position.copy(controls.target).add(offset);
    controls.update();
    draw(performance.now(), true);
  }

  function select(id, kind = 'printer') {
    selectedId = id;
    selectedKind = kind;
    for (const value of [...printers.values(), ...clearers.values()]) updateLabel(value);
    draw(performance.now(), true);
  }

  function setEditable(value) {
    if (editing !== Boolean(value)) needsRender = true;
    editing = Boolean(value);
    if (!editing && drag) cancelDrag();
    canvas.style.cursor = editing ? 'grab' : 'default';
    hint.textContent = editing
      ? 'Layout edit · Drag a machine or robot · Arrow keys move selection 0.5 m · Apply to reset the scenario'
      : 'Drag to orbit · Scroll to zoom · Click a printer to inspect';
  }

  function setRay(event) {
    const bounds = canvas.getBoundingClientRect();
    pointer.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
  }

  function objectAt(event) {
    setRay(event);
    const hit = raycaster.intersectObjects(pickTargets, false)[0];
    if (!hit) return null;
    const { id, kind } = hit.object.userData;
    return (kind === 'printer' ? printers : clearers).get(id) || null;
  }

  function onPointerDown(event) {
    if (event.button !== 0 || !event.isPrimary) return;
    pointerStart = { x: event.clientX, y: event.clientY };
    if (!editing) return;
    const value = objectAt(event);
    if (!value || !raycaster.ray.intersectPlane(floorPlane, scratch)) return;
    // Selection renders immediately and reuses scratch vectors. Preserve the
    // plane hit before callbacks/rendering so the object cannot jump on grab.
    const grabOffset = value.group.position.clone().sub(scratch);
    const original = value.group.position.clone();
    event.preventDefault();
    event.stopImmediatePropagation();
    select(value.id, value.kind);
    onSelect?.(value.id, value.kind);
    canvas.focus({ preventScroll: true });
    drag = { value, pointerId: event.pointerId, original, offset: grabOffset };
    controls.enabled = false;
    canvas.style.cursor = 'grabbing';
    canvas.setPointerCapture?.(event.pointerId);
  }

  function onPointerMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    setRay(event);
    if (!raycaster.ray.intersectPlane(floorPlane, scratch)) return;
    const edge = drag.value.kind === 'printer' ? 1 : 0.5;
    const x = clamp(Math.round((scratch.x + drag.offset.x) * 2) / 2, edge, Math.floor((roomWidth - edge) * 2) / 2);
    const z = clamp(Math.round((scratch.z + drag.offset.z) * 2) / 2, edge, Math.floor((roomDepth - edge) * 2) / 2);
    drag.value.group.position.set(x, 0, z);
    needsShadowRender = true;
    draw(performance.now(), true);
  }

  function cancelDrag() {
    if (!drag) return;
    drag.value.group.position.copy(drag.original);
    needsShadowRender = true;
    needsRender = true;
    if (canvas.hasPointerCapture?.(drag.pointerId)) canvas.releasePointerCapture(drag.pointerId);
    drag = null;
    controls.enabled = true;
    canvas.style.cursor = editing ? 'grab' : 'default';
  }

  function onPointerUp(event) {
    if (drag && event.pointerId === drag.pointerId) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const { value, original } = drag;
      const changed = value.group.position.distanceToSquared(original) > 0.001;
      const position = { x: value.group.position.x, z: value.group.position.z };
      if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      drag = null;
      controls.enabled = true;
      canvas.style.cursor = 'grab';
      pointerStart = null;
      if (changed) onMove?.(value.id, position, value.kind);
      return;
    }
    if (pointerStart && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) < 5) {
      const value = objectAt(event);
      if (value) { select(value.id, value.kind); onSelect?.(value.id, value.kind); }
    }
    pointerStart = null;
  }

  function onPointerCancel() { cancelDrag(); pointerStart = null; }
  function onKeyDown(event) {
    if (event.key === 'Escape') { cancelDrag(); return; }
    if (!editing || !selectedId || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const value = (selectedKind === 'printer' ? printers : clearers).get(selectedId);
    if (!value) return;
    event.preventDefault();
    const step = event.shiftKey ? 1 : 0.5;
    const edge = selectedKind === 'printer' ? 1 : 0.5;
    const x = clamp(Math.round((value.group.position.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0)) * 2) / 2, edge, Math.floor((roomWidth - edge) * 2) / 2);
    const z = clamp(Math.round((value.group.position.z + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0)) * 2) / 2, edge, Math.floor((roomDepth - edge) * 2) / 2);
    value.group.position.set(x, 0, z);
    needsShadowRender = true;
    onMove?.(value.id, { x, z }, value.kind);
    draw(performance.now(), true);
  }
  function onContextLost(event) {
    event.preventDefault(); contextLost = true;
    container.dataset.webgl = 'lost';
    onError?.('The 3D graphics context was lost. Farm controls and the simulation are still available.');
  }
  function onContextRestored() { contextLost = false; needsShadowRender = true; container.dataset.webgl = 'available'; resize(); }
  function onMotionPreference(event) { reducedMotion = event.matches; needsRender = true; }

  // Capture before OrbitControls so object dragging does not also orbit.
  canvas.addEventListener('pointerdown', onPointerDown, true);
  canvas.addEventListener('pointermove', onPointerMove, true);
  canvas.addEventListener('pointerup', onPointerUp, true);
  canvas.addEventListener('pointercancel', onPointerCancel, true);
  canvas.addEventListener('keydown', onKeyDown);
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);
  motionPreference?.addEventListener?.('change', onMotionPreference);
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  observer?.observe(container);
  window.addEventListener('resize', resize);
  resize();
  update({ scenario: { room: { width: roomWidth, depth: roomDepth }, printers: [], clearers: [] }, printers: [], clearers: [], jobs: [] });
  animationId = requestAnimationFrame(animate);

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(animationId);
    cancelDrag();
    observer?.disconnect();
    window.removeEventListener('resize', resize);
    motionPreference?.removeEventListener?.('change', onMotionPreference);
    canvas.removeEventListener('pointerdown', onPointerDown, true);
    canvas.removeEventListener('pointermove', onPointerMove, true);
    canvas.removeEventListener('pointerup', onPointerUp, true);
    canvas.removeEventListener('pointercancel', onPointerCancel, true);
    canvas.removeEventListener('keydown', onKeyDown);
    canvas.removeEventListener('webglcontextlost', onContextLost);
    canvas.removeEventListener('webglcontextrestored', onContextRestored);
    controls.removeEventListener('change', onControlsChange);
    controls.dispose();
    for (const texture of textures) texture.dispose();
    for (const value of geometryPool) value.dispose();
    for (const value of materialPool) value.dispose();
    scene.clear();
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove(); labels.remove(); hint.remove();
    delete container.dataset.webgl;
    delete container.dataset.sceneReady;
  }

  return {
    update, setView, focus, resize, select, setEditable, resetCamera, dispose,
    getDiagnostics: () => ({ available: !contextLost && !disposed, frames: frame, printers: printers.size, clearers: clearers.size, drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, editing, selectedId, view, reducedMotion, qualityProfile: softwareRenderer ? 'software' : 'standard', targetFps, pixelRatio: renderer.getPixelRatio(), renderOnDemand: true }),
  };
}
