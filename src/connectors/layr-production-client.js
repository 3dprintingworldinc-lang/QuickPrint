'use strict';

// Transport for the separately scoped /api/production portal integration.
// Mutation operation IDs and bodies belong to the caller's durable outbox;
// this module never generates IDs or automatically retries a write.
const { createHash } = require('node:crypto');

const MAX_MODEL_BYTES = 100 * 1024 * 1024;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const ACTIONS = new Set(['record_preprocessing', 'record_slice', 'approve_preparation', 'start_print', 'finish_print', 'fail_print']);
const EXPECTED_STATUS = { record_preprocessing: 'preparing', record_slice: 'preparing', approve_preparation: 'queued', start_print: 'printing', finish_print: 'post_processing', fail_print: 'preparing' };
const PORTAL_CODES = new Set(['production_not_configured', 'production_origin', 'production_unauthorized', 'invalid_data', 'production_job_not_found', 'invalid_transition',
  'ticket_changed', 'invalid_cursor', 'invalid_limit', 'invalid_production_record', 'invalid_bindings', 'invalid_receipt', 'source_changed', 'preparation_unqualified',
  'invalid_evidence', 'production_scope', 'operation_conflict', 'version_conflict', 'printer_binding_mismatch', 'run_conflict', 'run_mismatch', 'invalid_content_type',
  'body_too_large', 'invalid_json', 'model_changed', 'receipt_not_found', 'method_not_allowed', 'production_unavailable']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function failure(message, status = 502, extra = {}) {
  const code = status === 401 || status === 403 ? 'LAYR_AUTH' : status === 413 ? 'LAYR_TOO_LARGE' : status === 409 ? 'LAYR_CONFLICT' : 'LAYR_TRANSPORT';
  return Object.assign(new Error(message), { status, code, ...extra });
}
const fail = (message, status, extra) => { throw failure(message, status, extra); };

function validateLayrConfig(config) {
  if (!object(config)) fail('Production connector settings are required.', 400);
  let url;
  try { url = new URL(config.portalUrl); } catch { fail('Enter the HTTPS PrintByLayr portal origin.', 400); }
  if (typeof config.portalUrl !== 'string' || config.portalUrl.length > 2000 || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    fail('Use an HTTPS portal origin without paths, credentials or query parameters.', 400);
  }
  if (typeof config.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(config.token)) fail('Enter a valid scoped production token.', 400);
  if (config.apiMode !== undefined && config.apiMode !== 'production') fail('Select the production API for this connector.', 400);
  return { portalUrl: url.origin, token: config.token, apiMode: 'production' };
}
function ticketFingerprint(job) {
  if (!object(job) || !SHA256.test(job.ticketFingerprint || '')) fail('The portal ticket has no valid server fingerprint.');
  // Private server fields are omitted from the projection. Re-hashing the
  // sanitized projection would produce a different and unusable fingerprint.
  return job.ticketFingerprint;
}
function projection(job) {
  const specs = job?.ticket?.specifications;
  const file = specs?.file;
  if (!object(job) || !UUID.test(job.id || '') || !Number.isSafeInteger(job.version) || job.version < 1 || typeof job.status !== 'string' ||
      !object(specs) || specs.production?.printType !== 'resin' || !object(specs.project) || !object(file) ||
      !Number.isSafeInteger(specs.project.quantity) || specs.project.quantity < 1 || specs.project.quantity > 500 ||
      typeof file.name !== 'string' || file.name.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(file.name) ||
      !['stl', 'obj'].includes(file.format) || !file.name.toLowerCase().endsWith(`.${file.format}`) ||
      !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 1 || !['mm', 'in', 'm'].includes(file.units)) {
    fail('PrintByLayr returned an invalid resin production ticket.');
  }
  ticketFingerprint(job);
  return job;
}
function combine(signal, milliseconds) {
  const timeout = AbortSignal.timeout(milliseconds);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
async function bounded(response, maximum, signal) {
  const declared = response.headers.get('Content-Length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await response.body?.cancel().catch(() => {});
    fail('The portal response exceeds the permitted size.', 413);
  }
  const reader = response.body?.getReader();
  if (!reader) fail('PrintByLayr returned an empty response.');
  const chunks = []; let length = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > maximum) { await reader.cancel().catch(() => {}); fail('The portal response exceeds the permitted size.', 413); }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error.code === 'LAYR_TOO_LARGE') throw error;
    fail('The portal response was interrupted. Check the connection and try again.');
  }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks, length);
}
async function request(config, params, { fetchImpl = fetch, signal } = {}, body) {
  const url = new URL(`${config.portalUrl}/api/production`);
  if (params) for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const activeSignal = combine(signal, 30000);
  const write = body !== undefined;
  let response;
  try {
    response = await fetchImpl(url.toString(), {
      method: write ? 'POST' : 'GET', redirect: 'error', signal: activeSignal,
      headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json', ...(write ? { 'Content-Type': 'application/json' } : {}) },
      ...(write ? { body } : {}),
    });
  } catch { fail('The production request was not confirmed. Check the connection and retry the same operation details.', 502, { ambiguous: write }); }
  if (!response.ok || response.redirected) {
    const status = response.status >= 400 && response.status <= 599 ? response.status : 502;
    let portalCode;
    try {
      const value = JSON.parse((await bounded(response, 16384, activeSignal)).toString('utf8'));
      if (PORTAL_CODES.has(value.code)) portalCode = value.code;
    } catch { /* Never expose remote error bodies or credentials. */ }
    const message = status === 401 || status === 403 ? 'The scoped production credential was rejected. Reconnect this input.' :
      status === 409 ? 'The production ticket or operation changed. Reconcile the saved operation before continuing.' :
      'The production request was not confirmed. Retry the same saved operation details.';
    fail(message, status, { ambiguous: write && status >= 500, ...(portalCode ? { portalCode } : {}) });
  }
  let value;
  try { value = JSON.parse((await bounded(response, MAX_JSON_BYTES, activeSignal)).toString('utf8')); }
  catch (error) {
    if (error.status === 413) { error.ambiguous = write; throw error; }
    fail('PrintByLayr returned invalid production data.', 502, { ambiguous: write });
  }
  if (!object(value)) fail('PrintByLayr returned invalid production data.', 502, { ambiguous: write });
  return value;
}

