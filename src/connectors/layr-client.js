'use strict';

// Read-only transport for PrintByLayr's existing stateless MCP endpoint.
// Access tokens expire after one hour. The manager renews them through the
// separate OAuth component and durably saves rotating credentials before polling.
// This transport never stores credentials or requests studio actions.
// The portal currently searches only its newest 100 jobs, without pagination.
const { createHash, randomUUID } = require('node:crypto');

const MAX_MODEL_BYTES = 100 * 1024 * 1024;
const MAX_RPC_BYTES = 4 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const READ_TOOLS = new Set(['list_jobs', 'get_job', 'model_download_link']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = (message, status = 502) => {
  const code = status === 401 ? 'LAYR_AUTH' : status === 413 ? 'LAYR_TOO_LARGE' : 'LAYR_TRANSPORT';
  throw Object.assign(new Error(message), { status, code });
};

function validateLayrConfig(config) {
  if (!object(config)) fail('PrintByLayr connector settings are required.', 400);
  let url;
  try { url = new URL(config.portalUrl); } catch { fail('Enter the HTTPS PrintByLayr portal URL.', 400); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['/', '/mcp'].includes(url.pathname)) {
    fail('Use the HTTPS portal origin without credentials, query parameters or fragments.', 400);
  }
  if (typeof config.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(config.token)) {
    fail('A valid PrintByLayr MCP access token is required. Reconnect to the portal.', 400);
  }
  return { portalUrl: url.origin, token: config.token };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function ticketFingerprint(job) {
  if (!object(job?.ticket)) fail('An approved PrintByLayr ticket is required.');
  return createHash('sha256').update(JSON.stringify(canonical(job.ticket))).digest('hex');
}

async function readBounded(response, maximum, signal) {
  const rawLength = response.headers?.get('Content-Length');
  if (rawLength !== null && rawLength !== undefined && (!/^\d+$/.test(rawLength) || Number(rawLength) > maximum)) {
    await response.body?.cancel().catch(() => {});
    fail('The PrintByLayr response exceeds the permitted download size.', 413);
  }
  const reader = response.body?.getReader();
  if (!reader) fail('PrintByLayr returned an empty response.');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel().catch(() => {});
        fail('The PrintByLayr response exceeds the permitted download size.', 413);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

function deadline(signal, milliseconds) {
  const timeout = AbortSignal.timeout(milliseconds);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function rpc(config, tool, args, options) {
  if (!READ_TOOLS.has(tool)) fail('This connector supports read-only portal tools.', 400);
  const id = randomUUID();
  const signal = deadline(options.signal, 30000);
  let response;
  try {
    response = await options.fetchImpl(`${config.portalUrl}/mcp`, {
      method: 'POST', redirect: 'error', signal,
      headers: {
        Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json',
        Accept: 'application/json', 'Mcp-Protocol-Version': '2025-11-25',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: args } }),
    });
  } catch { fail('PrintByLayr could not be reached. Check the portal connection.'); }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => {});
    fail('PrintByLayr access expired or was rejected. Reconnect to the portal.', 401);
  }
  if (!response.ok || response.redirected) {
    await response.body?.cancel().catch(() => {});
    fail('PrintByLayr rejected the read-only request.');
  }
  let envelope;
  try { envelope = JSON.parse((await readBounded(response, MAX_RPC_BYTES, signal)).toString('utf8')); }
  catch (error) {
    if (error.status === 413) throw error;
    fail('PrintByLayr returned an invalid MCP response.');
  }
  if (!object(envelope) || envelope.jsonrpc !== '2.0' || envelope.id !== id || envelope.error || !object(envelope.result) || envelope.result.isError) {
    fail('PrintByLayr did not confirm the read-only request.');
  }
  const blocks = envelope.result.content;
  if (!Array.isArray(blocks) || blocks.length !== 1 || blocks[0]?.type !== 'text' || typeof blocks[0].text !== 'string') {
    fail('PrintByLayr returned an unsupported MCP result.');
  }
  let result;
  try { result = JSON.parse(blocks[0].text); } catch { fail('PrintByLayr returned invalid tool data.'); }
  if (!object(result)) fail('PrintByLayr returned invalid tool data.');
  return result;
}

