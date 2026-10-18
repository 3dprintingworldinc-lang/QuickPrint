'use strict';

(() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const clone = value => JSON.parse(JSON.stringify(value));
  const number = (value, digits = 0) => Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: digits });
  const title = value => String(value || '').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
  const symbols = { play: '▶︎', pause: 'Ⅱ', step: '↦', reset: '↺', plus: '+', cube: '◇', edit: '↗' };
  const pill = state => `<span class="sim-status ${esc(state)}"><i></i>${esc(title(state))}</span>`;
  const button = (action, label, extra = '', cls = '') => `<button type="button" class="button compact ${cls}" data-sim-action="${action}" ${extra}>${label}</button>`;
  const input = (name, label, value, options = {}) => `<div class="field ${options.full ? 'full' : ''}"><label for="sim-field-${name}">${esc(label)}</label><input id="sim-field-${name}" name="${name}" type="${options.type || 'text'}" value="${esc(value)}" ${options.required === false ? '' : 'required'} ${options.min !== undefined ? `min="${options.min}"` : ''} ${options.max !== undefined ? `max="${options.max}"` : ''} ${options.step ? `step="${options.step}"` : ''} ${options.maxlength ? `maxlength="${options.maxlength}"` : ''}>${options.hint ? `<span class="field-hint">${esc(options.hint)}</span>` : ''}</div>`;
  const select = (name, label, value, choices, hint = '') => `<div class="field"><label for="sim-field-${name}">${esc(label)}</label><select id="sim-field-${name}" name="${name}">${choices.map(([key, text]) => `<option value="${esc(key)}" ${key === value ? 'selected' : ''}>${esc(text)}</option>`).join('')}</select>${hint ? `<span class="field-hint">${esc(hint)}</span>` : ''}</div>`;
  const section = label => `<h3 class="sim-form-section">${label}</h3>`;
  const numeric = (name, label, value, min = 0, max = 100000, step = 'any', hint = '') => input(name, label, value, { type: 'number', min, max, step, hint });

  function mount(container, { api, toast }) {
    let snapshot = null, scene = null, disposed = false, busy = false, requestPending = false;
    let selectedId = null, selectedKind = 'printer', tab = 'jobs', layoutDraft = null, dialog = null, previewSequence = 0;
    let polling, sceneFailed = false;
    const $ = selector => container.querySelector(selector);
    const status = message => { const target = $('[data-sim-error]'); if (target) { target.hidden = !message; target.textContent = message || ''; } };
    const selected = () => snapshot?.[selectedKind === 'printer' ? 'printers' : selectedKind === 'clearer' ? 'clearers' : 'jobs']?.find(item => item.id === selectedId);
    const newId = prefix => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
    const minutes = value => `${number(value, 1)} min`;
    const getScenario = () => clone(snapshot.scenario);
    const download = (name, value) => { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };

    container.innerHTML = `<div class="sim-workspace">
      <div class="sim-heading"><div><div class="sim-eyebrow"><span class="sim-live-dot"></span>VIRTUAL PRINT FLOOR</div><h1>Make room for possibility.</h1><p>Design your farm. Test the flow. See what happens next.</p></div><div class="sim-heading-actions">${button('templates', 'Load a template')}${button('export', 'Export scenario')}${button('import', 'Import scenario')}<input type="file" accept=".json,application/json" data-sim-import hidden></div></div>
      <div class="sim-error" data-sim-error role="alert" hidden></div>
      <div class="sim-summary" data-sim-summary></div>
      <section class="sim-workbench" aria-label="Virtual farm workspace">
        <div class="sim-toolbar"><div class="sim-farm-title"><span class="sim-farm-icon">◇</span><div><strong data-sim-name>Loading your virtual farm…</strong><small data-sim-room></small></div>${button('farm', 'Edit farm', '', 'sim-text-button')}</div><div class="sim-clock-controls"><span class="sim-time" data-sim-time>00:00</span>${button('play', `${symbols.play} Run`, '', 'primary')}${button('step', 'Step 5 min')}${button('reset', '↺ Reset')}<label class="sim-speed">Speed<select data-sim-speed aria-label="Simulation speed"><option value="1">1×</option><option value="10">10×</option><option value="60" selected>60×</option><option value="300">300×</option><option value="600">600×</option></select></label></div></div>
        <div class="sim-layout-notice" data-sim-layout hidden><span><strong>Layout edit mode</strong> · Drag equipment on the floor. Applying changes resets this run.</span><div>${button('cancel-layout', 'Cancel')}${button('save-layout', 'Apply layout & reset', '', 'primary')}</div></div>
        <div class="sim-stage"><div class="sim-canvas-wrap"><div class="sim-scene-host" data-sim-scene aria-label="Interactive 3D print farm"></div><div class="sim-scene-top"><span class="sim-sandbox-label">SIMULATION ONLY</span><div>${button('view', 'Top view', 'aria-pressed="false"')}${button('camera', 'Reset view')}${button('layout', 'Move equipment')}</div></div><div class="sim-scene-bottom"><div class="sim-legend"><span><i class="idle"></i>Ready</span><span><i class="printing"></i>Printing</span><span><i class="clearing"></i>Clearing</span><span><i class="blocked"></i>Attention</span></div></div><div class="sim-webgl-notice" data-sim-webgl hidden><strong>3D preview unavailable</strong><p>The simulation and all configuration controls remain available below.</p></div></div><aside class="sim-inspector" aria-label="Selected equipment or job" data-sim-inspector></aside></div>
        <div class="sim-workbench-footer"><span><i class="sim-live-dot"></i><span data-sim-run-label>Paused · ready to explore</span></span><span>Virtual equipment · No commands sent to real printers</span></div>
      </section>
      <section class="sim-detail-panel"><div class="sim-tabs" role="tablist" aria-label="Simulation details"><button role="tab" data-sim-tab="jobs" aria-selected="true">Job queue <span data-sim-job-count></span></button><button role="tab" data-sim-tab="fleet" aria-selected="false">Farm equipment <span data-sim-printer-count></span></button><button role="tab" data-sim-tab="routing" aria-selected="false">Routing logic</button><button role="tab" data-sim-tab="events" aria-selected="false">Event log</button><div class="sim-detail-actions" data-sim-detail-actions></div></div><div data-sim-detail role="tabpanel"></div></section>
      <p class="sim-disclaimer">A place to test ideas before they reach the floor. Print times, failure rates and clearing cycles are your scenario assumptions; these are simulated results, not physical or slicer predictions.</p>
    </div>`;

    function sceneSnapshot() {
      if (!layoutDraft) return snapshot;
      return { ...snapshot, scenario: layoutDraft, printers: snapshot.printers.map(item => ({ ...item, ...layoutDraft.printers.find(p => p.id === item.id) })), clearers: snapshot.clearers.map(item => ({ ...item, ...layoutDraft.clearers.find(p => p.id === item.id) })) };
    }

    function updateScene() {
      if (!snapshot || !scene) return;
      try { scene.update(sceneSnapshot(), { selectedPrinterId: selectedKind === 'printer' ? selectedId : null, selectedClearerId: selectedKind === 'clearer' ? selectedId : null, editing: Boolean(layoutDraft) }); }
      catch (error) { webglError(error.message); }
    }

    function webglError(message) {
      sceneFailed = true;
      $('[data-sim-webgl]').hidden = false;
      $('[data-sim-scene]').setAttribute('aria-label', '3D preview unavailable; use Farm equipment controls below');
      $('[data-sim-webgl] p').textContent = `${message || 'WebGL is unavailable.'} Use the equipment list below to configure and test the farm.`;
    }

    function initializeScene() {
      try {
        if (!window.QuickPrintScene?.createFarmScene) throw new Error('The local 3D renderer could not be loaded.');
        scene = window.QuickPrintScene.createFarmScene($('[data-sim-scene]'), {
          onSelect: (id, kind = 'printer') => { selectedId = id; selectedKind = kind; updateScene(); renderInspector(); },
          onMove: (id, position, kind = 'printer') => {
            if (!layoutDraft) return;
            const item = layoutDraft[kind === 'clearer' ? 'clearers' : 'printers'].find(entry => entry.id === id);
            if (item) item.position = { x: Math.round(position.x * 100) / 100, z: Math.round(position.z * 100) / 100 };
            updateScene(); renderInspector();
          },
          onError: webglError,
        });
      } catch (error) { webglError(error.message); }
    }

    async function refresh() {
      if (disposed || requestPending) return;
      requestPending = true;
      try {
        const value = await api('/api/simulation');
        if (disposed) return;
        snapshot = value; status(value.error || '');
        if (selectedId && !selected()) selectedId = null;
        render();
      } catch (error) { if (!disposed) status(`Simulation unavailable: ${error.message}`); }
      finally { requestPending = false; }
    }

    async function mutate(path, body, method = 'POST') {
      await api(`/api/simulation${path}`, { method, body });
      // A previous poll may have captured the state before this mutation.
      while (requestPending && !disposed) await new Promise(resolve => setTimeout(resolve, 25));
      await refresh();
    }

    function render() {
      if (!snapshot || disposed) return;
      const metrics = snapshot.metrics || {};
      $('[data-sim-name]').textContent = snapshot.scenario.name;
      $('[data-sim-room]').textContent = `${snapshot.printers.length} printers · ${snapshot.scenario.room.width} × ${snapshot.scenario.room.depth} m floor`;
      const wholeMinutes = Math.floor(snapshot.timeMinutes || 0);
      $('[data-sim-time]').textContent = `${String(Math.floor(wholeMinutes / 60)).padStart(2, '0')}:${String(wholeMinutes % 60).padStart(2, '0')}`;
      $('[data-sim-time]').title = `${minutes(snapshot.timeMinutes)} simulated`;
      $('[data-sim-run-label]').textContent = snapshot.running ? `Running at ${snapshot.speed}× · simulated time` : 'Paused · ready to explore';
      const play = $('[data-sim-action="play"]');
      play.innerHTML = snapshot.running ? `${symbols.pause} Pause` : `${symbols.play} Run`;
      play.disabled = Boolean(layoutDraft) || busy;
      $('[data-sim-action="step"]').disabled = snapshot.running || Boolean(layoutDraft) || busy;
      $('[data-sim-action="reset"]').disabled = Boolean(layoutDraft) || busy;
      $('[data-sim-layout]').hidden = !layoutDraft;
      if (document.activeElement !== $('[data-sim-speed]')) $('[data-sim-speed]').value = String(snapshot.speed || 60);
      $('[data-sim-speed]').disabled = Boolean(layoutDraft);
      $('[data-sim-summary]').innerHTML = [
        ['Completed copies', number(metrics.completedCopies), `${number(metrics.failedCopies)} failed copies`, 'completed'],
        ['Throughput', `${number(metrics.throughputPerHour, 1)}<small>/hr</small>`, 'From simulated elapsed time', 'throughput'],
        ['Fleet utilization', `${number(metrics.utilizationPercent, 1)}<small>%</small>`, `${number(metrics.availablePrinters)} printers available`, 'utilization'],
        ['Waiting to clear', number(metrics.waitingClearers), `${number(metrics.blockedPrinters)} blocked · ${number(metrics.clearWaitMinutes, 1)} min waiting`, 'clearing'],
      ].map(([label, value, hint, key]) => `<article class="sim-metric"><span>${label}</span><strong data-sim-metric="${key}">${value}</strong><small>${hint}</small></article>`).join('');
      $('[data-sim-job-count]').textContent = snapshot.jobs.length;
      $('[data-sim-printer-count]').textContent = snapshot.printers.length;
      updateScene(); renderInspector(); renderDetail();
    }

    function facts(items) { return `<dl class="sim-facts">${items.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`).join('')}</dl>`; }

    function renderInspector() {
      if (!snapshot) return;
      const item = selected();
      if (!item) {
        $('[data-sim-inspector]').innerHTML = `<div class="sim-inspector-label">YOUR VIRTUAL WORKSPACE</div><div class="sim-inspector-art">◇</div><h2>A farm with room to grow.</h2><p>Select a printer in the scene to inspect its work, test a failure, or change its clearing setup.</p>${facts([['Routing strategy', esc(title(snapshot.scenario.routing.strategy))], ['Queue order', esc(title(snapshot.scenario.routing.queueOrder))], ['Shared clearers', number(snapshot.clearers.length)], ['Scenario seed', number(snapshot.scenario.seed)]])}<div class="sim-inspector-buttons">${button('add-printer', '+ Add virtual printer', '', 'primary')}${button('routing', 'Configure routing')}${button('add-job', '+ Add test job')}</div><div class="sim-hint"><strong>Try a what-if.</strong><br>Run a template, switch to manual clearing, then compare throughput and time spent waiting.</div>`;
        return;
      }
      if (selectedKind === 'job') {
        $('[data-sim-inspector]').innerHTML = `<div class="sim-inspector-label">JOB INSPECTOR</div><h2>${esc(item.name)}</h2>${pill(item.state)}${facts([['Material / nozzle', `${esc(item.material)} / ${number(item.nozzle, 2)} mm`], ['Copies completed', `${number(item.completedCopies)} / ${number(item.quantity)}`], ['Estimated duration', minutes(item.durationMinutes)], ['Priority / due', `${number(item.priority)} / ${item.dueMinutes == null ? 'None' : minutes(item.dueMinutes)}`]])}<p class="sim-routing-reason">${esc(item.routingReason || 'View the routing preview below for eligibility and selection.')}</p><div class="sim-inspector-buttons">${button('edit-job', 'Edit test job', `data-id="${esc(item.id)}"`)}</div><h3 class="sim-inspector-subtitle">Routing decision</h3><div data-sim-preview><p>Checking printer eligibility…</p></div>`;
        void loadPreview(item.id);
        return;
      }
      if (selectedKind === 'clearer') {
        $('[data-sim-inspector]').innerHTML = `<div class="sim-inspector-label">SHARED CLEARING RESOURCE</div><h2>${esc(item.name)}</h2>${pill(item.state)}${facts([['Serving', esc(snapshot.printers.find(p => p.id === item.printerId)?.name || 'Available')], ['Time clearing', minutes(item.busyMinutes)], ['Assigned printers', number(snapshot.printers.filter(p => p.clearing.resourceId === item.id).length)]])}<p>One shared resource clears one printer at a time. Others wait with their beds occupied.</p><div class="sim-inspector-buttons">${button('edit-clearer', 'Edit clearing resource', `data-id="${esc(item.id)}"`)}</div>`;
        return;
      }
      const config = layoutDraft?.printers.find(p => p.id === item.id) || item;
      const currentJob = snapshot.jobs.find(job => job.id === item.currentJobId);
      const faults = [];
      if (item.state === 'offline') faults.push(button('fault', 'Bring online', `data-fault="online" data-id="${esc(item.id)}"`));
      else faults.push(button('fault', 'Take offline', `data-fault="offline" data-id="${esc(item.id)}"`));
      if (item.state === 'printing') faults.push(button('fault', 'Simulate print failure', `data-fault="print_failure" data-id="${esc(item.id)}"`));
      if (item.state === 'clearing') faults.push(button('fault', 'Simulate clear failure', `data-fault="clear_failure" data-id="${esc(item.id)}"`));
      if (['blocked', 'waiting_clear'].includes(item.state)) faults.push(button('fault', 'Manually clear bed', `data-fault="manual_clear" data-id="${esc(item.id)}"`, 'primary'));
      $('[data-sim-inspector]').innerHTML = `<div class="sim-inspector-label">VIRTUAL PRINTER</div><div class="sim-inspector-title"><h2>${esc(item.name)}</h2>${button('edit-printer', 'Edit', `data-id="${esc(item.id)}"`)}</div><span class="sim-printer-model">${esc(item.model || 'Generic printer')} · ${esc(item.zone || 'No zone')}</span>${pill(item.state)}<div class="sim-progress-label"><span>${esc(currentJob?.name || (item.bedDirty ? 'Build plate occupied' : 'Ready for the next job'))}</span><strong>${number(item.progress)}%</strong></div><div class="sim-progress"><span style="width:${Math.max(0, Math.min(100, Number(item.progress || 0)))}%"></span></div>${item.blockedReason ? `<p class="sim-attention">${esc(title(item.blockedReason))}</p>` : ''}${facts([['Materials', esc(item.materials.join(', '))], ['Build volume', `${item.buildVolume.x} × ${item.buildVolume.y} × ${item.buildVolume.z} mm`], ['Clearing', esc(title(item.clearing.mode))], ['Cooldown / clear', `${minutes(item.clearing.cooldownMinutes)} / ${minutes(item.clearing.cycleMinutes)}`], ['Completed / failed', `${number(item.completedCopies)} / ${number(item.failedCopies)}`], ['Position', `${number(config.position.x, 2)}, ${number(config.position.z, 2)} m`]])}<h3 class="sim-inspector-subtitle">Test a scenario</h3><div class="sim-inspector-buttons sim-faults">${faults.join('')}</div><p class="sim-small-note">These actions affect virtual equipment only.</p>`;
    }

    async function loadPreview(jobId) {
      const request = ++previewSequence;
      try {
        const preview = await api(`/api/simulation/preview/${encodeURIComponent(jobId)}`);
        if (disposed || request !== previewSequence || selectedKind !== 'job' || selectedId !== jobId) return;
        const host = $('[data-sim-preview]');
        if (!host) return;
        host.innerHTML = (preview.candidates || []).map(candidate => `<div class="sim-candidate ${candidate.eligible ? 'eligible' : ''}"><strong>${esc(snapshot.printers.find(p => p.id === candidate.printerId)?.name || candidate.printerId)}${candidate.printerId === preview.selectedPrinterId ? '<span>Selected</span>' : ''}</strong><small>${esc(candidate.reasons?.join(' · ') || (candidate.eligible ? 'Eligible for this job' : 'Not eligible'))}</small>${candidate.score != null && candidate.eligible ? `<small>Routing score ${number(candidate.score, 2)}</small>` : ''}</div>`).join('') || '<p>No printers in this farm.</p>';
      } catch (error) { const host = $('[data-sim-preview]'); if (host && request === previewSequence) host.textContent = error.message; }
    }

    function renderDetail() {
      const host = $('[data-sim-detail]'), actions = $('[data-sim-detail-actions]');
      container.querySelectorAll('[data-sim-tab]').forEach(element => { element.setAttribute('aria-selected', String(element.dataset.simTab === tab)); });
      if (tab === 'jobs') {
        actions.innerHTML = button('add-job', '+ Add test job', '', 'soft');
        host.innerHTML = snapshot.jobs.length ? `<div class="sim-table-scroll"><table class="sim-table"><thead><tr><th>Job / material</th><th>Status</th><th>Copies</th><th>Duration</th><th>Priority / due</th><th>Routing</th><th></th></tr></thead><tbody>${snapshot.jobs.map(job => `<tr class="${selectedKind === 'job' && selectedId === job.id ? 'selected' : ''}"><td><button class="sim-name-button" data-sim-action="select" data-kind="job" data-id="${esc(job.id)}">${esc(job.name)}</button><small>${esc(job.material)} · ${number(job.nozzle, 2)} mm nozzle</small></td><td>${pill(job.state)}</td><td><strong>${job.completedCopies} / ${job.quantity}</strong><small>${job.activeCopies} active · ${job.failedCopies} failed</small></td><td>${minutes(job.durationMinutes)}</td><td>${number(job.priority)}<small>${job.dueMinutes == null ? 'No due time' : `Due at ${minutes(job.dueMinutes)}`}</small></td><td class="sim-routing-cell">${esc(job.routingReason || 'Awaiting dispatch')}<button class="sim-inline-link" data-sim-action="select" data-kind="job" data-id="${esc(job.id)}">Explain routing →</button></td><td>${button('edit-job', 'Edit', `data-id="${esc(job.id)}"`)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="sim-empty"><strong>A fresh queue, full of possibilities.</strong><p>Add a test job to see how it moves through your virtual farm.</p></div>';
      } else if (tab === 'fleet') {
        actions.innerHTML = `${button('add-clearer', '+ Shared clearer')}${button('add-printer', '+ Virtual printer', '', 'soft')}`;
        host.innerHTML = `<div class="sim-equipment-grid">${snapshot.printers.map(printer => `<article class="sim-equipment-card ${selectedId === printer.id ? 'selected' : ''}"><div><button class="sim-name-button" data-sim-action="select" data-kind="printer" data-id="${esc(printer.id)}">${esc(printer.name)}</button>${pill(printer.state)}</div><p>${esc(printer.materials.join(' / '))} · ${esc(printer.zone || 'No zone')} · ${esc(title(printer.clearing.mode))} clearing</p><div class="sim-equipment-actions">${button('select', 'Inspect', `data-kind="printer" data-id="${esc(printer.id)}"`)}${button('edit-printer', 'Configure', `data-id="${esc(printer.id)}"`)}</div></article>`).join('')}${snapshot.clearers.map(clearer => `<article class="sim-equipment-card sim-clearer-card"><div><button class="sim-name-button" data-sim-action="select" data-kind="clearer" data-id="${esc(clearer.id)}">${esc(clearer.name)}</button>${pill(clearer.state)}</div><p>Shared clearing resource · ${snapshot.printers.filter(p => p.clearing.resourceId === clearer.id).length} assigned printers</p><div class="sim-equipment-actions">${button('edit-clearer', 'Configure', `data-id="${esc(clearer.id)}"`)}</div></article>`).join('')}</div>${!snapshot.printers.length ? '<div class="sim-empty">Add a virtual printer to start designing this farm.</div>' : ''}`;
      } else if (tab === 'routing') {
        actions.innerHTML = button('routing', 'Edit routing logic', '', 'soft');
        const routing = snapshot.scenario.routing;
        host.innerHTML = `<div class="sim-routing-overview"><div><span class="sim-inspector-label">PRINTER SELECTION</span><h3>${esc(title(routing.strategy))}</h3><p>${{ balanced: 'Distribute work using the least assigned printing time.', fastest: 'Choose the eligible printer with the shortest estimated print time.', round_robin: 'Rotate through eligible printers in farm order.' }[routing.strategy] || ''}</p></div><div><span class="sim-inspector-label">QUEUE ORDER</span><h3>${esc(title(routing.queueOrder))}</h3><p>${{ priority: 'Higher-priority jobs are considered first.', fifo: 'Earlier arrivals are considered first.', due_date: 'Jobs with the earliest due time are considered first.' }[routing.queueOrder] || ''}</p></div><div><span class="sim-inspector-label">ALWAYS CHECKED</span><h3>Compatibility comes first.</h3><p>Material, nozzle, build volume, zone and a clear, available printer are required.</p></div></div><div class="sim-rules-list">${routing.rules.length ? routing.rules.map((rule, index) => `<div class="sim-rule"><span class="sim-rule-index">${index + 1}</span><div><strong>${esc(rule.name)} ${!rule.enabled ? '<small>Disabled</small>' : ''}</strong><p>${[rule.material && `Material ${rule.material}`, rule.tag && `Tag ${rule.tag}`, `Priority ≥ ${rule.minPriority}`].filter(Boolean).map(esc).join(' · ')} <span>→</span> Zone <b>${esc(rule.targetZone)}</b></p></div></div>`).join('') : '<p class="sim-small-note">No routing rules. All compatible printers are considered.</p>'}<p class="sim-small-note">Rules run from top to bottom. The first matching enabled rule restricts a job to its target zone; it cannot bypass compatibility checks.</p></div>`;
      } else {
        actions.innerHTML = `<span class="sim-small-note">Newest events first · simulated time</span>`;
        host.innerHTML = `<div class="sim-events">${[...(snapshot.events || [])].reverse().slice(0, 120).map(event => `<div class="sim-event"><time>${minutes(event.timeMinutes ?? event.time)}</time><i class="${esc(event.type)}"></i><p>${esc(event.message)}</p></div>`).join('') || '<div class="sim-empty">Run the farm to see dispatch, print and clearing events here.</div>'}</div>`;
      }
    }

    async function pauseForEdit() {
      if (layoutDraft) throw new Error('Apply or cancel your layout changes before editing another part of the scenario.');
      if (snapshot.running) await mutate('/control', { action: 'pause' });
    }

    function closeDialog() { if (dialog) { dialog.close(); dialog.remove(); dialog = null; } }
    function showDialog(titleText, intro, fields, onSave, { saveLabel = 'Apply & reset simulation', remove, reset = true } = {}) {
      closeDialog();
      const element = document.createElement('dialog'); dialog = element; element.className = 'sim-dialog';
      element.innerHTML = `<form><div class="sim-dialog-header"><div><span class="sim-eyebrow">SIMULATION WORKSPACE</span><h2>${esc(titleText)}</h2><p>${esc(intro)}</p></div><button type="button" class="sim-dialog-close" aria-label="Close dialog">×</button></div><div class="sim-dialog-body">${reset ? '<div class="sim-edit-notice">The clock is paused. Applying configuration changes resets simulated time, jobs and results for this scenario.</div>' : ''}<div class="sim-form-error" role="alert" hidden></div><div class="form-grid">${fields}</div></div><div class="sim-dialog-footer">${remove ? '<button type="button" class="button compact sim-remove">Remove & reset</button>' : '<span></span>'}<div><button type="button" class="button compact sim-dialog-cancel">Cancel</button><button class="button primary compact" type="submit">${esc(saveLabel)}</button></div></div></form>`;
      container.append(element);
      const error = message => { const target = element.querySelector('.sim-form-error'); target.hidden = !message; target.textContent = message || ''; };
      element.querySelector('.sim-dialog-close').onclick = closeDialog;
      element.querySelector('.sim-dialog-cancel').onclick = closeDialog;
      element.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
      element.querySelector('form').onsubmit = async event => {
        event.preventDefault();
        const submit = element.querySelector('[type="submit"]'); submit.disabled = true;
        try { await onSave(new FormData(event.currentTarget), element); closeDialog(); toast('Simulation updated. Ready for a fresh run.'); }
        catch (failure) { error(failure.message); }
        finally { submit.disabled = false; }
      };
      if (remove) element.querySelector('.sim-remove').onclick = async event => {
        const target = event.currentTarget;
        if (!target.dataset.confirmed) { target.dataset.confirmed = 'true'; target.textContent = 'Confirm removal & reset'; return; }
        target.disabled = true;
        try { await remove(); closeDialog(); toast('Removed from the virtual farm. Simulation reset.'); }
        catch (failure) { error(failure.message); target.disabled = false; }
      };
      element.showModal();
      return element;
    }

    async function saveScenario(scenario) { await mutate('/scenario', scenario, 'PUT'); }
    function value(data, key) { return String(data.get(key) || '').trim(); }
    function n(data, key) { return Number(data.get(key)); }

    async function editFarm() {
      await pauseForEdit(); const scenario = getScenario();
      showDialog('Shape your print floor', 'Define the room and seed for repeatable experiments.', `${input('name', 'Scenario name', scenario.name, { full: true, maxlength: 100 })}${numeric('width', 'Floor width (m)', scenario.room.width, 2, 1000)}${numeric('depth', 'Floor depth (m)', scenario.room.depth, 2, 1000)}${numeric('seed', 'Random seed', scenario.seed, 0, 4294967295, '1', 'The same seed and actions produce the same random failures.')}`, async data => {
        scenario.name = value(data, 'name'); scenario.room = { width: n(data, 'width'), depth: n(data, 'depth') }; scenario.seed = n(data, 'seed'); await saveScenario(scenario);
      });
    }

    async function editPrinter(id) {
      await pauseForEdit(); const scenario = getScenario();
      const existing = scenario.printers.find(printer => printer.id === id);
      const printer = existing || { id: newId('printer'), name: `Printer ${String(scenario.printers.length + 1).padStart(2, '0')}`, model: 'CoreXY', zone: '', position: { x: Math.min(2, scenario.room.width - 0.5), z: Math.min(2, scenario.room.depth - 0.5) }, rotation: 0, buildVolume: { x: 256, y: 256, z: 256 }, materials: ['PLA'], nozzle: 0.4, speedMultiplier: 1, enabled: true, failureRate: 0, clearing: { mode: 'manual', cooldownMinutes: 2, cycleMinutes: 1, resourceId: null, failureRate: 0 } };
      showDialog(existing ? `Configure ${printer.name}` : 'Add a virtual printer', 'Set capabilities, position and the complete bed-clearing cycle.', `${input('name', 'Printer name', printer.name, { maxlength: 100 })}${input('model', 'Model label', printer.model, { required: false, maxlength: 100 })}${input('zone', 'Zone', printer.zone, { required: false, hint: 'Use zones to direct routing rules.' })}${input('materials', 'Accepted materials', printer.materials.join(', '), { hint: 'Comma-separated, for example PLA, PETG, ABS.' })}${numeric('nozzle', 'Nozzle diameter (mm)', printer.nozzle, 0.1, 5)}${numeric('speedMultiplier', 'Print speed multiplier', printer.speedMultiplier, 0.1, 20, '0.1', '2× completes the estimated job in half the time.')}${section('Build volume · millimeters')}${numeric('sizeX', 'Width (X)', printer.buildVolume.x, 1, 5000)}${numeric('sizeY', 'Depth (Y)', printer.buildVolume.y, 1, 5000)}${numeric('sizeZ', 'Height (Z)', printer.buildVolume.z, 1, 5000)}${numeric('failureRate', 'Print failure probability (%)', printer.failureRate * 100, 0, 100)}${section('Position on the floor')}${numeric('x', 'Floor X (m)', printer.position.x, 0.5, scenario.room.width - 0.5)}${numeric('z', 'Floor Z (m)', printer.position.z, 0.5, scenario.room.depth - 0.5)}${numeric('rotation', 'Rotation (degrees)', printer.rotation || 0, -360, 360)}${select('enabled', 'Available in simulation', printer.enabled ? 'true' : 'false', [['true', 'Enabled'], ['false', 'Disabled / offline']])}${section('Auto clear setup')}${select('clearMode', 'Clearing method', printer.clearing.mode, [['manual', 'Manual — operator clears bed'], ['automatic', 'Automatic — dedicated mechanism'], ['robot', 'Robot — shared clearing resource']])}${select('resourceId', 'Shared clearing resource', printer.clearing.resourceId || '', [['', 'Select for robot clearing'], ...scenario.clearers.map(clearer => [clearer.id, clearer.name])], 'Add a shared clearer from Farm equipment if needed.')}${numeric('cooldown', 'Cooldown before clearing (min)', printer.clearing.cooldownMinutes, 0, 1440)}${numeric('cycle', 'Clearing cycle (min)', printer.clearing.cycleMinutes, 0.01, 1440)}${numeric('clearFailureRate', 'Clear failure probability (%)', printer.clearing.failureRate * 100, 0, 100)}<p class="sim-full-note">The next print waits until the previous part has cooled and the bed is clear. Manual mode waits for your “Manually clear bed” action. A shared robot serves one printer at a time.</p>`, async data => {
        Object.assign(printer, { name: value(data, 'name'), model: value(data, 'model'), zone: value(data, 'zone'), materials: value(data, 'materials').split(',').map(material => material.trim()).filter(Boolean), nozzle: n(data, 'nozzle'), speedMultiplier: n(data, 'speedMultiplier'), position: { x: n(data, 'x'), z: n(data, 'z') }, rotation: n(data, 'rotation'), buildVolume: { x: n(data, 'sizeX'), y: n(data, 'sizeY'), z: n(data, 'sizeZ') }, enabled: value(data, 'enabled') === 'true', failureRate: n(data, 'failureRate') / 100, clearing: { mode: value(data, 'clearMode'), cooldownMinutes: n(data, 'cooldown'), cycleMinutes: n(data, 'cycle'), resourceId: value(data, 'clearMode') === 'robot' ? value(data, 'resourceId') || null : null, failureRate: n(data, 'clearFailureRate') / 100 } });
        if (!scenario.printers.some(item => item.id === printer.id)) scenario.printers.push(printer);
        await saveScenario(scenario); selectedId = printer.id; selectedKind = 'printer'; render();
      }, { remove: existing ? async () => { scenario.printers = scenario.printers.filter(item => item.id !== id); await saveScenario(scenario); } : undefined });
    }

    async function editClearer(id) {
      await pauseForEdit(); const scenario = getScenario(); const existing = scenario.clearers.find(item => item.id === id);
      const clearer = existing || { id: newId('clearer'), name: `Clearing robot ${scenario.clearers.length + 1}`, position: { x: scenario.room.width / 2, z: scenario.room.depth / 2 } };
      showDialog(existing ? 'Configure shared clearer' : 'Add a shared clearer', 'Model a robot or shared station that clears one printer at a time.', `${input('name', 'Resource name', clearer.name, { full: true, maxlength: 100 })}${numeric('x', 'Floor X (m)', clearer.position.x, 0.5, scenario.room.width - 0.5)}${numeric('z', 'Floor Z (m)', clearer.position.z, 0.5, scenario.room.depth - 0.5)}<p class="sim-full-note">Assign this resource in each printer’s auto clear setup. Clearing duration belongs to the printer; travel time and collisions are not modeled.</p>`, async data => {
        Object.assign(clearer, { name: value(data, 'name'), position: { x: n(data, 'x'), z: n(data, 'z') } }); if (!scenario.clearers.some(item => item.id === clearer.id)) scenario.clearers.push(clearer); await saveScenario(scenario);
      }, { remove: existing ? async () => { if (scenario.printers.some(printer => printer.clearing.resourceId === id)) throw new Error('Reassign printers using this clearer before removing it.'); scenario.clearers = scenario.clearers.filter(item => item.id !== id); await saveScenario(scenario); } : undefined });
    }

    async function editJob(id) {
      await pauseForEdit(); const scenario = getScenario(); const existing = scenario.jobs.find(item => item.id === id);
      const job = existing || { id: newId('job'), name: `Test part ${scenario.jobs.length + 1}`, material: 'PLA', nozzle: 0.4, size: { x: 80, y: 60, z: 40 }, durationMinutes: 20, quantity: 3, priority: 1, dueMinutes: 120, arrivalMinutes: 0, tag: '', zone: '' };
      showDialog(existing ? 'Configure test job' : 'Add a test job', 'Describe the work entering your farm. No model file is needed.', `${input('name', 'Job name', job.name, { full: true, maxlength: 100 })}${input('material', 'Material', job.material)}${numeric('nozzle', 'Required nozzle (mm)', job.nozzle, 0.1, 5)}${numeric('quantity', 'Number of copies', job.quantity, 1, 1000, '1')}${numeric('duration', 'Estimated print time per copy (min)', job.durationMinutes, 0.01, 10080)}${section('Part size · millimeters')}${numeric('sizeX', 'Width (X)', job.size.x, 0.1, 5000)}${numeric('sizeY', 'Depth (Y)', job.size.y, 0.1, 5000)}${numeric('sizeZ', 'Height (Z)', job.size.z, 0.1, 5000)}${section('Queue and routing')}${numeric('priority', 'Priority (higher first)', job.priority, 0, 100, '1')}${numeric('arrival', 'Arrival at simulated minute', job.arrivalMinutes, 0, 1000000)}${input('due', 'Due at simulated minute', job.dueMinutes ?? '', { type: 'number', min: 0, max: 1000000, step: 'any', required: false, hint: 'Optional. Measured from the start of the run.' })}${input('tag', 'Routing tag', job.tag, { required: false })}${input('zone', 'Required zone', job.zone, { required: false, hint: 'Optional hard constraint; leave blank for any zone.' })}`, async data => {
        Object.assign(job, { name: value(data, 'name'), material: value(data, 'material'), nozzle: n(data, 'nozzle'), quantity: n(data, 'quantity'), durationMinutes: n(data, 'duration'), size: { x: n(data, 'sizeX'), y: n(data, 'sizeY'), z: n(data, 'sizeZ') }, priority: n(data, 'priority'), arrivalMinutes: n(data, 'arrival'), dueMinutes: value(data, 'due') === '' ? null : n(data, 'due'), tag: value(data, 'tag'), zone: value(data, 'zone') });
        if (!scenario.jobs.some(item => item.id === job.id)) scenario.jobs.push(job); await saveScenario(scenario); selectedId = job.id; selectedKind = 'job'; render();
      }, { remove: existing ? async () => { scenario.jobs = scenario.jobs.filter(item => item.id !== id); await saveScenario(scenario); } : undefined });
    }

    async function editRouting() {
      await pauseForEdit(); const scenario = getScenario();
      const ruleRow = rule => `<fieldset class="sim-rule-editor" data-rule-id="${esc(rule.id)}"><legend>Routing rule</legend><label>Name<input name="rule-name" value="${esc(rule.name)}" required maxlength="100"></label><label>Material<input name="rule-material" value="${esc(rule.material)}" placeholder="Any material"></label><label>Job tag<input name="rule-tag" value="${esc(rule.tag)}" placeholder="Any tag"></label><label>Minimum priority<input name="rule-priority" type="number" value="${rule.minPriority}" min="0" max="100" step="1" required></label><label>Target zone<input name="rule-zone" value="${esc(rule.targetZone)}" required placeholder="e.g. PLA"></label><label>State<select name="rule-enabled"><option value="true" ${rule.enabled ? 'selected' : ''}>Enabled</option><option value="false" ${!rule.enabled ? 'selected' : ''}>Disabled</option></select></label><div class="sim-rule-controls"><button type="button" class="button compact" data-rule-action="up">Move up</button><button type="button" class="button compact" data-rule-action="down">Move down</button><button type="button" class="button compact" data-rule-action="remove">Remove rule</button></div></fieldset>`;
      const element = showDialog('Design your routing logic', 'Choose how jobs enter the queue and how compatible printers are selected.', `${select('strategy', 'Printer selection', scenario.routing.strategy, [['balanced', 'Balanced — least assigned print time'], ['fastest', 'Fastest — shortest estimated print time'], ['round_robin', 'Round robin — rotate through printers']])}${select('queueOrder', 'Queue order', scenario.routing.queueOrder, [['priority', 'Highest priority first'], ['fifo', 'First in, first out'], ['due_date', 'Earliest due time first']])}${section('Zone routing rules · first match wins')}<p class="sim-full-note">A rule matches its nonempty material and tag, plus minimum priority. Its target zone restricts eligible printers. Compatibility and clear-bed checks always apply.</p><div class="sim-rule-editors">${scenario.routing.rules.map(ruleRow).join('')}</div><button type="button" class="button compact sim-add-rule">+ Add routing rule</button>`, async (data, target) => {
        scenario.routing = { strategy: value(data, 'strategy'), queueOrder: value(data, 'queueOrder'), rules: [...target.querySelectorAll('[data-rule-id]')].map(row => { const read = name => row.querySelector(`[name="rule-${name}"]`).value.trim(); return { id: row.dataset.ruleId, name: read('name'), material: read('material'), tag: read('tag'), minPriority: Number(read('priority')), targetZone: read('zone'), enabled: read('enabled') === 'true' }; }) };
        await saveScenario(scenario);
      });
      element.querySelector('.sim-add-rule').onclick = () => element.querySelector('.sim-rule-editors').insertAdjacentHTML('beforeend', ruleRow({ id: newId('rule'), name: 'New rule', material: '', tag: '', minPriority: 0, targetZone: '', enabled: true }));
      element.addEventListener('click', event => { const target = event.target.closest('[data-rule-action]'); if (!target) return; const row = target.closest('[data-rule-id]'); if (target.dataset.ruleAction === 'remove') row.remove(); if (target.dataset.ruleAction === 'up' && row.previousElementSibling) row.previousElementSibling.before(row); if (target.dataset.ruleAction === 'down' && row.nextElementSibling) row.nextElementSibling.after(row); });
    }

    async function templates() {
      await pauseForEdit();
      const catalog = snapshot.presets || [{ id: 'starter', name: 'Starter farm' }, { id: 'mixed', name: 'Mixed-material farm' }, { id: 'automated', name: 'Automated farm' }];
      showDialog('Start with a different possibility', 'A template replaces your current scenario. Export it first if you want to keep it.', select('preset', 'Farm template', 'mixed', catalog.map(item => [item.id || item.key || item.name, item.label || item.name])), async data => { await mutate('/preset', { name: value(data, 'preset') }); selectedId = null; }, { saveLabel: 'Load template & reset' });
    }

    async function onClick(event) {
      const tabButton = event.target.closest('[data-sim-tab]');
      if (tabButton) { tab = tabButton.dataset.simTab; renderDetail(); return; }
      const target = event.target.closest('[data-sim-action]');
      if (!target || busy || !snapshot) return;
      const action = target.dataset.simAction, id = target.dataset.id;
      if (action === 'select') { selectedId = id; selectedKind = target.dataset.kind; updateScene(); renderInspector(); renderDetail(); if (selectedKind !== 'job') scene?.focus?.(id); return; }
      if (action === 'view') { const top = target.getAttribute('aria-pressed') !== 'true'; target.setAttribute('aria-pressed', String(top)); target.textContent = top ? 'Perspective' : 'Top view'; scene?.setView?.(top ? 'top' : 'perspective'); return; }
      if (action === 'camera') { scene?.resetCamera?.(); return; }
      if (action === 'export') { download(`QuickPrint-${snapshot.scenario.name.replace(/[^a-z0-9_-]/gi, '-')}.json`, layoutDraft || snapshot.scenario); toast('Scenario exported.'); return; }
      busy = true;
      try {
        if (action === 'play') await mutate('/control', { action: snapshot.running ? 'pause' : 'play' });
        else if (action === 'step') await mutate('/control', { action: 'step', minutes: 5 });
        else if (action === 'reset') {
          await pauseForEdit();
          showDialog('Reset this simulation?', 'Keep your farm configuration and start again from minute zero.', '<p class="sim-full-note">This clears the current simulated progress, metrics and event log. Production jobs and printers are unaffected.</p>', () => mutate('/control', { action: 'reset' }), { saveLabel: 'Reset simulation', reset: false });
        }
        else if (action === 'farm') await editFarm();
        else if (action === 'add-printer' || action === 'edit-printer') await editPrinter(id);
        else if (action === 'add-clearer' || action === 'edit-clearer') await editClearer(id);
        else if (action === 'add-job' || action === 'edit-job') await editJob(id);
        else if (action === 'routing') await editRouting();
        else if (action === 'templates') await templates();
        else if (action === 'fault') {
          if (layoutDraft) throw new Error('Apply or cancel your layout changes before testing equipment.');
          await mutate('/fault', { type: target.dataset.fault, printerId: id });
        }
        else if (action === 'layout') {
          await pauseForEdit();
          if (sceneFailed) { toast('3D dragging is unavailable. Use Configure in the equipment list to change positions.'); return; }
          layoutDraft = getScenario();
        }
        else if (action === 'cancel-layout') layoutDraft = null;
        else if (action === 'save-layout') { const scenario = layoutDraft; if (scenario) { await saveScenario(scenario); layoutDraft = null; toast('Layout applied. Simulation reset.'); } }
        else if (action === 'import') { await pauseForEdit(); $('[data-sim-import]').click(); }
      } catch (error) { toast(error.message, true); }
      finally { busy = false; render(); }
    }

    async function onChange(event) {
      if (event.target.matches('[data-sim-speed]')) {
        try { await mutate('/control', { action: snapshot.running ? 'play' : 'pause', speed: Number(event.target.value) }); }
        catch (error) { toast(error.message, true); }
      }
      if (event.target.matches('[data-sim-import]')) {
        const file = event.target.files[0]; event.target.value = ''; if (!file) return;
        try {
          if (file.size > 1024 * 1024) throw new Error('Scenario JSON must be smaller than 1 MB.');
          const scenario = JSON.parse(await file.text());
          showDialog('Import this scenario?', `Replace the current farm with “${String(scenario.name || file.name)}”.`, `<p class="sim-full-note">${esc(file.name)} · ${Array.isArray(scenario.printers) ? scenario.printers.length : 0} printers · ${Array.isArray(scenario.jobs) ? scenario.jobs.length : 0} jobs. Configuration is validated before it replaces your current scenario.</p>`, () => saveScenario(scenario), { saveLabel: 'Import & reset simulation' });
        } catch (error) { toast(error.message, true); }
      }
    }

    container.addEventListener('click', onClick);
    container.addEventListener('change', onChange);
    initializeScene();
    void refresh();
    polling = setInterval(() => { if (!document.hidden && !busy) void refresh(); }, 1000);
    return { dispose() { disposed = true; clearInterval(polling); closeDialog(); scene?.dispose?.(); container.removeEventListener('click', onClick); container.removeEventListener('change', onChange); } };
  }
  window.QuickPrintSimulation = { mount };
})();