async function listPreparationJobs(input, { fetchImpl = fetch, signal } = {}) {
  const config = validateLayrConfig(input);
  const options = { fetchImpl, signal: combine(signal, 120000) };
  const jobs = [], seenJobs = new Set(), seenCursors = new Set();
  let cursor;
  do {
    const page = await request(config, { action: 'tickets', limit: 100, ...(cursor ? { cursor } : {}) }, options);
    if (!Array.isArray(page.tickets) || page.tickets.length > 100 || (page.nextCursor !== null &&
        (typeof page.nextCursor !== 'string' || page.nextCursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(page.nextCursor)))) fail('PrintByLayr returned an invalid preparation page.');
    for (const candidate of page.tickets) {
      const job = projection(candidate);
      if (seenJobs.has(job.id)) fail('PrintByLayr repeated a ticket while paging. Retry the preparation scan.');
      seenJobs.add(job.id);
      if (job.status === 'preparing') jobs.push(job);
    }
    cursor = page.nextCursor;
    if (cursor && (seenCursors.has(cursor) || page.tickets.length === 0)) fail('PrintByLayr returned a repeated or empty preparation cursor.');
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return jobs;
}

function buildOrderMetadata(job, portalUrl, data) {
  projection(job);
  const specs = job.ticket.specifications;
  return {
    portalUrl: new URL(portalUrl).origin, portalJobId: job.id, portalVersion: job.version, reference: job.reference,
    ticketFingerprint: ticketFingerprint(job), requestedQuantity: specs.project.quantity, units: specs.file.units,
    production: structuredClone(specs.production), project: structuredClone(specs.project), apiMode: 'production',
    ...(data === undefined ? {} : { modelSha256: createHash('sha256').update(data).digest('hex') }),
  };
}
async function getTicket(input, id, options = {}) {
  const config = validateLayrConfig(input);
  if (!UUID.test(id || '')) fail('A production job UUID is required.', 400);
  const result = await request(config, { action: 'ticket', id }, options);
  const ticket = projection(result.ticket);
  if (ticket.id !== id) fail('PrintByLayr returned a different production ticket.');
  return { ticket };
}
async function downloadModel(input, original, { fetchImpl = fetch, signal } = {}) {
  const config = validateLayrConfig(input);
  projection(original);
  if (original.status !== 'preparing') fail('Only tickets awaiting preparation may be imported.', 409);
  if (original.ticket.specifications.file.sizeBytes > MAX_MODEL_BYTES) fail('QuickPrint imports models up to 100 MiB. Review this larger model manually.', 413);
  const options = { fetchImpl, signal };
  const refreshed = await request(config, { action: 'ticket', id: original.id }, options);
  const job = projection(refreshed.ticket);
  if (job.id !== original.id || job.status !== 'preparing' || job.version !== original.version || ticketFingerprint(job) !== ticketFingerprint(original)) {
    fail('The production ticket changed. Refresh the preparation list before importing.', 409);
  }
  const link = await request(config, { action: 'download', id: job.id, version: job.version, ticketFingerprint: ticketFingerprint(job) }, options);
  let url;
  try { url = new URL(link.url); } catch { fail('PrintByLayr returned an invalid private model link.'); }
  if (url.origin !== config.portalUrl || url.protocol !== 'https:' || url.username || url.password || url.hash || url.pathname !== '/api/intake' ||
      [...url.searchParams.keys()].length !== 1 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(url.searchParams.get('download') || '') ||
      link.name !== job.ticket.specifications.file.name || link.sizeBytes !== job.ticket.specifications.file.sizeBytes) fail('PrintByLayr returned an unexpected private model link.');
  const activeSignal = combine(signal, 120000);
  let response;
  try { response = await fetchImpl(url.toString(), { method: 'GET', redirect: 'error', signal: activeSignal }); }
  catch { fail('The private model download was not confirmed. Refresh and try again.'); }
  if (!response.ok || response.redirected) { await response.body?.cancel().catch(() => {}); fail('The private model download was rejected.'); }
  const data = await bounded(response, Math.min(link.sizeBytes, MAX_MODEL_BYTES), activeSignal);
  if (data.length !== link.sizeBytes) fail('The downloaded model size differs from the approved ticket.');
  return { name: link.name, data, order: buildOrderMetadata(job, config.portalUrl, data) };
}

async function postEvidence(input, command, options = {}) {
  const config = validateLayrConfig(input);
  if (!object(command) || Object.keys(command).some(key => !['action', 'id', 'version', 'operationId', 'data'].includes(key)) ||
      !ACTIONS.has(command.action) || !UUID.test(command.id || '') || !UUID.test(command.operationId || '') ||
      !Number.isSafeInteger(command.version) || command.version < 1 || !object(command.data) || !SHA256.test(command.data.ticketFingerprint || '')) {
    fail('Use an allowed production action with its saved operation UUID, version and ticket fingerprint.', 400);
  }
  const body = JSON.stringify(command);
  if (Buffer.byteLength(body) > 32768) fail('Production evidence exceeds 32 KiB.', 413);
  const result = await request(config, null, options, body);
  let job;
  try { job = projection(result.ticket); }
  catch { fail('The portal did not confirm valid production evidence. Retry the same saved operation details.', 502, { ambiguous: true }); }
  if (job.id !== command.id || job.version !== command.version + 1 || ticketFingerprint(job) !== command.data.ticketFingerprint || job.status !== EXPECTED_STATUS[command.action]) {
    fail('The portal did not confirm the expected production operation.', 502, { ambiguous: true });
  }
  if (['record_preprocessing', 'record_slice'].includes(command.action)) {
    if (!object(result.receipt) || result.receipt.id !== command.operationId || result.receipt.jobId !== command.id ||
        result.receipt.ticketFingerprint !== command.data.ticketFingerprint || result.receipt.sourceSha256 !== command.data.sourceSha256 ||
        typeof result.receipt.qualified !== 'boolean' || result.receipt.printReady !== false) {
      fail('The portal did not confirm the immutable preparation receipt.', 502, { ambiguous: true });
    }
  }
  return result;
}
async function getReceipt(input, { id, receiptId } = {}, options = {}) {
  const config = validateLayrConfig(input);
  if (!UUID.test(id || '') || !UUID.test(receiptId || '')) fail('Job and receipt UUIDs are required.', 400);
  const result = await request(config, { action: 'receipt', id, receiptId }, options);
  const receipt = result.receipt;
  if (!object(receipt) || receipt.id !== receiptId || receipt.jobId !== id || !SHA256.test(receipt.ticketFingerprint || '') || !SHA256.test(receipt.sourceSha256 || '') ||
      !['preprocessing', 'slice'].includes(receipt.kind) || typeof receipt.qualified !== 'boolean' || receipt.printReady !== false) fail('PrintByLayr returned an invalid preparation receipt.');
  return result;
}

module.exports = { validateLayrConfig, listPreparationJobs, ticketFingerprint, getTicket, downloadModel, buildOrderMetadata, postEvidence, getReceipt, lookupReceipt: getReceipt, MAX_MODEL_BYTES };