// Payment and production details come from the frozen ticket, never the
// mutable intake payload or client-reported measurements.
function isPreparationJob(job) {
  if (!object(job) || !UUID.test(job.id || '') || !Number.isSafeInteger(job.version) || job.version < 1 || typeof job.status !== 'string') {
    fail('PrintByLayr returned an invalid job record.');
  }
  if (job.status !== 'preparing' || !object(job.payment) || !object(job.ticket)) return false;
  const ticket = job.ticket;
  const specs = ticket.specifications;
  if (!object(specs) || !object(specs.production) || !object(specs.project) || !object(specs.file) || !object(ticket.model) || !object(ticket.quote)) {
    fail('PrintByLayr returned an incomplete approved job ticket.');
  }
  if (specs.production.printType !== 'resin') return false;
  if (!Number.isSafeInteger(ticket.quote.amountCents) || ticket.quote.amountCents < 1 ||
      job.payment.amountCents !== ticket.quote.amountCents || !Number.isFinite(Date.parse(job.payment.confirmedAt))) return false;
  const file = specs.file;
  if (typeof file.name !== 'string' || file.name.length > 255 || /[\/\\\u0000-\u001f\u007f]/.test(file.name) ||
      !['stl', 'obj', 'step', 'stp'].includes(file.format) || !file.name.toLowerCase().endsWith(`.${file.format}`) ||
      !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 1 ||
      !['mm', 'in', 'm'].includes(file.units) ||
      !Number.isSafeInteger(specs.project.quantity) || specs.project.quantity < 1 || specs.project.quantity > 500 ||
      ticket.model.size !== file.sizeBytes) {
    fail('The approved resin ticket has invalid model specifications.');
  }
  return true;
}

function buildOrderMetadata(job, portalUrl, data) {
  if (!isPreparationJob(job)) fail('Only paid resin jobs awaiting preparation can be imported.', 409);
  const specs = job.ticket.specifications;
  return {
    portalUrl: new URL(portalUrl).origin,
    portalJobId: job.id, portalVersion: job.version, reference: job.reference,
    ticketFingerprint: ticketFingerprint(job),
    requestedQuantity: specs.project.quantity, units: specs.file.units,
    production: structuredClone(specs.production), project: structuredClone(specs.project),
    ...(data === undefined ? {} : { modelSha256: createHash('sha256').update(data).digest('hex') }),
  };
}

async function listPreparationJobs(input, { fetchImpl = fetch, signal } = {}) {
  const config = validateLayrConfig(input);
  const options = { fetchImpl, signal };
  const result = await rpc(config, 'list_jobs', { status: 'preparing', limit: 100 }, options);
  if (!Array.isArray(result.jobs) || result.jobs.length > 100 || result.count !== result.jobs.length) fail('PrintByLayr returned an invalid job list.');
  const seen = new Set();
  const jobs = [];
  for (const summary of result.jobs) {
    if (!object(summary) || !UUID.test(summary.id || '') || seen.has(summary.id)) fail('PrintByLayr returned an invalid job list.');
    seen.add(summary.id);
    // Summaries are hints only: re-read the actual ticket before eligibility.
    const job = await rpc(config, 'get_job', { job: summary.id }, options);
    if (job.id !== summary.id) fail('PrintByLayr returned a different job than requested.');
    if (isPreparationJob(job)) jobs.push(job);
  }
  return jobs;
}

async function downloadModel(input, job, { fetchImpl = fetch, signal } = {}) {
  const config = validateLayrConfig(input);
  if (!isPreparationJob(job)) fail('Only paid resin jobs awaiting preparation can be imported.', 409);
  const expected = job.ticket.specifications.file.sizeBytes;
  if (expected > MAX_MODEL_BYTES) fail('QuickPrint imports models up to 100 MiB. Download this larger model manually.', 413);
  const options = { fetchImpl, signal };
  const current = await rpc(config, 'get_job', { job: job.id }, options);
  if (current.id !== job.id || !isPreparationJob(current) || current.version !== job.version || ticketFingerprint(current) !== ticketFingerprint(job)) {
    fail('The portal job changed. Refresh the preparation list before importing.', 409);
  }
  const link = await rpc(config, 'model_download_link', { job: current.id }, options);
  let url;
  try { url = new URL(link.url); } catch { fail('PrintByLayr returned an invalid model link.'); }
  if (url.origin !== config.portalUrl || url.protocol !== 'https:' || url.username || url.password || url.hash ||
      url.pathname !== '/api/intake' || [...url.searchParams.keys()].length !== 1 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(url.searchParams.get('download') || '') ||
      link.file !== current.ticket.specifications.file.name) {
    fail('PrintByLayr returned an unexpected model link.');
  }
  const downloadSignal = deadline(signal, 120000);
  let response;
  try {
    // The signed URL authorizes this download. Never forward the MCP bearer.
    response = await fetchImpl(url.toString(), { method: 'GET', redirect: 'error', signal: downloadSignal });
  } catch { fail('The private model download failed. Refresh and try again.'); }
  if (!response.ok || response.redirected) {
    await response.body?.cancel().catch(() => {});
    fail('The private model download was rejected. Refresh and try again.');
  }
  const data = await readBounded(response, Math.min(expected, MAX_MODEL_BYTES), downloadSignal);
  if (data.length !== expected) fail('The downloaded model size differs from the approved ticket.');
  return { name: current.ticket.specifications.file.name, data, order: buildOrderMetadata(current, config.portalUrl, data) };
}

module.exports = { validateLayrConfig, listPreparationJobs, downloadModel, buildOrderMetadata, ticketFingerprint, MAX_MODEL_BYTES };
