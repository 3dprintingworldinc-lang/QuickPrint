'use strict';

(() => {
  const token = document.querySelector('meta[name="quickprint-token"]')?.content || '';
  const $ = (selector, parent = document) => parent.querySelector(selector);
  const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const paths = {
    overview: '<rect x="3" y="3" width="7" height="7" rx="1.3"/><rect x="14" y="3" width="7" height="7" rx="1.3"/><rect x="3" y="14" width="7" height="7" rx="1.3"/><rect x="14" y="14" width="7" height="7" rx="1.3"/>',
    jobs: '<path d="M8 4H5a1 1 0 0 0-1 1v15a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1h-3"/><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M8 11h8M8 16h5"/>',
    printer: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M5 7h14M5 17h14M9 12h6M12 7v5M9 17v-3h6v3M16 20h1"/>',
    inputs: '<path d="M4 4h16v16H4zM4 13h4l2 3h4l2-3h4M12 3v8M9 8l3 3 3-3"/>',
    settings: '<path d="m10 3-1 3-3 1-3 3 2 2-1 3 3 3 3-1 2 2 3-1 1-3 3-1v-4l-3-1-1-3-3 1-2-2Z"/><circle cx="11" cy="11" r="3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M7 3v4M17 3v4M7 14h2M13 14h2"/>',
    upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/>',
    file: '<path d="M14 2H5v20h14V7l-5-5Z"/><path d="M14 2v6h5M8 13h8M8 17h5"/>',
    cube: '<path d="m12 2 9 5v10l-9 5-9-5V7l9-5Z"/><path d="m3 7 9 5 9-5M12 12v10M7 4.8l9 5v5"/>',
    folder: '<path d="M3 20V4h7l2 3h9v13H3Z"/><path d="M3 10h18"/>',
    mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m3 6 9 7 9-7"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/>',
    network: '<rect x="8" y="2" width="8" height="6" rx="1"/><rect x="2" y="17" width="7" height="5" rx="1"/><rect x="15" y="17" width="7" height="5" rx="1"/><path d="M12 8v5M5.5 17v-4h13v4"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/>',
    alert: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5M12 17h.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
    shield: '<path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6l9-4Z"/><path d="m8 12 3 3 5-6"/>',
    edit: '<path d="m16 3 5 5-12 12-6 1 1-6L16 3ZM13 6l5 5"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
    play: '<path d="m8 4 12 8-12 8V4Z"/>',
    pause: '<path d="M8 4v16M16 4v16"/>',
    stop: '<rect x="5" y="5" width="14" height="14" rx="1"/>',
    download: '<path d="M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5"/>',
    copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
    spark: '<path d="m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5L12 2Z"/>',
  };
  const icon = (name, extra = '') => `<svg ${extra} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.file}</svg>`;
  const navItems = [['overview', 'Overview', 'overview'], ['jobs', 'Jobs', 'jobs'], ['printers', 'Printers', 'printer'], ['inputs', 'Inputs', 'inputs'], ['settings', 'Settings', 'settings']];
  let state = null;
  let page = 'overview';
  let jobFilter = 'all';
  let jobSearch = '';
  let refreshQueue = Promise.resolve();
  let pendingRefreshes = 0;
  let connected = false;
  let modalBusy = false;
  let lastFocus = null;
  let uploadFiles = [];
  let integrationData = null;
  let settingsDirty = false;
  let lastPage = null;
  const activeStates = new Set(['preparing', 'dispatching', 'printing', 'paused']);
  const attentionStates = new Set(['needs_attention', 'failed']);
  const statusNames = { review: 'Needs review', preparing: 'Preparing', ready: 'Ready to print', dispatching: 'Starting print', printing: 'Printing', paused: 'Paused', needs_attention: 'Needs attention', completed: 'Completed', cancelled: 'Cancelled', failed: 'Failed', idle: 'Available', offline: 'Offline', error: 'Connection issue', unknown: 'Not checked' };
  const typeNames = { octoprint: 'OctoPrint', moonraker: 'Klipper / Moonraker', bambu: 'Bambu Lab', duet: 'Duet / RepRapFirmware' };
  const sourceLabel = source => sourceNames[source] || sourceNames[String(source || '').split(':')[0]] || source || 'Manual upload';
  const sourceNames = { manual: 'Manual upload', upload: 'Manual upload', web: 'Website', website: 'Website', api: 'Website API', folder: 'Watched folder', email: 'Email' };
  const badge = status => `<span class="badge ${esc(status)}"><span class="status-dot" style="background:currentColor;width:4px;height:4px"></span>${esc(statusNames[status] || status || 'Unknown')}</span>`;
  const readable = value => typeof value === 'string' ? value : (value?.name || value?.email || '—');
  const quantity = job => Number(job.quantity) || 1;
  const accepted = job => Number(job.acceptedQuantity) || 0;
  const dateTime = value => {
    if (!value || !Number.isFinite(new Date(value).getTime())) return '—';
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value));
  };
  const relativeTime = value => {
    if (!value || !Number.isFinite(new Date(value).getTime())) return 'Not yet';
    const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
    if (seconds < 60) return 'Just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return dateTime(value);
  };
  const filesize = bytes => Number(bytes) > 1048576 ? `${(Number(bytes) / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(Number(bytes) / 1024))} KB`;
  const extension = filename => String(filename || '').split('.').pop().toUpperCase().slice(0, 5) || 'FILE';
  const jobById = id => state?.jobs?.find(job => job.id === id);
  const printerById = id => state?.printers?.find(printer => printer.id === id);
  const supports = (printer, capability) => printer?.capabilities?.[capability] ?? state?.adapterCatalog?.find(item => item.type === printer?.type)?.capabilities?.[capability] ?? false;
  const connectorById = id => state?.connectors?.find(connector => connector.id === id);
  const attr = value => esc(value);
  const idPath = id => encodeURIComponent(id);

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${token}`);
    if (options.body && !(options.body instanceof FormData)) {
      headers.set('Content-Type', 'application/json');
      options.body = JSON.stringify(options.body);
    }
    const response = await fetch(path, { ...options, headers, cache: 'no-store' });
    if (!response.ok) {
      let message = `Request failed (${response.status})`;
      let code;
      try { const error = await response.json(); message = error.message || error.error || message; code = error.error; } catch {}
      const error = new Error(message); error.code = code; error.status = response.status; throw error;
    }
    if (response.status === 204) return null;
    return response.json();
  }

  function refresh({ silent = false } = {}) {
    // Background polling can share a pending refresh. An explicit refresh
    // after a mutation must always fetch again: an in-flight response may
    // have captured state before that mutation, even if it arrives later.
    if (silent && pendingRefreshes > 0) return refreshQueue;
    pendingRefreshes += 1;
    refreshQueue = refreshQueue.catch(() => {}).then(async () => {
      try { await fetchState({ silent }); }
      finally { pendingRefreshes -= 1; }
    });
    return refreshQueue;
  }

  async function fetchState({ silent }) {
    try {
      state = await api('/api/state');
      state.jobs ||= []; state.printers ||= []; state.connectors ||= []; state.events ||= []; state.settings ||= {};
      connected = true;
      $('#connection-error').hidden = true;
      $('#connection-status').innerHTML = '<span class="status-dot teal"></span>Workspace online';
      $('#sidebar-site').textContent = state.settings.siteName || 'My print workspace';
      $('#app-version').textContent = state.version ? `Version ${state.version}` : 'Desktop workspace';
      $('#footer-version').textContent = state.version || '';
      renderNavigation();
      if (!(page === 'settings' && (settingsDirty || lastPage === 'settings'))) renderPage();
    } catch (error) {
      connected = false;
      $('#connection-status').innerHTML = '<span class="status-dot red"></span>Connection lost';
      $('#connection-error').hidden = false;
      $('#connection-error').textContent = `Unable to reach your local workspace. ${error.message}. Check that QuickPrint is running, then refresh.`;
      if (!state) $('#main').innerHTML = empty('network', 'Workspace unavailable', 'QuickPrint could not load its local service. Refresh to try the connection again.', '<button class="button primary" data-action="refresh">Try again</button>');
      if (!silent && state) toast(error.message, true);
    }
  }

  function renderNavigation() {
    const queued = state?.jobs.filter(job => !['completed', 'cancelled'].includes(job.status)).length || 0;
    $('#navigation').innerHTML = navItems.map(([key, label, glyph]) => `<a href="#${key}" class="nav-link ${page === key ? 'active' : ''}" ${page === key ? 'aria-current="page"' : ''} aria-label="${label}" title="${label}">${icon(glyph)}<span class="nav-label">${label}</span>${key === 'jobs' && queued ? `<span class="nav-count">${queued}</span>` : ''}</a>`).join('');
    const current = navItems.find(item => item[0] === page);
    $('#breadcrumb-title').textContent = current[1];
    $('#breadcrumb-icon').innerHTML = icon(current[2]);
    document.title = `QuickPrint · ${current[1]}`;
  }

  function navigate() {
    const target = location.hash.replace(/^#/, '').split('/')[0];
    page = navItems.some(item => item[0] === target) ? target : 'overview';
    renderNavigation();
    if (state) renderPage();
  }

  function renderPage() {
    if (!state) return;
    const savedFocus = document.activeElement?.id === 'job-search' ? { id: 'job-search', position: document.activeElement.selectionStart } : null;
    const renders = { overview: renderOverview, jobs: renderJobs, printers: renderPrinters, inputs: renderInputs, settings: renderSettings };
    $('#main').innerHTML = renders[page]();
    lastPage = page;
    if (savedFocus) {
      const input = document.getElementById(savedFocus.id);
      if (input) { input.focus(); input.setSelectionRange(savedFocus.position, savedFocus.position); }
    }
  }

  function heading(title, subtitle, action = '') {
    return `<div class="page-heading"><div><h1>${title}</h1><p>${subtitle}</p></div>${action || `<div class="heading-date">${icon('calendar')}${esc(new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date()))}</div>`}</div>`;
  }

  function empty(glyph, title, description, action = '', compact = false) {
    return `<div class="empty-state ${compact ? 'compact' : ''}"><div class="empty-icon">${icon(glyph)}</div><h3>${title}</h3><p>${description}</p>${action}</div>`;
  }

  const heroArt = `<div class="hero-art" aria-hidden="true"><svg viewBox="0 0 240 170" fill="none"><path d="m25 117 96-54 96 54-96 53-96-53Z" fill="#24464A" stroke="#365E5A"/><path d="m40 129 96-54M65 143l96-54M90 156l96-54M195 129 100 75M170 143 75 89M145 156 50 103" stroke="#325350" stroke-width=".6"/><path d="M61 33 116 3l73 40v92l-55 31-73-41V33Z" fill="#284B4D" stroke="#6A9B86" stroke-width="1.5"/><path d="m61 33 73 40 55-30M134 73v93M61 103l73 41 55-31" stroke="#6A9B86" stroke-width="1.5"/><path d="m71 51 53 29v45L71 96V51Z" fill="#193A3F" stroke="#507C71"/><path d="m144 80 35-20v45l-35 20V80Z" fill="#15363D" stroke="#507C71"/><path d="M97 65v25l16 9V74M97 90l-12 7 24 14 12-7" stroke="#A2D7B4" stroke-width="2"/><path d="m92 101 13-7 15 9v15l-13 7-15-9v-15Z" fill="#78AA8C" stroke="#A6D6AC"/><path d="m92 101 15 9 13-7M107 110v15" stroke="#C0E2BD"/><path d="m70 117 20 11" stroke="#93BCA1" stroke-width="2" stroke-linecap="round"/><circle cx="119" cy="144" r="2" fill="#BFE4AF"/><path d="m175 29 18-10 21 12v24l-18 10-21-12V29Z" fill="#D5E9CD" stroke="#C1E0BA"/><path d="m175 29 21 12 18-10M196 41v24" stroke="#88AD90"/><path d="m187 23 20 12v10l-11 6" stroke="#88AD90"/><circle cx="39" cy="62" r="3" fill="#91BFA0"/><path d="M36 75h6M39 72v6M213 94h6M216 91v6" stroke="#769D87" stroke-width="1.3"/><path d="M38 94v-8M218 73v8" stroke="#517F72" stroke-dasharray="2 3"/></svg></div>`;

  function renderOverview() {
    const active = state.jobs.filter(job => activeStates.has(job.status)).length;
    const waiting = state.jobs.filter(job => ['review', 'ready'].includes(job.status)).length;
    const attention = state.jobs.filter(job => attentionStates.has(job.status)).length;
    const complete = state.jobs.filter(job => job.status === 'completed').length;
    const reachable = state.printers.filter(printer => ['idle', 'printing', 'paused'].includes(printer.status?.state)).length;
    const jobs = [...state.jobs].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).slice(0, 5);
    const first = !state.printers.length || !state.jobs.length;
    const stats = [
      ['Jobs in progress', active, 'printer', active ? 'Currently on your print floor' : 'Ready when you are'],
      ['Waiting in queue', waiting, 'jobs', attention ? `<em>${attention}</em> also need attention` : 'Review and ready-to-print jobs'],
      ['Printers online', `${reachable}<span style="font-size:16px;color:#a0afa1;letter-spacing:0"> / ${state.printers.length}</span>`, 'network', state.printers.length ? 'Based on latest connection check' : 'Connect your first LAN printer'],
      ['Completed jobs', complete, 'check', 'Operator-verified production'],
    ];
    return `${heading('Your print floor, at a glance.', 'From the first file to the final part. Everything in one place.')}
      <section class="hero"><div class="hero-content"><div class="eyebrow">ONE WORKSPACE. EVERY WORKFLOW.</div><h2>${first ? 'Good things start with a connection.' : 'Keep your next great idea moving.'}</h2><p>${first ? 'Bring your printers and incoming files together.<br>QuickPrint takes care of the queue, so you can focus on making.' : 'A shared queue for your files, a clear view of your fleet,<br>and you in control of every print.'}</p><button class="button" data-action="${!state.printers.length ? 'add-printer' : 'upload'}">${icon(!state.printers.length ? 'plus' : 'upload')}${!state.printers.length ? 'Connect a printer' : 'Add your next job'}${icon('arrow')}</button></div>${heroArt}</section>
      <section class="stats-grid" aria-label="Workspace statistics">${stats.map(([label, value, glyph, hint]) => `<article class="stat"><div class="stat-top">${label}<span class="stat-icon">${icon(glyph)}</span></div><div class="stat-value">${value}</div><div class="stat-footer">${hint}</div></article>`).join('')}</section>
      <div class="content-grid"><div class="side-stack" style="display:flex"><section class="panel"><div class="panel-header"><div><h2>Print queue</h2><p class="panel-subtitle">Your latest jobs, from intake to completion</p></div><a class="subtle-link" href="#jobs">View all jobs ${icon('arrow')}</a></div>${jobs.length ? jobTable(jobs, true) : empty('cube', 'A little quiet on the print floor.', 'Add your first file to start building your queue. You’ll review it before anything prints.', `<button class="button soft compact" data-action="upload">${icon('plus')} Add your first job</button>`)}<div class="panel-footer"><span>${state.jobs.length} total ${state.jobs.length === 1 ? 'job' : 'jobs'}</span><span>Every print starts with your confirmation</span></div></section>
      <section class="panel"><div class="panel-header"><div><h2>Recent activity</h2><p class="panel-subtitle">What’s happening across your workspace</p></div>${icon('clock', 'style="width:15px;height:15px;color:#9baa9b"')}</div>${renderActivity()}</section></div>
      <div class="side-stack"><section class="panel"><div class="panel-header"><h2>Your fleet</h2><span class="mini-label"><span class="status-dot green"></span>${state.printers.length} connected</span></div>${state.printers.length ? `<div class="checklist">${state.printers.slice(0, 4).map(printer => `<div class="check-step"><span class="printer-avatar" style="width:31px;height:31px;border-radius:7px">${icon('printer', 'style="width:19px;height:19px"')}</span><div class="step-info"><strong>${esc(printer.name)}</strong><small>${esc(typeNames[printer.type] || printer.type)}</small></div>${badge(printer.status?.state || 'unknown')}</div>`).join('')}</div><div class="panel-footer"><a class="subtle-link" href="#printers">Manage printers ${icon('arrow')}</a></div>` : empty('printer', 'Make room for your makers.', 'Connect a printer on your local network to bring your fleet to life.', '<button class="button compact" data-action="add-printer">Connect a printer</button>', true)}</section>
      <section class="panel"><div class="panel-header"><h2>Make yourself at home</h2><span class="muted" style="font-size:9px">${[state.printers.length > 0, state.jobs.length > 0, state.connectors.length > 0 || state.settings.intake?.enabled].filter(Boolean).length} of 3</span></div><div class="checklist">${[[state.printers.length > 0, 'Connect your first printer', 'Start with your local network.', 'add-printer'], [state.jobs.length > 0, 'Add something to make', 'Upload a model or a sliced file.', 'upload'], [state.connectors.length > 0 || state.settings.intake?.enabled, 'Give your files a way in', 'Connect a folder, inbox, or website.', 'go-inputs']].map(([done, title, hint, action], index) => `<div class="check-step"><span class="step-number ${done ? 'done' : ''}">${done ? icon('check') : index + 1}</span><div class="step-info"><strong>${title}</strong><small>${hint}</small></div><button class="step-arrow" data-action="${action}" aria-label="${title}">${icon('chevron')}</button></div>`).join('')}</div></section>
      <div class="workflow-note"><div class="eyebrow">${icon('spark')} A WORKFLOW THAT FITS YOU</div><h3>More ways to get to making.</h3><p>A folder on your PC. A makerspace inbox. A customer’s web order. Different starting points, one organized queue.</p></div></div></div>`;
  }

  function renderActivity() {
    const events = [...state.events].reverse().slice(0, 4);
    if (!events.length) return '<div class="panel-content"><p class="muted" style="font-size:11px;line-height:1.8">Your workspace is ready for its first chapter. Printer connections, new files, and job updates will appear here.</p></div>';
    return `<div class="activity-list">${events.map(event => `<div class="activity-item"><span class="activity-icon">${icon(event.level === 'error' ? 'alert' : 'check')}</span><div><p>${esc(event.message || event.type)}</p><time>${esc(relativeTime(event.createdAt || event.at || event.timestamp))}</time></div></div>`).join('')}</div>`;
  }

  function jobTable(jobs, compact = false) {
    return `<div class="table-wrap"><table class="jobs-table"><thead><tr><th scope="col">Job / file</th><th scope="col">Status</th>${compact ? '' : '<th scope="col">Source</th><th scope="col">Printer</th>'}<th scope="col">Accepted</th><th scope="col">Updated</th><th scope="col"><span class="visually-hidden">Open job</span></th></tr></thead><tbody>${jobs.map(job => `<tr><td><div class="file-cell"><span class="file-icon">${esc(extension(job.fileName))}</span><div><button class="file-name" data-action="job" data-id="${attr(job.id)}">${esc(job.name || job.fileName)}</button><div class="file-sub">${esc(readable(job.customer) === '—' ? job.fileName : readable(job.customer))}</div></div></td><td>${badge(job.status)}</td>${compact ? '' : `<td><span class="muted">${esc(sourceLabel(job.source))}</span></td><td>${esc(printerById(job.printerId)?.name || 'Unassigned')}</td>`}<td><span class="muted">${accepted(job)} / ${quantity(job)}</span></td><td><span class="muted">${esc(relativeTime(job.updatedAt || job.createdAt))}</span></td><td><button class="icon-button" data-action="job" data-id="${attr(job.id)}" aria-label="Open ${attr(job.name || job.fileName)}">${icon('chevron')}</button></td></tr>`).join('')}</tbody></table></div>`;
  }

  function filteredJobs() {
    return state.jobs.filter(job => {
      const matchesFilter = jobFilter === 'all' || (jobFilter === 'active' ? activeStates.has(job.status) : jobFilter === 'attention' ? attentionStates.has(job.status) : job.status === jobFilter);
      return matchesFilter && (!jobSearch || [job.name, job.fileName, readable(job.customer), job.id].join(' ').toLowerCase().includes(jobSearch.toLowerCase()));
    }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  function renderJobs() {
    const jobs = filteredJobs();
    return `${heading('A place for every print.', 'Review incoming files, prepare jobs, and follow every copy through production.', `<button class="button primary" data-action="upload">${icon('plus')} New job</button>`)}
      <div class="page-toolbar"><div class="tabs" role="tablist" aria-label="Filter jobs">${[['all', 'All jobs'], ['review', 'Review'], ['ready', 'Ready'], ['active', 'Active'], ['attention', 'Attention'], ['completed', 'Completed']].map(([key, label]) => `<button class="tab ${jobFilter === key ? 'active' : ''}" data-action="filter" data-filter="${key}" role="tab" aria-selected="${jobFilter === key}">${label}</button>`).join('')}</div><label class="search-box">${icon('search')}<input id="job-search" type="search" placeholder="Search jobs or customers…" aria-label="Search jobs" value="${attr(jobSearch)}"></label></div>
      <section class="panel">${jobs.length ? jobTable(jobs) : empty('jobs', state.jobs.length ? 'Nothing in this view.' : 'Your next creation starts here.', state.jobs.length ? 'Try another filter or search term to find the job you’re looking for.' : 'Upload model files or printer-ready files. Every new job starts in review.', state.jobs.length ? '<button class="button compact" data-action="clear-filters">Clear filters</button>' : `<button class="button soft" data-action="upload">${icon('upload')} Add your first job</button>`)}<div class="panel-footer"><span>${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'} in this view</span><span>Accepted copies / requested copies</span></div></section>`;
  }

  function renderPrinters() {
    return `${heading('Your fleet. In good company.', 'Connect the printers on your local network and keep their capabilities in view.', `<button class="button primary" data-action="add-printer">${icon('plus')} Add printer</button>`)}
      <div class="printer-grid">${state.printers.map(printer => {
        const status = printer.status || {};
        return `<article class="printer-card"><div class="printer-card-top"><span class="printer-avatar">${icon('printer')}</span><div class="printer-info"><h3>${esc(printer.name)}</h3><p>${esc(typeNames[printer.type] || printer.type)}${printer.model ? ` · ${esc(printer.model)}` : ''}</p></div><button class="icon-button" data-action="edit-printer" data-id="${attr(printer.id)}" aria-label="Edit ${attr(printer.name)}">${icon('edit')}</button></div><div class="printer-card-body">${badge(status.state || 'unknown')}<div class="printer-address">${icon('network')}${esc(printer.host)}${printer.port ? `:${esc(printer.port)}` : ''}</div>${['printing', 'paused'].includes(status.state) ? `<div class="panel-subtitle">${esc(status.currentFile || 'Print in progress')} · ${Math.max(0, Math.min(100, Number(status.progress) || 0)).toFixed(0)}%</div><div class="progress"><span style="width:${Math.max(0, Math.min(100, Number(status.progress) || 0))}%"></span></div>` : ''}<p class="printer-note">${esc(status.message || 'Test the connection to check availability and LAN access.')}</p></div><div class="printer-card-footer"><span class="muted" style="font-size:9px">${esc(status.observedAt ? `Checked ${relativeTime(status.observedAt)}` : 'Not checked yet')}</span><div class="button-row"><button class="button small" data-action="test-printer" data-id="${attr(printer.id)}">${icon('refresh')} Test</button><button class="icon-button danger" data-action="remove-printer" data-id="${attr(printer.id)}" aria-label="Remove ${attr(printer.name)}">${icon('trash')}</button></div></div></article>`;
      }).join('')}<button class="add-printer-card" data-action="add-printer">${icon('plus')}<strong>${state.printers.length ? 'Grow your fleet' : 'Connect your first printer'}</strong><span style="font-size:10px">Add a printer by local address</span></button></div>
      <div class="capabilities-note">${icon('info')}<div><strong>Different printers, one workspace.</strong><p>QuickPrint uses protocol adapters for OctoPrint, Klipper / Moonraker, Bambu LAN, and Duet. Your printer must expose a supported LAN protocol. Features and file formats depend on the adapter, model, and firmware. Start with a connection test before preparing your first job.</p></div></div>`;
  }

  function runtimeConnector(id) {
    const statuses = Array.isArray(state.connectorStatus) ? state.connectorStatus : (state.connectorStatus?.connectors || []);
    return statuses.find(item => item.id === id) || {};
  }

  function renderInputs() {
    return `${heading('Let the work come to you.', 'Different ways in. One reliable queue for your files and customer orders.')}
      <div class="input-cards"><article class="input-card"><div class="input-card-icon">${icon('globe')}</div><h2>Website orders</h2><p>Send customer files, quantities, and order details straight to QuickPrint through your intake API.</p><button class="button" data-action="integration">${icon('network')} ${state.settings.intake?.enabled ? 'View integration' : 'Set up intake API'}</button></article><article class="input-card"><div class="input-card-icon">${icon('folder')}</div><h2>A folder on your PC</h2><p>Drop a model or sliced file into a watched folder. QuickPrint will pick it up when the file is ready.</p><button class="button" data-action="add-folder">${icon('plus')} Connect a folder</button></article><article class="input-card"><div class="input-card-icon">${icon('mail')}</div><h2>Your makerspace inbox</h2><p>Import supported attachments from a dedicated mailbox, with the sender and subject kept alongside.</p><button class="button" data-action="add-email">${icon('plus')} Connect a mailbox</button></article></div>
      <section class="panel"><div class="panel-header"><div><h2>Connected inputs</h2><p class="panel-subtitle">Your folders and mailboxes, working in the background</p></div><span class="mini-label">${state.connectors.filter(connector => connector.enabled).length} enabled</span></div>${state.connectors.length ? state.connectors.map(connector => { const runtime = runtimeConnector(connector.id); return `<div class="connector-row"><span class="icon">${icon(connector.type === 'email' ? 'mail' : 'folder')}</span><div class="connector-main"><strong>${esc(connector.name)}</strong><p>${esc(connector.type === 'email' ? `${connector.username || ''} · ${connector.mailbox || 'INBOX'}` : connector.path)}</p><p${runtime.error ? ' class="danger-text"' : ''}>${esc(runtime.error || (runtime.lastCheckedAt ? `Checked ${relativeTime(runtime.lastCheckedAt)}${runtime.importedCount ? ` · ${runtime.importedCount} imported` : ''}` : 'Waiting for first check'))}</p></div><span class="badge ${runtime.error ? 'error' : connector.enabled ? 'ready' : ''}">${runtime.error ? 'Needs attention' : connector.enabled ? 'Enabled' : 'Disabled'}</span><div class="connector-actions"><button class="icon-button" data-action="poll-connector" data-id="${attr(connector.id)}" aria-label="Check ${attr(connector.name)} now" title="Check now">${icon('refresh')}</button><button class="icon-button" data-action="edit-connector" data-id="${attr(connector.id)}" aria-label="Edit ${attr(connector.name)}">${icon('edit')}</button><button class="icon-button danger" data-action="remove-connector" data-id="${attr(connector.id)}" aria-label="Remove ${attr(connector.name)}">${icon('trash')}</button></div></div>`; }).join('') : empty('inputs', 'Your files can find their own way.', 'Connect a folder or mailbox above to bring incoming files into your queue automatically.', '', true)}</section>
      <div class="capabilities-note">${icon('shield')}<div><strong>Intake brings files in. You decide what prints.</strong><p>New files always enter review. QuickPrint never starts a physical print just because a file arrived. Keep this PC running for background intake, and choose a dedicated folder or mailbox to keep submissions organized.</p></div></div>`;
  }

  function field(name, label, value = '', { type = 'text', placeholder = '', hint = '', required = false, full = false, extra = '', textarea = false, rows = 3 } = {}) {
    const id = `field-${name.replace(/[^a-z0-9-]/gi, '-')}`;
    const input = textarea ? `<textarea id="${id}" name="${name}" rows="${rows}" placeholder="${attr(placeholder)}" ${required ? 'required' : ''} ${extra}>${esc(value)}</textarea>` : `<input id="${id}" name="${name}" type="${type}" value="${attr(value)}" placeholder="${attr(placeholder)}" ${required ? 'required' : ''} ${extra}>`;
    return `<div class="field ${full ? 'full' : ''}"><label for="${id}">${label}${required ? ' <span aria-hidden="true">*</span>' : ''}</label>${input}${hint ? `<div class="field-hint">${hint}</div>` : ''}</div>`;
  }

  function profileHint(kind) {
    return kind === 'prusa' ? 'One or more exported PrusaSlicer INI profiles, one absolute path per line.' : 'Exactly three exported JSON profiles in this order: machine, process, then filament. One absolute path per line.';
  }

  function renderSettings() {
    const settings = state.settings;
    const slicer = settings.slicer || {};
    settingsDirty = false;
    return `${heading('Make QuickPrint your own.', 'Set your workspace defaults and connect the tools that prepare your prints.')}
      <div class="settings-layout"><form id="settings-form"><div id="settings-error" class="inline-notice error form-error" role="alert"></div><section class="panel settings-section"><div class="panel-header"><div><h2>Your workspace</h2><p class="panel-subtitle">The name and rhythm of your print floor</p></div></div><div class="panel-content"><div class="form-grid">${field('siteName', 'Workspace name', settings.siteName || 'QuickPrint', { required: true, placeholder: 'Riverside Makerspace' })}${field('pollSeconds', 'Printer status refresh (seconds)', Math.round((settings.pollIntervalMs || 10000) / 1000), { type: 'number', required: true, extra: 'min="2" max="3600" step="1"', hint: 'How often QuickPrint checks configured printers.' })}</div></div></section>
      <section class="panel settings-section"><div class="panel-header"><div><h2>File preparation</h2><p class="panel-subtitle">Use an installed slicer to turn models into printer-ready files</p></div></div><div class="panel-content"><div class="form-grid"><div class="field"><label for="slicer-kind">Slicer</label><select id="slicer-kind" name="slicerKind"><option value="orca" ${slicer.kind === 'orca' || !slicer.kind ? 'selected' : ''}>OrcaSlicer</option><option value="bambu" ${slicer.kind === 'bambu' ? 'selected' : ''}>Bambu Studio</option><option value="prusa" ${slicer.kind === 'prusa' ? 'selected' : ''}>PrusaSlicer</option></select></div><div class="field"><label for="slicer-executable">Executable path</label><div class="field-row"><input id="slicer-executable" name="slicerExecutable" value="${attr(slicer.executable || '')}" placeholder="C:\\Program Files\\OrcaSlicer\\orca-slicer.exe"><button type="button" class="button" data-action="browse-slicer" aria-label="Browse for slicer executable">${icon('folder')}</button></div><p class="field-hint">Select the installed slicer executable on this PC.</p></div>${field('profilePaths', 'Slicing profile paths', (slicer.profilePaths || []).join('\n'), { textarea: true, full: true, rows: 4, placeholder: 'C:\\QuickPrint\\profiles\\machine.json\nC:\\QuickPrint\\profiles\\process.json\nC:\\QuickPrint\\profiles\\filament.json', hint: `<span id="profile-hint">${profileHint(slicer.kind || 'orca')}</span>` })}<div class="full"><button type="button" class="button compact" data-action="browse-profiles">${icon('folder')} Choose profile files</button></div><details class="advanced"><summary>Advanced slicing arguments</summary><div class="form-grid">${field('extraArgs', 'Additional arguments', (slicer.extraArgs || []).join('\n'), { textarea: true, full: true, hint: 'One argument per line. Arguments are passed directly to the executable without a shell. Output and input paths are managed by QuickPrint.' })}</div></details></div><div class="inline-notice no-margin">${icon('info')}<div>Already sliced files do not need an installed slicer. Use STL, 3MF, or OBJ models; STEP / STP needs a STEP-capable slicer. Other native CAD formats need export first. Use profiles that match the printer, nozzle, and material.</div></div></div></section><div class="form-actions"><button type="button" class="button" data-action="reset-settings">Discard changes</button><button type="submit" class="button primary">${icon('check')} Save settings</button></div></form>
      <aside class="settings-aside"><h3>Your workshop stays yours.</h3><p>Jobs, imported files, printer settings, and connector checkpoints live in your local QuickPrint data folder. Keep a backup of this folder when moving computers.</p><button class="button wide" data-action="open-data">${icon('folder')} Open workspace data folder</button><button class="button wide mt-16" data-action="export-backup">${icon('download')} Export workspace backup</button><p class="field-hint">Stop active jobs before exporting. To restore, quit QuickPrint and follow the backup instructions in the user guide. Credentials stay tied to their original machine/user; re-enter them after moving PCs.</p><div class="divider" style="margin:22px 0"></div><h3>Connecting a website?</h3><p>Enable the intake API in Inputs to receive orders. It uses a separate access token and never exposes desktop administration.</p><a class="button wide" href="#inputs">Go to Inputs ${icon('arrow')}</a><div class="divider" style="margin:22px 0"></div><h3>Printer profiles matter.</h3><p class="no-margin">A prepared file is tied to its printer and profile. If you change printers, prepare the job again before starting a print.</p></aside></div>`;
  }

  function openModal(title, subtitle, body, footer = '', large = false) {
    lastFocus = document.activeElement;
    $('#modal-root').innerHTML = `<div class="modal-backdrop"><section class="modal ${large ? 'large' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title" aria-describedby="modal-subtitle"><header class="modal-header"><div><h2 id="modal-title">${title}</h2><p id="modal-subtitle">${subtitle}</p></div><button class="icon-button" data-action="close-modal" aria-label="Close dialog">${icon('close')}</button></header><div class="modal-body"><div id="modal-error" class="inline-notice error form-error" role="alert"></div>${body}</div>${footer ? `<footer class="modal-footer">${footer}</footer>` : ''}</section></div>`;
    document.body.style.overflow = 'hidden';
    modalBusy = false;
    requestAnimationFrame(() => ($('#modal-root input:not([type=hidden])') || $('#modal-root select') || $('#modal-root button'))?.focus());
  }

  function closeModal() {
    if (modalBusy) return;
    $('#modal-root').innerHTML = '';
    document.body.style.overflow = '';
    integrationData = null;
    uploadFiles = [];
    if (lastFocus?.isConnected) lastFocus.focus();
  }

  function footerSubmit(form, label, glyph = 'check') {
    return `<button type="button" class="button" data-action="close-modal">Cancel</button><button type="submit" form="${form}" class="button primary">${icon(glyph)}${label}</button>`;
  }

  function modalError(error) {
    const target = $('#modal-error');
    if (target) { target.textContent = error.message || String(error); target.scrollIntoView({ block: 'nearest' }); }
    else toast(error.message || String(error), true);
  }

  function setBusy(busy, form = null) {
    modalBusy = busy;
    const parent = form || $('#modal-root');
    $$('button[type="submit"]', parent).forEach(button => { button.disabled = busy; });
    if (form?.id) $$(`button[form="${form.id}"]`).forEach(button => { button.disabled = busy; });
    if (busy && $('#modal-error')) $('#modal-error').textContent = '';
  }

  function uploadModal() {
    uploadFiles = [];
    openModal('Something new to make.', 'Add files to your queue. Each file becomes a separate job for review.', `<form id="upload-form" data-source-id="${attr(crypto.randomUUID())}"><label class="dropzone" id="upload-dropzone">${icon('upload')}<strong>Drop your files here, or click to browse</strong><p>Models: STL, 3MF, OBJ, STEP / STP · Prepared: G-code, G-code.3MF<br>STEP / STP requires a STEP-capable slicer; other native CAD formats need export.</p><input id="upload-files" type="file" name="files" multiple required aria-label="Choose print files"></label><div id="selected-files" class="selected-files"></div><div class="form-grid">${field('name', 'Job / order name', '', { placeholder: 'Optional — defaults to the file name' })}${field('customer', 'Customer or project', '', { placeholder: 'Who are we making this for?' })}${field('quantity', 'Copies per file', 1, { type: 'number', required: true, extra: 'min="1" max="10000" step="1"', hint: 'Each confirmed print run produces one copy.' })}${field('notes', 'Print requirements', '', { textarea: true, full: true, placeholder: 'Material, colour, due date, or anything the operator should know.' })}</div></form>`, footerSubmit('upload-form', 'Add to queue', 'upload'));
    const zone = $('#upload-dropzone');
    for (const eventName of ['dragenter', 'dragover']) zone.addEventListener(eventName, event => { event.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', event => { event.preventDefault(); zone.classList.remove('dragover'); uploadFiles = [...event.dataTransfer.files]; $('#upload-files').required = !uploadFiles.length; renderSelectedFiles(); });
  }

  function renderSelectedFiles() {
    $('#selected-files').innerHTML = uploadFiles.map(file => `<div class="selected-file"><span>${esc(file.name)}</span><small>${filesize(file.size)}</small></div>`).join('');
  }

  function printerAuth(type, printer = {}) {
    if (type === 'bambu') return `${field('serial', 'Printer serial number', printer.serial || '', { required: true, placeholder: 'From the printer’s device information' })}${field('accessCode', 'LAN access code', '', { type: 'password', required: !printer.hasAccessCode && !printer.id, extra: 'autocomplete="new-password"', placeholder: printer.hasAccessCode ? 'Saved — leave blank to keep' : 'From the printer’s LAN settings' })}<details class="advanced" open><summary>Bambu certificate trust</summary><div class="form-grid">${field('tlsFingerprint', 'Trusted SHA-256 certificate fingerprint', printer.tlsFingerprint || '', { full: true, placeholder: '64 hexadecimal characters; colons are accepted', hint: 'Verify the fingerprint of the printer’s certificate through a trusted channel. QuickPrint does not bypass TLS verification.' })}${field('caCertificate', 'Or provide the trusted CA certificate (PEM)', printer.caCertificate || '', { textarea: true, full: true, placeholder: '-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----', rows: 3, hint: 'A trusted certificate or fingerprint is required for the encrypted LAN connection.' })}</div></details>`;
    const trust = `<details class="advanced"><summary>HTTPS certificate trust (optional)</summary><div class="form-grid">${field('caCertificate', 'Trusted CA certificate (PEM)', printer.caCertificate || '', { textarea: true, full: true, placeholder: '-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----', hint: 'For an HTTPS endpoint with a private certificate authority. Normal publicly trusted certificates need no extra configuration.' })}${field('tlsFingerprint', 'Or a verified SHA-256 certificate fingerprint', printer.tlsFingerprint || '', { full: true, placeholder: '64 hexadecimal characters; colons are accepted', hint: 'Verify the fingerprint independently before trusting it. Certificate verification is never silently disabled.' })}</div></details>`;
    if (type === 'duet') return field('password', 'Duet password', '', { type: 'password', full: true, extra: 'autocomplete="new-password"', placeholder: printer.hasPassword ? 'Saved — leave blank to keep' : 'If required by your Duet controller', hint: 'Use the password configured on the printer’s RepRapFirmware HTTP server.' }) + trust;
    return field('apiKey', type === 'octoprint' ? 'OctoPrint application API key' : 'Moonraker API key', '', { type: 'password', full: true, extra: 'autocomplete="new-password"', placeholder: printer.hasApiKey ? 'Saved — leave blank to keep' : type === 'octoprint' ? 'From OctoPrint → Settings → Application Keys' : 'Optional if your local network is trusted by Moonraker', hint: 'Stored locally and never shown back in the interface. Leave blank to retain an existing key.' }) + trust;
  }

  function printerHint(type) {
    const catalog = Array.isArray(state?.adapterCatalog) ? state.adapterCatalog : [];
    const requirement = catalog.find(item => item.type === type)?.requirements;
    if (requirement) return esc(requirement);
    const hints = { octoprint: 'Connect to an OctoPrint server with printer controls enabled. Usually port 80 or 5000.', moonraker: 'Connect to the Moonraker API on a Klipper host, usually port 7125. Network authorization must allow this PC.', bambu: 'Initial support targets single-nozzle Bambu X1 / P1 models. Enable supported LAN / Developer access; firmware must permit MQTT and encrypted FTPS. Supply a verified certificate or fingerprint below.', duet: 'Connect to a Duet controller running supported RepRapFirmware HTTP APIs. Controller firmware determines available controls.' };
    return hints[type] || '';
  }

  function printerModel(type, model = '') {
    if (type !== 'bambu') return field('model', 'Model (optional)', model, { full: true, placeholder: 'e.g. MK4, Voron 2.4' });
    return `<div class="field full"><label for="printer-model">Bambu model <span aria-hidden="true">*</span></label><select id="printer-model" name="model" required><option value="">Choose your supported model</option>${['X1', 'X1C', 'X1E', 'P1P', 'P1S'].map(value => `<option value="${value}" ${model.toUpperCase() === value ? 'selected' : ''}>${value}</option>`).join('')}</select><p class="field-hint">Direct control supports these single-nozzle models, single-plate prepared .gcode.3mf files, and the external spool. AMS and dual-nozzle models are not supported.</p></div>`;
  }

  function printerSlicer(printer) {
    const configured = Boolean(printer.slicer && Object.keys(printer.slicer).length);
    const slicer = configured ? printer.slicer : (state.settings.slicer || {});
    const kind = slicer.kind || 'orca';
    return `<details class="advanced" ${configured ? 'open' : ''}><summary>Printer-specific slicing profiles</summary><label class="checkbox-field mt-16"><input type="checkbox" id="printer-custom-slicer" name="customSlicer" ${configured ? 'checked' : ''}><span>Use a dedicated slicer configuration for this printer<small>Recommended for a mixed fleet. Otherwise, this printer uses the defaults in Settings.</small></span></label><fieldset id="printer-slicer-fields" class="form-grid slicer-fieldset" ${configured ? '' : 'disabled'}><div class="field"><label for="printer-slicer-kind">Slicer</label><select id="printer-slicer-kind" name="printerSlicerKind"><option value="orca" ${kind === 'orca' ? 'selected' : ''}>OrcaSlicer</option><option value="bambu" ${kind === 'bambu' ? 'selected' : ''}>Bambu Studio</option><option value="prusa" ${kind === 'prusa' ? 'selected' : ''}>PrusaSlicer</option></select></div><div class="field"><label for="printer-slicer-executable">Executable path</label><div class="field-row"><input id="printer-slicer-executable" name="printerSlicerExecutable" value="${attr(slicer.executable || '')}" placeholder="Absolute path to installed slicer"><button type="button" class="button" data-action="browse-slicer" data-target="printer-slicer-executable" aria-label="Choose printer slicer executable">${icon('folder')}</button></div></div>${field('printerProfilePaths', 'Profile paths for this printer', (slicer.profilePaths || []).join('\n'), { textarea: true, full: true, rows: 4, hint: `<span id="printer-profile-hint">${profileHint(kind)}</span>` })}<div class="full"><button type="button" class="button compact" data-action="browse-profiles" data-target="field-printerProfilePaths">${icon('folder')} Choose profile files</button></div>${field('printerExtraArgs', 'Additional arguments (optional)', (slicer.extraArgs || []).join('\n'), { textarea: true, full: true, rows: 2, hint: 'One argument per line. Use profiles that match this printer, nozzle, and material. Changing the configuration invalidates prepared jobs.' })}</fieldset></details>`;
  }

  function printerModal(id) {
    const printer = printerById(id) || {};
    const type = printer.type || 'octoprint';
    openModal(printer.id ? 'Printer settings' : 'Make a new connection.', 'Add a supported printer using its address on your local network.', `<form id="printer-form" data-id="${attr(printer.id || '')}"><div class="form-grid">${field('name', 'Printer name', printer.name || '', { required: true, placeholder: 'Workshop printer 01' })}<div class="field"><label for="printer-type">Connection type</label><select id="printer-type" name="type">${Object.entries(typeNames).map(([value, label]) => `<option value="${value}" ${type === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div><div class="inline-notice full no-margin" style="grid-column:1/-1"><span id="printer-hint">${printerHint(type)}</span></div>${field('host', 'Local host or URL', printer.host || '', { required: true, placeholder: type === 'bambu' ? '192.168.1.80' : 'http://192.168.1.80', hint: 'Use a stable local IP address or hostname.' })}${field('port', 'Port (optional)', printer.port || '', { type: 'number', extra: 'min="1" max="65535" step="1"', placeholder: 'Use adapter default' })}<div id="printer-model-field" style="grid-column:1/-1">${printerModel(type, printer.model || '')}</div><div id="printer-auth" class="form-grid" style="grid-column:1/-1">${printerAuth(type, printer)}</div>${printerSlicer(printer)}</div></form>`, footerSubmit('printer-form', printer.id ? 'Save printer' : 'Add printer'));
  }

  function connectorModal(type, id) {
    const connector = connectorById(id) || {};
    type = connector.type || type;
    const defaults = connector.defaults || {};
    const folderFields = `<div class="field full"><label for="connector-path">Folder path <span aria-hidden="true">*</span></label><div class="field-row"><input id="connector-path" name="path" required value="${attr(connector.path || '')}" placeholder="C:\\QuickPrint\\Incoming"><button type="button" class="button" data-action="browse-folder" aria-label="Choose watched folder">${icon('folder')}</button></div><p class="field-hint">Use an absolute path on this PC or a network location this user can access. Files directly inside this folder are watched.</p></div>${field('settleSeconds', 'Wait for file to settle (seconds)', (connector.settleMs || 2000) / 1000, { type: 'number', extra: 'min="1" max="300" step="1"', hint: 'Wait for the file size and timestamp to stop changing before importing.' })}`;
    const emailFields = `${field('host', 'IMAP host', connector.host || '', { required: true, placeholder: 'imap.example.com' })}${field('port', 'IMAP port', connector.port || 993, { type: 'number', required: true, extra: 'min="1" max="65535" step="1"' })}${field('username', 'Mailbox username', connector.username || '', { required: true, placeholder: 'prints@yourmakerspace.com', extra: 'autocomplete="username"' })}${field('password', 'App password', '', { type: 'password', required: !connector.id, extra: 'autocomplete="new-password"', placeholder: connector.id ? 'Saved — leave blank to keep' : 'An IMAP-enabled app password', hint: 'Use a provider-supported app password. OAuth-only mailboxes need an external intake bridge.' })}${field('mailbox', 'Mailbox / folder', connector.mailbox || 'INBOX', { required: true, hint: 'Existing supported attachments in this folder are imported on the first check.' })}${field('pollSeconds', 'Check interval (seconds)', (connector.pollIntervalMs || 60000) / 1000, { type: 'number', required: true, extra: 'min="15" max="86400" step="1"' })}<div class="inline-notice full no-margin" style="grid-column:1/-1">${icon('shield')}<span>IMAP uses TLS with certificate verification. QuickPrint reads attachments; it does not send email. Choose a dedicated mailbox or folder for print submissions.</span></div>`;
    openModal(connector.id ? 'Edit input connection' : type === 'folder' ? 'A simple place to drop your files.' : 'Give your inbox a print queue.', type === 'folder' ? 'New supported files appear in review once the copy finishes.' : 'Bring supported CAD and print attachments into your workspace.', `<form id="connector-form" data-id="${attr(connector.id || '')}" data-type="${type}"><div class="form-grid">${field('name', 'Connection name', connector.name || '', { full: true, required: true, placeholder: type === 'folder' ? 'Designers’ incoming files' : 'Makerspace submissions' })}${type === 'folder' ? folderFields : emailFields}<details class="advanced"><summary>Default job details</summary><div class="form-grid">${field('quantity', 'Copies per file', defaults.quantity || 1, { type: 'number', extra: 'min="1" max="10000" step="1"' })}${field('customer', 'Default customer / project', defaults.customer || '')}${field('notes', 'Default print requirements', defaults.notes || '', { textarea: true, full: true })}</div></details><label class="checkbox-field full" style="grid-column:1/-1"><input type="checkbox" name="enabled" ${connector.enabled !== false ? 'checked' : ''}><span>Enable this connection<small>Keep QuickPrint running on this PC to import files in the background.</small></span></label></div></form>`, footerSubmit('connector-form', connector.id ? 'Save connection' : 'Connect input'));
  }

  async function integrationModal() {
    try {
      const result = await api('/api/integration');
      integrationData = result;
      const intake = state.settings.intake || {};
      const urls = result.urls || result.urlHints || (result.url ? [result.url] : []);
      const enabled = result.enabled ?? intake.enabled;
      openModal('A direct line from your website.', 'Send orders into QuickPrint without exposing printer controls.', `<div class="inline-notice ${result.error ? 'error' : ''}">${icon(result.error ? 'alert' : 'network')}<span>${esc(result.error || (result.listening ? 'The LAN intake listener is running.' : enabled ? 'Intake is enabled but the listener is not running. Check the port and local service.' : 'LAN intake is currently disabled. Enable it below when your integration is ready.'))}</span></div><form id="integration-form"><div class="form-grid"><label class="checkbox-field full" style="grid-column:1/-1"><input type="checkbox" name="enabled" ${enabled ? 'checked' : ''}><span>Enable LAN intake<small>Allow token-authenticated file submissions on this computer’s local network.</small></span></label>${field('port', 'Intake port', result.port || intake.port || 9732, { type: 'number', required: true, extra: 'min="1024" max="65535" step="1"' })}</div></form><div class="section-label">INTAKE ENDPOINT</div><div class="code-box">${esc(urls.length ? urls.map(url => typeof url === 'string' ? url : url.url || '').join('\n') : `http://THIS-PC-LAN-IP:${intake.port || 9732}/api/intake`)}</div><p class="field-hint">POST multipart files using the field <code>files</code>. Include an <code>Idempotency-Key</code> header for each order, plus name, customer, quantity, and notes as needed.</p><div class="section-label">ACCESS TOKEN</div><div id="integration-token" class="secret-value" aria-label="Hidden intake access token">••••••••••••••••••••••••••••••••</div><div class="secret-actions"><button class="button small" data-action="reveal-token">Show token</button><button class="button small" data-action="copy-token">${icon('copy')} Copy token</button><button class="button small" data-action="rotate-token">Rotate token</button></div><p class="field-hint mt-16">Send the token as <code>Authorization: Bearer YOUR_TOKEN</code>. Keep it on your website’s server, never in a public browser page.</p><div class="inline-notice warning mt-16 no-margin">${icon('info')}<span>This endpoint uses HTTP on your LAN. Connect a public website through a secure reverse proxy, VPN, or an outbound delivery bridge. Do not expose raw LAN HTTP to the public internet.</span></div>`, `<button class="button" data-action="close-modal">Close</button><button type="submit" form="integration-form" class="button primary">Save intake settings</button>`, true);
      integrationData = result;
    } catch (error) { toast(error.message, true); }
  }

  function jobModal(id) {
    const job = jobById(id);
    if (!job) return toast('This job is no longer available.', true);
    const printer = printerById(job.printerId);
    const canPrepare = ['review', 'ready', 'failed', 'cancelled'].includes(job.status);
    const showResolve = job.status === 'needs_attention' && Boolean(job.currentRunId);
    const options = state.printers.map(item => `<option value="${attr(item.id)}" ${item.id === job.printerId ? 'selected' : ''}>${esc(item.name)} · ${esc(typeNames[item.type] || item.type)}</option>`).join('');
    const history = [...(job.history || [])].slice(-8).reverse();
    const notes = job.notes ? `<div class="section-label">PRINT REQUIREMENTS</div><p class="body-copy text-break" style="white-space:pre-wrap">${esc(job.notes)}</p>` : '';
    openModal('Job details', `Created ${esc(dateTime(job.createdAt))} · ${esc(job.id)}`, `<div class="job-heading"><div class="file-cell"><span class="file-icon">${esc(extension(job.fileName))}</span><div><div class="file-name">${esc(job.name || job.fileName)}</div><div class="file-sub">${esc(job.fileName)}</div></div></div>${badge(job.status)}</div><div class="details-grid"><div><div class="detail-key">Customer / project</div><div class="detail-value">${esc(readable(job.customer))}</div></div><div><div class="detail-key">Arrived from</div><div class="detail-value">${esc(sourceLabel(job.source))}</div></div><div><div class="detail-key">Printer</div><div class="detail-value">${esc(printer?.name || 'Not assigned yet')}</div></div><div><div class="detail-key">Requested copies</div><div class="detail-value">${quantity(job)}</div></div><div><div class="detail-key">Accepted copies</div><div class="detail-value">${accepted(job)} / ${quantity(job)}</div></div><div><div class="detail-key">Remaining copies</div><div class="detail-value">${Math.max(0, quantity(job) - accepted(job))}</div></div></div>${job.error ? `<div class="inline-notice error">${icon('alert')}<span>${esc(typeof job.error === 'string' ? job.error : job.error.message || 'This job needs attention.')}</span></div>` : ''}${notes}
      ${canPrepare ? `<div class="job-action-panel"><h3>${job.artifact ? 'Prepared file' : 'Prepare for a printer'}</h3><p>${job.artifact ? `This job has a prepared artifact${printer ? ` for ${esc(printer.name)}` : ''}. Changing the printer requires preparing it again.` : 'QuickPrint checks or slices this file for the selected printer. Preparation does not start the printer.'}</p>${state.printers.length ? `<form id="prepare-form" data-id="${attr(job.id)}"><div class="field-row"><div class="field"><label for="job-printer">Target printer</label><select id="job-printer" name="printerId" required><option value="">Select a printer</option>${options}</select></div><button type="submit" class="button ${job.status === 'ready' ? '' : 'primary'}">${icon('cube')} ${job.artifact ? 'Prepare again' : 'Prepare file'}</button></div></form>` : '<button class="button compact" data-action="add-printer">Connect a printer first</button>'}${job.status === 'ready' && printer ? `<div class="divider" style="margin:17px 0"></div><div class="button-row"><button class="button primary" data-action="dispatch" data-id="${attr(job.id)}" data-printer-id="${attr(job.printerId)}" ${supports(printer, 'start') && supports(printer, 'upload') ? '' : 'disabled title="This adapter does not support uploading and starting prints"'}>${icon('play')} Start one copy</button><span class="field-hint">You’ll confirm the printer is ready before it starts.</span></div>` : ''}</div>` : ''}
      ${['printing', 'paused'].includes(job.status) ? `<div class="job-action-panel"><h3>Print controls</h3><p>Controls are sent to ${esc(printer?.name || 'the assigned printer')}. Available actions depend on its adapter.</p><div class="button-row"><button class="button" data-action="control-job" data-id="${attr(job.id)}" data-control="${job.status === 'paused' ? 'resume' : 'pause'}" ${supports(printer, job.status === 'paused' ? 'resume' : 'pause') ? '' : 'disabled title="This adapter does not support this action"'}>${icon(job.status === 'paused' ? 'play' : 'pause')}${job.status === 'paused' ? 'Resume' : 'Pause'}</button><button class="button" data-action="control-job" data-id="${attr(job.id)}" data-control="cancel" ${supports(printer, 'cancel') ? '' : 'disabled title="This adapter does not support cancellation"'}>${icon('stop')} Cancel print</button></div></div>` : ''}
      ${job.status === 'preparing' ? `<div class="job-action-panel"><h3>Preparing your file</h3><p>The slicer is preparing this file for ${esc(printer?.name || 'the selected printer')}. Large models may take several minutes.</p><button class="button compact" data-action="cancel-local" data-id="${attr(job.id)}">${icon('stop')} Cancel preparation</button></div>` : ''}
      ${job.status === 'dispatching' ? `<div class="inline-notice warning">${icon('clock')}<span>The print command is being resolved. Do not start another copy until you verify what the printer actually did.</span></div>` : ''}
      ${showResolve ? `<div class="job-action-panel"><h3>Verify this print run</h3><p>Check the physical printer and part before recording the outcome. If a start was interrupted or ambiguous, confirm whether the printer started. Never mark an active print as not started.</p><button class="button compact" data-action="reconcile" data-id="${attr(job.id)}">${icon('check')} Record run outcome</button></div>` : ''}
      ${job.status === 'completed' ? `<div class="inline-notice no-margin">${icon('check')}<span>All requested copies have been accepted. This job is complete.</span></div>` : ''}
      ${history.length ? `<div class="section-label">JOB HISTORY</div><div class="history">${history.map(item => `<div class="history-item"><p>${esc(item.message || item.note || item.event || statusNames[item.status] || item.status || item.type || 'Job updated')}</p><time>${esc(dateTime(item.at || item.createdAt || item.timestamp))}</time></div>`).join('')}</div>` : ''}`, ` ${['review', 'ready'].includes(job.status) ? `<button class="button" data-action="cancel-local" data-id="${attr(job.id)}">Cancel job</button>` : ''}<button class="button" data-action="refresh-job" data-id="${attr(job.id)}">${icon('refresh')} Refresh status</button><button class="button" data-action="download" data-id="${attr(job.id)}">${icon('download')} Original file</button><button class="button" data-action="close-modal">Close</button>`, true);
  }

  function confirmModal(title, description, actionLabel, onConfirm, { danger = false, checkbox = '', onCancel = null } = {}) {
    openModal(esc(title), '', `<p class="body-copy">${esc(description)}</p>${checkbox ? `<label class="checkbox-field mt-16"><input id="confirm-physical" type="checkbox" required><span>${esc(checkbox)}</span></label>` : ''}`, `<button class="button" id="confirm-cancel">Cancel</button><button class="button ${danger ? 'danger' : 'primary'}" id="confirm-action" ${checkbox ? 'disabled' : ''}>${esc(actionLabel)}</button>`);
    $('#confirm-cancel').addEventListener('click', () => { closeModal(); onCancel?.(); });
    $('#confirm-physical')?.addEventListener('change', event => { $('#confirm-action').disabled = !event.target.checked; });
    $('#confirm-action').addEventListener('click', async () => {
      modalBusy = true;
      $('#confirm-action').disabled = true;
      $('#confirm-cancel').disabled = true;
      try { await onConfirm(); } catch (error) { modalError(error); } finally {
        modalBusy = false;
        if ($('#confirm-action')) $('#confirm-action').disabled = false;
        if ($('#confirm-cancel')) $('#confirm-cancel').disabled = false;
      }
    });
  }

  function reconcileModal(id) {
    const job = jobById(id);
    if (!job) return;
    openModal('Record what actually happened.', 'This resolves one print run. Accepted copies count toward the job’s total.', `<form id="reconcile-form" data-id="${attr(id)}" data-run-id="${attr(job.currentRunId)}"><div class="inline-notice warning">${icon('info')}<span>Verify the printer is stopped and inspect the part. This records the outcome; it does not send a stop command.</span></div><div class="form-grid"><div class="field full"><label for="run-outcome">Run outcome</label><select id="run-outcome" name="outcome"><option value="completed">Print finished — record accepted part</option><option value="failed">Print failed — no accepted part</option><option value="not_started">Confirmed the print never started</option><option value="cancelled">Print was cancelled</option></select></div>${field('acceptedQuantity', 'Accepted from this run (0 or 1)', 1, { type: 'number', extra: 'min="0" max="1" step="1"', required: true, hint: `Already accepted: ${accepted(job)} of ${quantity(job)} requested copies.` })}${field('notes', 'Operator notes', '', { textarea: true, full: true, placeholder: 'Part quality, cause of failure, or how you verified the printer state.' })}<label class="checkbox-field full" style="grid-column:1/-1"><input type="checkbox" required><span>I checked the printer and verified this outcome.</span></label></div></form>`, footerSubmit('reconcile-form', 'Record outcome'));
  }

  async function handleSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    event.preventDefault();
    if (!connected) return toast('Reconnect to the local workspace before making changes.', true);
    const data = new FormData(form);
    const value = key => String(data.get(key) || '').trim();
    const number = key => Number(data.get(key));
    const id = form.dataset.id;
    setBusy(true, form);
    try {
      if (form.id === 'upload-form') {
        if (!uploadFiles.length) throw new Error('Choose at least one file to add.');
        const body = new FormData();
        uploadFiles.forEach(file => body.append('files', file));
        ['name', 'customer', 'quantity', 'notes'].forEach(key => body.append(key, value(key)));
        body.append('sourceId', form.dataset.sourceId);
        const result = await api('/api/jobs', { method: 'POST', body });
        modalBusy = false; closeModal();
        toast(result.duplicate ? 'This submission is already in your queue.' : `${result.jobs?.length || uploadFiles.length} ${result.jobs?.length === 1 ? 'job' : 'jobs'} added to review.`);
        await refresh(); location.hash = '#jobs';
      } else if (form.id === 'printer-form') {
        const config = { name: value('name'), type: value('type'), host: value('host'), model: value('model') };
        if (id) config.id = id;
        if (value('port')) config.port = number('port');
        ['apiKey', 'password', 'serial', 'accessCode', 'caCertificate', 'tlsFingerprint'].forEach(key => { if (value(key)) config[key] = value(key); });
        config.slicer = data.has('customSlicer') ? {
          kind: value('printerSlicerKind'), executable: value('printerSlicerExecutable'),
          profilePaths: value('printerProfilePaths').split(/\r?\n/).map(line => line.trim()).filter(Boolean),
          extraArgs: value('printerExtraArgs').split(/\r?\n/).map(line => line.trim()).filter(Boolean),
        } : null;
        await api('/api/printers', { method: 'POST', body: config });
        modalBusy = false; closeModal(); toast(id ? 'Printer settings saved.' : 'Printer added. Test the connection before preparing a job.'); await refresh();
      } else if (form.id === 'connector-form') {
        const type = form.dataset.type;
        const config = { type, name: value('name'), enabled: data.has('enabled'), defaults: { quantity: number('quantity') || 1, customer: value('customer'), notes: value('notes') } };
        if (id) config.id = id;
        if (type === 'folder') Object.assign(config, { path: value('path'), settleMs: number('settleSeconds') * 1000 });
        else {
          Object.assign(config, { host: value('host'), port: number('port'), secure: true, username: value('username'), mailbox: value('mailbox'), pollIntervalMs: number('pollSeconds') * 1000 });
          if (value('password')) config.password = value('password');
        }
        await api('/api/connectors', { method: 'POST', body: config });
        modalBusy = false; closeModal(); toast('Input connection saved.'); await refresh();
      } else if (form.id === 'settings-form') {
        const lines = key => value(key).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        await api('/api/settings', { method: 'PUT', body: { siteName: value('siteName'), pollIntervalMs: number('pollSeconds') * 1000, slicer: { kind: value('slicerKind'), executable: value('slicerExecutable'), profilePaths: lines('profilePaths'), extraArgs: lines('extraArgs') } } });
        settingsDirty = false; lastPage = null; await refresh(); toast('Workspace settings saved.');
      } else if (form.id === 'integration-form') {
        await api('/api/settings', { method: 'PUT', body: { intake: { enabled: data.has('enabled'), port: number('port') } } });
        await refresh(); toast('Intake settings saved.'); await integrationModal();
      } else if (form.id === 'prepare-form') {
        const button = $('button[type="submit"]', form);
        if (button) button.innerHTML = '<span class="spinner"></span> Preparing…';
        const cancel = document.createElement('button');
        cancel.type = 'button'; cancel.className = 'button'; cancel.dataset.action = 'cancel-local'; cancel.dataset.id = id;
        cancel.dataset.preparingCancel = 'true'; cancel.textContent = 'Cancel preparation'; $('.field-row', form).append(cancel);
        await api(`/api/jobs/${idPath(id)}/prepare`, { method: 'POST', body: { printerId: value('printerId') } });
        await refresh(); jobModal(id); toast('File prepared. Review the printer before starting a copy.');
      } else if (form.id === 'reconcile-form') {
        await api(`/api/jobs/${idPath(id)}/reconcile`, { method: 'POST', body: { runId: form.dataset.runId, outcome: value('outcome'), acceptedQuantity: value('outcome') === 'completed' ? number('acceptedQuantity') : 0, notes: value('notes') } });
        await refresh(); jobModal(id); toast('Run outcome recorded.');
      }
    } catch (error) {
      if (form.id === 'prepare-form' && error.code === 'PREPARATION_CANCELLED') { await refresh(); jobModal(id); return; }
      if (form.id === 'settings-form') { $('#settings-error').textContent = error.message; $('#settings-error').scrollIntoView({ block: 'nearest' }); }
      else modalError(error);
      if (form.id === 'prepare-form') { const button = $('button[type="submit"]', form); if (button) button.innerHTML = `${icon('cube')} Prepare file`; await refresh({ silent: true }); }
    } finally { $('[data-preparing-cancel]', form)?.remove(); setBusy(false, form); }
  }

  async function browse(kind, targetId) {
    if (!window.quickprint) return toast('In browser mode, enter the full path manually. The Windows app includes a native file picker.');
    if (kind === 'folder') { const path = await window.quickprint.selectFolder(); if (path && $('#connector-path')) $('#connector-path').value = path; }
    if (kind === 'slicer') { const path = await window.quickprint.selectFile({ kind: 'slicer' }); const target = document.getElementById(targetId || 'slicer-executable'); if (path && target) { target.value = path; settingsDirty = true; } }
    if (kind === 'profiles') { const paths = await window.quickprint.selectFile({ kind: 'profile', multiple: true }); const target = document.getElementById(targetId || 'field-profilePaths'); if (paths && target) { target.value = (Array.isArray(paths) ? paths : [paths]).join('\n'); settingsDirty = true; } }
  }

  async function downloadOriginal(id) {
    const response = await fetch(`/api/jobs/${idPath(id)}/file`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error('The original file could not be downloaded.');
    const blob = await response.blob();
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = href; link.download = jobById(id)?.fileName || 'quickprint-file'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(href), 60000);
  }

  async function exportBackup() {
    const response = await fetch('/api/backup', { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      let message = 'The workspace backup could not be exported.';
      try { const result = await response.json(); message = result.message || result.error || message; } catch {}
      throw new Error(message);
    }
    const href = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = href;
    link.download = `QuickPrint-backup-${new Date().toISOString().slice(0, 10)}.zip`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(href), 60000);
  }

  async function handleAction(event) {
    const button = event.target.closest('[data-action]');
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    const id = button.dataset.id;
    try {
      if (action === 'close-modal') return closeModal();
      if (action === 'refresh') { button.disabled = true; await refresh(); button.disabled = false; return; }
      if (action === 'upload') return uploadModal();
      if (action === 'add-printer') return printerModal();
      if (action === 'edit-printer') return printerModal(id);
      if (action === 'job') return jobModal(id);
      if (action === 'refresh-job') { const job = jobById(id); button.disabled = true; if (job?.printerId) await api(`/api/printers/${idPath(job.printerId)}/test`, { method: 'POST' }); await refresh(); return jobModal(id); }
      if (action === 'go-inputs') { location.hash = '#inputs'; return; }
      if (action === 'filter') { jobFilter = button.dataset.filter; renderPage(); return; }
      if (action === 'clear-filters') { jobFilter = 'all'; jobSearch = ''; renderPage(); return; }
      if (action === 'test-printer') {
        button.disabled = true;
        const result = await api(`/api/printers/${idPath(id)}/test`, { method: 'POST' });
        const status = result.status || result;
        toast(status.message || `Printer status: ${statusNames[status.state] || status.state || 'checked'}`, ['offline', 'error'].includes(status.state));
        await refresh(); return;
      }
      if (action === 'remove-printer') {
        const printer = printerById(id);
        return confirmModal('Remove this printer?', `${printer?.name || 'This printer'} will be removed from QuickPrint. This does not send a command to the physical printer.`, 'Remove printer', async () => { await api(`/api/printers/${idPath(id)}`, { method: 'DELETE' }); modalBusy = false; closeModal(); await refresh(); toast('Printer removed.'); }, { danger: true });
      }
      if (action === 'add-folder') return connectorModal('folder');
      if (action === 'add-email') return connectorModal('email');
      if (action === 'edit-connector') return connectorModal(null, id);
      if (action === 'remove-connector') return confirmModal('Remove this connection?', 'Future files will no longer be imported from this input. Jobs already in your queue will be kept.', 'Remove connection', async () => { await api(`/api/connectors/${idPath(id)}`, { method: 'DELETE' }); modalBusy = false; closeModal(); await refresh(); toast('Input connection removed.'); }, { danger: true });
      if (action === 'poll-connector') { button.disabled = true; await api(`/api/connectors/${idPath(id)}/poll`, { method: 'POST' }); await refresh(); toast('Input checked for new files.'); return; }
      if (action === 'integration') return await integrationModal();
      if (action === 'reveal-token') {
        const target = $('#integration-token');
        const isVisible = button.dataset.visible === 'true';
        target.textContent = isVisible ? '••••••••••••••••••••••••••••••••' : integrationData?.token || 'Enable and save intake to generate a token.';
        button.dataset.visible = String(!isVisible); button.textContent = isVisible ? 'Show token' : 'Hide token'; return;
      }
      if (action === 'copy-token') {
        if (!integrationData?.token) throw new Error('Enable and save intake before copying its token.');
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable. Show the token and copy it manually.');
        await navigator.clipboard.writeText(integrationData.token); toast('Intake token copied. Keep it private.'); return;
      }
      if (action === 'rotate-token') return confirmModal('Replace the intake token?', 'Existing website connections will stop submitting until they use the new token.', 'Replace token', async () => { await api('/api/integration/rotate', { method: 'POST' }); await refresh(); await integrationModal(); toast('Intake token replaced. Update your website integration.'); });
      if (action === 'browse-folder') return await browse('folder');
      if (action === 'browse-slicer') return await browse('slicer', button.dataset.target);
      if (action === 'browse-profiles') return await browse('profiles', button.dataset.target);
      if (action === 'open-data') {
        if (window.quickprint?.openDataFolder) await window.quickprint.openDataFolder();
        else toast('Use the Windows desktop app to open its data folder. Browser mode uses the server’s configured data directory.');
        return;
      }
      if (action === 'reset-settings') { settingsDirty = false; renderPage(); toast('Unsaved settings discarded.'); return; }
      if (action === 'download') return await downloadOriginal(id);
      if (action === 'export-backup') { button.disabled = true; await exportBackup(); toast('Workspace backup downloaded.'); return; }
      if (action === 'dispatch') {
        const job = jobById(id), printer = printerById(button.dataset.printerId);
        return confirmModal('Ready to make this real?', `Start ONE copy of “${job?.name || job?.fileName}” on ${printer?.name || 'the selected printer'}? This sends a physical start command. Check the build plate, material, nozzle, and prepared file before continuing.`, 'Start one copy', async () => { await api(`/api/jobs/${idPath(id)}/dispatch`, { method: 'POST', body: { printerId: button.dataset.printerId, confirmed: true } }); await refresh(); jobModal(id); toast('Print start requested. Follow the printer status and verify the finished part.'); }, { checkbox: 'The printer is clear, the correct material is loaded, and I am ready to start.', onCancel: () => jobModal(id) });
      }
      if (action === 'control-job') {
        const control = button.dataset.control;
        if (control === 'cancel') return confirmModal('Cancel this physical print?', 'QuickPrint will send a stop command to the printer. Inspect and clear the build plate before the next run.', 'Cancel print', async () => { await api(`/api/jobs/${idPath(id)}/control`, { method: 'POST', body: { action: control } }); await refresh(); jobModal(id); toast('Cancel command sent. Verify the printer stopped.'); }, { danger: true, onCancel: () => jobModal(id) });
        button.disabled = true;
        await api(`/api/jobs/${idPath(id)}/control`, { method: 'POST', body: { action: control } }); await refresh(); jobModal(id); toast(`${control === 'pause' ? 'Pause' : 'Resume'} command sent.`); return;
      }
      if (action === 'cancel-local') {
        button.disabled = true;
        await api(`/api/jobs/${idPath(id)}/control`, { method: 'POST', body: { action: 'cancel' } });
        await refresh(); jobModal(id); toast('Job cancelled. You can prepare it again when you’re ready.'); return;
      }
      if (action === 'reconcile') return reconcileModal(id);
    } catch (error) { if ($('#modal-root').hasChildNodes()) modalError(error); else toast(error.message, true); }
    finally { if (button.isConnected) button.disabled = false; }
  }

  function toast(message, error = false) {
    const element = document.createElement('div'); element.className = `toast${error ? ' error' : ''}`;
    element.innerHTML = `${icon(error ? 'alert' : 'check')}<span>${esc(message)}</span><button aria-label="Dismiss notification">×</button>`;
    $('button', element).addEventListener('click', () => element.remove());
    $('#toast-root').append(element); setTimeout(() => element.remove(), error ? 12000 : 6500);
  }

  document.addEventListener('click', handleAction);
  document.addEventListener('submit', handleSubmit);
  document.addEventListener('input', event => {
    if (event.target.id === 'job-search') { jobSearch = event.target.value; renderPage(); }
    if (event.target.closest('#settings-form')) settingsDirty = true;
  });
  document.addEventListener('change', event => {
    if (event.target.id === 'upload-files') { uploadFiles = [...event.target.files]; renderSelectedFiles(); }
    if (event.target.id === 'printer-type') { $('#printer-auth').innerHTML = printerAuth(event.target.value, printerById($('#printer-form').dataset.id) || {}); $('#printer-hint').innerHTML = printerHint(event.target.value); $('#printer-model-field').innerHTML = printerModel(event.target.value, printerById($('#printer-form').dataset.id)?.model || ''); }
    if (event.target.id === 'slicer-kind') { $('#profile-hint').textContent = profileHint(event.target.value); settingsDirty = true; }
    if (event.target.id === 'printer-slicer-kind') $('#printer-profile-hint').textContent = profileHint(event.target.value);
    if (event.target.id === 'printer-custom-slicer') $('#printer-slicer-fields').disabled = !event.target.checked;
    if (event.target.id === 'run-outcome') { const input = $('#field-acceptedQuantity'); input.disabled = event.target.value !== 'completed'; input.value = event.target.value === 'completed' ? '1' : '0'; }
  });
  document.addEventListener('keydown', event => {
    const modal = $('.modal');
    if (modal && event.key === 'Escape') { event.preventDefault(); closeModal(); }
    if (modal && event.key === 'Tab') {
      const focusables = $$('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],summary,[tabindex="0"]', modal).filter(element => element.getClientRects().length);
      const first = focusables[0], last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  window.addEventListener('hashchange', navigate);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh({ silent: true }); });
  navigate();
  refresh({ silent: true });
  setInterval(() => { if (!document.hidden) refresh({ silent: true }); }, 10000);
})();
