'use strict';

const { randomBytes, createHash } = require('node:crypto');

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CLIENT = /^pbl_[A-Za-z0-9_-]{22}$/;
const STATE_MS = 10 * 60 * 1000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const tokenString = value => typeof value === 'string' && TOKEN.test(value);
const clientString = value => typeof value === 'string' && CLIENT.test(value);

function failure(message, code = 'LAYR_OAUTH_FAILED', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function validatePortalUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw failure('Enter the HTTPS address of your PrintByLayr portal.', 'LAYR_PORTAL_URL'); }
  if (typeof value !== 'string' || value.length > 2000 || url.protocol !== 'https:' || url.username || url.password
    || url.search || url.hash || url.pathname !== '/') {
    throw failure('Use an HTTPS portal origin without a path, query, or embedded credentials.', 'LAYR_PORTAL_URL');
  }
  return url.origin;
}

function validateRedirect(value) {
  let url;
  try { url = new URL(value); } catch { throw failure('QuickPrint needs a local OAuth callback.', 'LAYR_CALLBACK'); }
  if (typeof value !== 'string' || url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/integrations/layr/callback') {
    throw failure('Use the QuickPrint loopback OAuth callback address.', 'LAYR_CALLBACK');
  }
  return url.href;
}

async function readJson(response) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw failure('The portal returned an oversized OAuth response.', 'LAYR_OAUTH_RESPONSE', 502);
  }
  const reader = response.body?.getReader();
  if (!reader) throw failure('The portal returned an empty OAuth response.', 'LAYR_OAUTH_RESPONSE', 502);
  let bytes = 0;
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw failure('The portal returned an oversized OAuth response.', 'LAYR_OAUTH_RESPONSE', 502);
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid shape');
    return result;
  } catch { throw failure('The portal returned an invalid OAuth response.', 'LAYR_OAUTH_RESPONSE', 502); }
}

// Endpoints are fixed to the inspected PrintByLayr server contract. No discovered
// endpoint can redirect a code, verifier, or refresh token to another origin.
class LayrOAuth {
  constructor({ fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 15000 } = {}) {
    if (typeof fetchImpl !== 'function' || typeof now !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
      throw new TypeError('LayrOAuth needs fetch, a clock, and a timeout from 1 to 60000 ms.');
    }
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.registrations = new Map();
  }

