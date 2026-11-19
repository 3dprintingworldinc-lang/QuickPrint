'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const AdmZip = require('adm-zip');
const { startServer } = require('../src/server');
const { LayrOAuth } = require('../src/connectors/layr-oauth');

const PORTAL = 'https://printbylayr.example';
const CLIENT = `pbl_${'c'.repeat(22)}`;
const CODE = 'a'.repeat(43);
const TOKEN = 't'.repeat(43);
const REFRESH = 'r'.repeat(43);

function barrier() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

async function setup(t, { beforeComplete } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-layr-api-'));
  const oauthCalls = [], completeCalls = [], listCalls = [];
  const oauth = new LayrOAuth({ fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    oauthCalls.push({ url, init, body });
    if (url.endsWith('/oauth/register')) return Response.json({ client_id: CLIENT, redirect_uris: body.redirect_uris, token_endpoint_auth_method: 'none' }, { status: 201 });
    return Response.json({ access_token: TOKEN, token_type: 'Bearer', expires_in: 3600, refresh_token: REFRESH, scope: 'studio' });
  } });
  const complete = oauth.complete.bind(oauth);
  oauth.complete = async args => {
    completeCalls.push(args);
    await beforeComplete?.(args);
    return complete(args);
  };
  const layrClient = {
    listPreparationJobs: async config => { listCalls.push(config); return []; },
    downloadModel: async () => { throw new Error('No model should be downloaded in OAuth tests.'); },
    ticketFingerprint: () => { throw new Error('No ticket should be imported in OAuth tests.'); },
  };
  const app = await startServer({ dataDir, port: 0, layrOAuth: oauth, layrClient });
  const restarted = [];
  t.after(async () => {
    await app.close();
    for (const instance of restarted) await instance.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const request = (pathname, options = {}) => fetch(app.url + pathname, { ...options, headers: { Authorization: `Bearer ${app.token}`, ...options.headers } });
  const json = (pathname, body, method = 'POST') => request(pathname, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const begin = async (body = { portalUrl: PORTAL }) => {
    const response = await json('/api/integrations/layr/connect', body);
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    return { ...result, state: new URL(result.authorizationUrl).searchParams.get('state') };
  };
  const callbackUrl = (state, extra = {}) => {
    const url = new URL('/integrations/layr/callback', app.url);
    for (const [key, value] of Object.entries({ state, code: CODE, iss: PORTAL, ...extra })) if (value !== undefined) url.searchParams.set(key, value);
    return url.href;
  };
  const state = async () => (await (await request('/api/state')).json());
  return { ...app, dataDir, request, json, begin, callbackUrl, state, oauthCalls, completeCalls, listCalls, oauth, layrClient, restarted };
}

test('Layr connection API requires the local administration token and binds a loopback callback', async t => {
  const app = await setup(t);
  const response = await fetch(app.url + '/api/integrations/layr/connect', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ portalUrl: PORTAL }),
  });
  assert.equal(response.status, 401);
  assert.equal(app.oauthCalls.length, 0);
  const started = await app.begin();
  const authorization = new URL(started.authorizationUrl);
  assert.equal(authorization.origin, PORTAL);
  assert.equal(authorization.pathname, '/oauth/authorize');
  assert.equal(authorization.searchParams.get('redirect_uri'), `${app.url}/integrations/layr/callback`);
  assert.equal(authorization.searchParams.get('resource'), `${PORTAL}/mcp`);
  assert.equal(authorization.searchParams.get('scope'), 'studio');
  assert.equal(app.isLayrAuthorizationUrl(started.authorizationUrl), true);
  assert.equal(app.isLayrAuthorizationUrl(`${started.authorizationUrl}&extra=1`), false);
  assert.deepEqual((await app.state()).connectors, []);
});

test('Layr OAuth callback saves encrypted credentials, redacts public state and rejects replay', async t => {
  const app = await setup(t);
  const started = await app.begin();
  // The OAuth state authenticates this callback; browser navigation cannot carry
  // the renderer's local administration bearer token.
  const response = await fetch(app.callbackUrl(started.state));
  assert.equal(response.status, 200, await response.clone().text());
  const html = await response.text();
  assert.match(response.headers.get('content-type'), /^text\/html/);
  assert.match(html, /PrintByLayr connected/);
  assert.equal(html.includes(TOKEN), false);
  assert.equal(html.includes(REFRESH), false);
  assert.equal(app.completeCalls[0].redirectUri, `${app.url}/integrations/layr/callback`);
  assert.equal(app.completeCalls[0].issuer, PORTAL);
  const exchange = app.oauthCalls.find(call => call.url.endsWith('/oauth/token'));
  assert.equal(exchange.body.redirect_uri, `${app.url}/integrations/layr/callback`);
  assert.equal(createHash('sha256').update(exchange.body.code_verifier).digest('base64url'), new URL(started.authorizationUrl).searchParams.get('code_challenge'));
  const state = await app.state();
  assert.equal(state.connectors.length, 1);
  const connector = state.connectors[0];
  assert.equal(connector.type, 'layr');
  assert.equal(connector.portalUrl, PORTAL);
  assert.equal(connector.clientId, CLIENT);
  assert.equal(connector.hasToken, true);
  assert.equal(connector.hasRefreshToken, true);
  assert.equal(connector.token, undefined);
  assert.equal(connector.refreshToken, undefined);
  assert.equal(JSON.stringify(state).includes(TOKEN), false);
  assert.equal(JSON.stringify(state).includes(REFRESH), false);
  const diskText = await fs.readFile(path.join(app.dataDir, 'state.json'), 'utf8');
  const disk = JSON.parse(diskText).connectors[0];
  assert.equal(disk.token.protected, true);
  assert.equal(disk.refreshToken.protected, true);
  assert.equal(typeof disk.token.value, 'string');
  assert.equal(typeof disk.refreshToken.value, 'string');
  assert.equal(diskText.includes(TOKEN), false);
  assert.equal(diskText.includes(REFRESH), false);
  const privateConnector = app.service.getConnectors({ secrets: true })[0];
  assert.equal(privateConnector.token, TOKEN);
  assert.equal(privateConnector.refreshToken, REFRESH);
  assert.equal(app.isLayrAuthorizationUrl(started.authorizationUrl), false);
  assert.equal((await fetch(app.callbackUrl(started.state))).status, 400);
  assert.equal(app.completeCalls.length, 1);
});

test('Layr callback refuses unknown, denied, expired and issuer-mismatched sign-ins', async t => {
  const app = await setup(t);
  assert.equal((await fetch(app.callbackUrl('unknown'))).status, 400);
  const denied = await app.begin();
  const denial = await fetch(app.callbackUrl(denied.state, { error: 'access_denied', code: undefined }));
  assert.equal(denial.status, 400);
  assert.equal((await denial.json()).error, 'OAUTH_DENIED');
  assert.equal((await fetch(app.callbackUrl(denied.state))).status, 400);
  assert.equal(app.completeCalls.length, 0);
  const wrongIssuer = await app.begin();
  assert.equal((await fetch(app.callbackUrl(wrongIssuer.state, { iss: 'https://attacker.example' }))).status, 400);
  assert.equal((await app.state()).connectors.length, 0);
  const expired = await app.begin();
  const current = Date.now();
  const mock = t.mock.method(Date, 'now', () => current + 10 * 60000 + 1);
  try { assert.equal((await fetch(app.callbackUrl(expired.state))).status, 400); }
  finally { mock.mock.restore(); }
  assert.equal((await app.state()).connectors.length, 0);
});

test('Layr reconnect targets an existing Layr input and cannot resurrect a removed input', async t => {
  const app = await setup(t);
  const missing = await app.json('/api/integrations/layr/connect', { id: 'missing', portalUrl: PORTAL });
  assert.equal(missing.status, 404);
  const folder = await app.service.saveConnector({ type: 'folder', name: 'Folder', path: app.dataDir, enabled: false });
  assert.equal((await app.json('/api/integrations/layr/connect', { id: folder.id, portalUrl: PORTAL })).status, 404);
  assert.equal(app.oauthCalls.length, 0);
  const first = await app.begin();
  assert.equal((await fetch(app.callbackUrl(first.state))).status, 200);
  const input = (await app.state()).connectors.find(item => item.type === 'layr');
  const reconnect = await app.begin({ id: input.id, portalUrl: 'https://ignored.example' });
  assert.equal(new URL(reconnect.authorizationUrl).origin, PORTAL);
  assert.equal((await app.request(`/api/connectors/${input.id}`, { method: 'DELETE' })).status, 200);
  const response = await fetch(app.callbackUrl(reconnect.state));
  assert.equal(response.status, 409, await response.clone().text());
  assert.equal((await app.state()).connectors.filter(item => item.type === 'layr').length, 0);
});