  async request(portalUrl, pathname, body, { signal } = {}) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await this.fetchImpl(`${portalUrl}${pathname}`, {
        method: 'POST', redirect: 'error', signal: combined,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (pathname === '/oauth/token') throw failure('PrintByLayr authorization expired or was rejected. Connect the portal again.', 'LAYR_RECONNECT', 401);
        throw failure('PrintByLayr could not register this connection. Check portal availability and existing connector registrations.', 'LAYR_OAUTH_REGISTRATION', 502);
      }
      return await readJson(response);
    } catch (error) {
      if (typeof error?.code === 'string' && error.code.startsWith('LAYR_')) throw error;
      if (combined.aborted) throw failure('The PrintByLayr authorization request was cancelled or timed out. Connect again.', 'LAYR_OAUTH_TIMEOUT', 504);
      throw failure('The PrintByLayr authorization request failed. Check the portal connection and connect again.', 'LAYR_OAUTH_NETWORK', 502);
    }
  }

  async begin(portalUrl, redirectUri, { signal } = {}) {
    portalUrl = validatePortalUrl(portalUrl);
    redirectUri = validateRedirect(redirectUri);
    for (const [state, entry] of this.pending) if (entry.expiresAt <= this.now()) this.pending.delete(state);
    if (this.pending.size >= 10) throw failure('Complete or wait for the existing portal connection attempts to expire.', 'LAYR_OAUTH_PENDING', 429);
    const key = JSON.stringify([portalUrl, redirectUri]);
    let registration = this.registrations.get(key);
    if (!registration) {
      if (this.registrations.size >= 20) throw failure('Restart QuickPrint before registering more portal connections.', 'LAYR_OAUTH_PENDING', 429);
      registration = this.request(portalUrl, '/oauth/register', {
        client_name: 'QuickPrint', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      }, { signal }).then(result => {
        if (!clientString(result.client_id) || !Array.isArray(result.redirect_uris) || !result.redirect_uris.includes(redirectUri)
          || result.token_endpoint_auth_method !== 'none') {
          throw failure('The portal returned an invalid connector registration.', 'LAYR_OAUTH_RESPONSE', 502);
        }
        return result.client_id;
      }).catch(error => { this.registrations.delete(key); throw error; });
      this.registrations.set(key, registration);
    }
    const clientId = await registration;
    // Recheck after registration because concurrent begins can have awaited it.
    if (this.pending.size >= 10) throw failure('Complete or wait for the existing portal connection attempts to expire.', 'LAYR_OAUTH_PENDING', 429);
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    this.pending.set(state, { portalUrl, redirectUri, clientId, verifier, expiresAt: this.now() + STATE_MS });
    const url = new URL('/oauth/authorize', portalUrl);
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
      code_challenge: challenge, code_challenge_method: 'S256', state, resource: `${portalUrl}/mcp`, scope: 'studio' })) {
      url.searchParams.set(key, value);
    }
    return { authorizationUrl: url.href, state };
  }

  credentials(result, { portalUrl, clientId }) {
    if (!tokenString(result.access_token) || !tokenString(result.refresh_token) || typeof result.token_type !== 'string' || result.token_type.toLowerCase() !== 'bearer'
      || !Number.isSafeInteger(result.expires_in) || result.expires_in < 1 || result.expires_in > 86400 || result.scope !== 'studio') {
      throw failure('The portal returned invalid authorization credentials. Connect again.', 'LAYR_OAUTH_RESPONSE', 502);
    }
    return { portalUrl, clientId, token: result.access_token, refreshToken: result.refresh_token,
      expiresAt: new Date(this.now() + result.expires_in * 1000).toISOString() };
  }

  cancel(state) {
    return typeof state === 'string' && this.pending.delete(state);
  }

  async complete({ code, state, redirectUri, issuer, signal } = {}) {
    const entry = typeof state === 'string' && this.pending.get(state);
    // Consume the state before validation or network I/O so concurrent callbacks
    // and rejected/denied attempts cannot redeem it twice.
    if (entry) this.pending.delete(state);
    if (!entry || entry.expiresAt <= this.now()) throw failure('This portal connection attempt expired or was already used. Connect again.', 'LAYR_OAUTH_STATE');
    if (validateRedirect(redirectUri) !== entry.redirectUri || (issuer !== undefined && issuer !== entry.portalUrl)) {
      throw failure('The portal callback did not match this connection attempt.', 'LAYR_OAUTH_STATE');
    }
    if (!tokenString(code)) throw failure('The portal did not approve this connection. Connect again when ready.', 'LAYR_OAUTH_CODE');
    const result = await this.request(entry.portalUrl, '/oauth/token', {
      grant_type: 'authorization_code', client_id: entry.clientId, code, code_verifier: entry.verifier,
      redirect_uri: entry.redirectUri, resource: `${entry.portalUrl}/mcp`,
    }, { signal });
    return this.credentials(result, entry);
  }

  async refresh(credentials, { signal } = {}) {
    const portalUrl = validatePortalUrl(credentials?.portalUrl);
    const clientId = credentials?.clientId;
    if (!clientString(clientId) || !tokenString(credentials?.refreshToken)) {
      throw failure('PrintByLayr needs a new portal connection.', 'LAYR_RECONNECT', 401);
    }
    // The server rotates each refresh token once. Callers must serialize refresh
    // and durably save the returned credentials; never retry this POST blindly.
    const result = await this.request(portalUrl, '/oauth/token', {
      grant_type: 'refresh_token', client_id: clientId, refresh_token: credentials.refreshToken, resource: `${portalUrl}/mcp`,
    }, { signal });
    return this.credentials(result, { portalUrl, clientId });
  }
}

module.exports = { LayrOAuth, validatePortalUrl };