test('Layr callback does not overwrite an input whose portal changed during sign-in', async t => {
  const app = await setup(t);
  const first = await app.begin();
  assert.equal((await fetch(app.callbackUrl(first.state))).status, 200);
  const input = (await app.state()).connectors[0];
  const reconnect = await app.begin({ id: input.id });
  await app.service.saveConnector({ id: input.id, portalUrl: 'https://new-portal.example' });
  const response = await fetch(app.callbackUrl(reconnect.state));
  assert.equal(response.status, 409, await response.clone().text());
  assert.equal((await app.state()).connectors[0].portalUrl, 'https://new-portal.example');
});

test('Layr pending callbacks are invalid after a server restart', async t => {
  const app = await setup(t);
  const pending = await app.begin();
  await app.close();
  const next = await startServer({ dataDir: app.dataDir, port: 0, layrOAuth: app.oauth, layrClient: app.layrClient });
  app.restarted.push(next);
  const callback = new URL(app.callbackUrl(pending.state));
  const response = await fetch(`${next.url}${callback.pathname}${callback.search}`);
  assert.equal(response.status, 400);
  assert.equal(next.service.getConnectors().length, 0);
  assert.equal(app.completeCalls.length, 0);
});

test('Layr token exchange finishing after shutdown cannot attempt a credential save', { timeout: 10000 }, async t => {
  const enteredExchange = barrier(), continueExchange = barrier(), completedExchange = barrier();
  const app = await setup(t, { beforeComplete: async () => { enteredExchange.release(); await continueExchange.promise; } });
  const complete = app.oauth.complete.bind(app.oauth);
  app.oauth.complete = async args => {
    try { return await complete(args); }
    finally { completedExchange.release(); }
  };
  let saves = 0;
  const saveConnector = app.service.saveConnector.bind(app.service);
  t.mock.method(app.service, 'saveConnector', async (...args) => { saves++; return saveConnector(...args); });
  const pending = await app.begin();
  // closeAllConnections can terminate this browser navigation before the token
  // exchange resolves. Observe its rejection while inspecting the late handler.
  const callback = fetch(app.callbackUrl(pending.state)).catch(error => error);
  await enteredExchange.promise;
  try { await app.close(); }
  finally { continueExchange.release(); }
  await completedExchange.promise;
  await new Promise(resolve => setImmediate(resolve));
  await callback;
  assert.equal(saves, 0);
  assert.equal(JSON.parse(await fs.readFile(path.join(app.dataDir, 'state.json'), 'utf8')).connectors.length, 0);
});

test('Layr callback admitted before backup cannot save credentials after the idle barrier', { timeout: 10000 }, async t => {
  const enteredExchange = barrier(), continueExchange = barrier();
  const app = await setup(t, { beforeComplete: async () => { enteredExchange.release(); await continueExchange.promise; } });
  const pending = await app.begin();
  const callback = fetch(app.callbackUrl(pending.state));
  await enteredExchange.promise;
  const backupHeld = barrier(), continueBackup = barrier();
  const readdir = fs.readdir;
  let held = false;
  t.mock.method(fs, 'readdir', async function (directory, ...args) {
    const entries = await readdir.call(this, directory, ...args);
    if (!held && String(directory) === app.dataDir) {
      held = true;
      backupHeld.release();
      await continueBackup.promise;
    }
    return entries;
  });
  const backup = app.request('/api/backup');
  try {
    await backupHeld.promise;
    continueExchange.release();
    const response = await callback;
    assert.equal(response.status, 503, await response.clone().text());
    assert.equal((await app.state()).connectors.length, 0);
  } finally { continueExchange.release(); continueBackup.release(); }
  const backupResponse = await backup;
  assert.equal(backupResponse.status, 200);
  const zip = new AdmZip(Buffer.from(await backupResponse.arrayBuffer()));
  assert.equal(JSON.parse(zip.readAsText('state.json')).connectors.length, 0);
});
