'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { LayrOAuth, validatePortalUrl } = require('../src/connectors/layr-oauth');

const PORTAL = 'https://printbylayr.example';
const REDIRECT = 'http://127.0.0.1:9731/integrations/layr/callback';
const CLIENT = `pbl_${'c'.repeat(22)}`;
const CODE = 'a'.repeat(43);
const tokens = () => ({ access_token: 't'.repeat(43), token_type: 'Bearer', expires_in: 3600, refresh_token: 'r'.repeat(43), scope: 'studio' });

function fixture(options = {}) {
  const calls = [];
  let time = Date.parse('2026-11-19T12:00:00Z');
  const oauth = new LayrOAuth({
    now: () => time,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, init, body });
      if (url.endsWith('/oauth/register')) return Response.json({ client_id: CLIENT, redirect_uris: body.redirect_uris, token_endpoint_auth_method: 'none' }, { status: 201 });
      return Response.json(tokens());
    },
    ...options,
  });
  return { oauth, calls, advance: ms => { time += ms; } };
}

test('PrintByLayr OAuth registers a public client and redeems a one-use PKCE callback', async () => {
  const { oauth, calls } = fixture();
  const begin = await oauth.begin(`${PORTAL}/`, REDIRECT);
  const authorize = new URL(begin.authorizationUrl);
  assert.equal(authorize.origin, PORTAL);
  assert.equal(authorize.pathname, '/oauth/authorize');
  assert.equal(authorize.searchParams.get('state'), begin.state);
  assert.equal(authorize.searchParams.get('client_id'), CLIENT);
  assert.equal(authorize.searchParams.get('resource'), `${PORTAL}/mcp`);
  assert.equal(authorize.searchParams.get('scope'), 'studio');
  assert.equal(authorize.searchParams.get('redirect_uri'), REDIRECT);
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.get('response_type'), 'code');
  assert.deepEqual(calls[0].body, {
    client_name: 'QuickPrint', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  });
  const credentials = await oauth.complete({ code: CODE, state: begin.state, redirectUri: REDIRECT, issuer: PORTAL });
  assert.deepEqual(credentials, { portalUrl: PORTAL, clientId: CLIENT, token: 't'.repeat(43), refreshToken: 'r'.repeat(43), expiresAt: '2026-11-19T13:00:00.000Z' });
  const exchange = calls[1];
  assert.equal(exchange.url, `${PORTAL}/oauth/token`);
  assert.equal(exchange.body.grant_type, 'authorization_code');
  assert.equal(exchange.body.code, CODE);
  assert.equal(exchange.body.resource, `${PORTAL}/mcp`);
  assert.equal(exchange.body.redirect_uri, REDIRECT);
  assert.equal(createHash('sha256').update(exchange.body.code_verifier).digest('base64url'), authorize.searchParams.get('code_challenge'));
  assert.equal(begin.authorizationUrl.includes(exchange.body.code_verifier), false);
  assert.equal(exchange.init.redirect, 'error');
  assert.equal(exchange.init.headers.Authorization, undefined);
  await assert.rejects(oauth.complete({ code: CODE, state: begin.state, redirectUri: REDIRECT }), { code: 'LAYR_OAUTH_STATE' });
  assert.equal(calls.length, 2);
});

test('PrintByLayr OAuth reuses a registration but creates separate state and PKCE values', async () => {
  const { oauth, calls } = fixture();
  const [one, two] = await Promise.all([oauth.begin(PORTAL, REDIRECT), oauth.begin(PORTAL, REDIRECT)]);
  assert.equal(calls.length, 1);
  assert.notEqual(one.state, two.state);
  assert.notEqual(new URL(one.authorizationUrl).searchParams.get('code_challenge'), new URL(two.authorizationUrl).searchParams.get('code_challenge'));
});

test('PrintByLayr OAuth refuses unsafe portal origins and non-loopback callbacks before network access', async () => {
  const { oauth, calls } = fixture();
  assert.equal(validatePortalUrl('https://printbylayr.example/'), PORTAL);
  for (const url of ['http://printbylayr.example', 'https://user:secret@printbylayr.example', `${PORTAL}/mcp`, `${PORTAL}/?token=secret`, `${PORTAL}/#fragment`, 'file:///tmp/portal', 'https://printbylayr.example/oauth/../mcp']) {
    await assert.rejects(oauth.begin(url, REDIRECT), { code: 'LAYR_PORTAL_URL' });
  }
  for (const url of ['https://127.0.0.1:9731/integrations/layr/callback', 'http://127.0.0.1.evil.example:9731/integrations/layr/callback', 'http://0.0.0.0:9731/integrations/layr/callback', 'http://localhost:9731/wrong', `${REDIRECT}?extra=1`, `${REDIRECT}#fragment`, 'http://user:password@localhost:9731/integrations/layr/callback']) {
    await assert.rejects(oauth.begin(PORTAL, url), { code: 'LAYR_CALLBACK' });
  }
  assert.equal(calls.length, 0);
});

test('PrintByLayr OAuth refuses expired, unknown, mismatched and replayed callback state', async () => {
  const { oauth, calls, advance } = fixture();
  const first = await oauth.begin(PORTAL, REDIRECT);
  advance(10 * 60 * 1000);
  await assert.rejects(oauth.complete({ code: CODE, state: first.state, redirectUri: REDIRECT }), { code: 'LAYR_OAUTH_STATE' });
  await assert.rejects(oauth.complete({ code: CODE, state: 'unknown', redirectUri: REDIRECT }), { code: 'LAYR_OAUTH_STATE' });
  const second = await oauth.begin(PORTAL, REDIRECT);
  await assert.rejects(oauth.complete({ code: CODE, state: second.state, redirectUri: REDIRECT.replace('9731', '9732') }), { code: 'LAYR_OAUTH_STATE' });
  await assert.rejects(oauth.complete({ code: CODE, state: second.state, redirectUri: REDIRECT }), { code: 'LAYR_OAUTH_STATE' });
  const third = await oauth.begin(PORTAL, REDIRECT);
  await assert.rejects(oauth.complete({ code: CODE, state: third.state, redirectUri: REDIRECT, issuer: 'https://attacker.example' }), { code: 'LAYR_OAUTH_STATE' });
  assert.equal(calls.length, 1);
});

test('PrintByLayr OAuth callback denial consumes the pending state', async () => {
  const { oauth, calls } = fixture();
  const first = await oauth.begin(PORTAL, REDIRECT);
  await assert.rejects(oauth.complete({ state: first.state, redirectUri: REDIRECT }), { code: 'LAYR_OAUTH_CODE' });
  await assert.rejects(oauth.complete({ code: CODE, state: first.state, redirectUri: REDIRECT }), { code: 'LAYR_OAUTH_STATE' });
  assert.equal(calls.length, 1);
});

test('PrintByLayr OAuth cancellation frees pending attempts and prevents redemption without network I/O', async () => {
  const { oauth, calls } = fixture();
  for (let index = 0; index < 12; index++) {
    const pending = await oauth.begin(PORTAL, REDIRECT);
    assert.equal(oauth.cancel(pending.state), true);
    assert.equal(oauth.cancel(pending.state), false);
    await assert.rejects(oauth.complete({ code: CODE, state: pending.state, redirectUri: REDIRECT }), { code: 'LAYR_OAUTH_STATE' });
  }
  assert.equal(oauth.cancel(undefined), false);
  assert.equal(calls.length, 1);
});

test('PrintByLayr OAuth concurrent callbacks redeem the code once', async () => {
  const { oauth, calls } = fixture();
  const first = await oauth.begin(PORTAL, REDIRECT);
  const results = await Promise.allSettled([1, 2].map(() => oauth.complete({ code: CODE, state: first.state, redirectUri: REDIRECT })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'LAYR_OAUTH_STATE');
  assert.equal(calls.filter(call => call.url.endsWith('/oauth/token')).length, 1);
});

test('PrintByLayr OAuth refresh uses the registered client and returns rotated credentials', async () => {
  const { oauth, calls } = fixture();
  const rotated = await oauth.refresh({ portalUrl: PORTAL, clientId: CLIENT, token: 'expired', refreshToken: 'q'.repeat(43) });
  assert.equal(rotated.refreshToken, 'r'.repeat(43));
  assert.equal(rotated.clientId, CLIENT);
  assert.deepEqual(calls[0].body, { grant_type: 'refresh_token', client_id: CLIENT, refresh_token: 'q'.repeat(43), resource: `${PORTAL}/mcp` });
  assert.equal(calls[0].init.redirect, 'error');
  await assert.rejects(oauth.refresh({ portalUrl: PORTAL, clientId: CLIENT, refreshToken: 'invalid' }), { code: 'LAYR_RECONNECT' });
  assert.equal(calls.length, 1);
});

test('PrintByLayr OAuth validates registration and token responses', async () => {
  const badRegistration = fixture({ fetchImpl: async () => Response.json({ client_id: CLIENT, redirect_uris: ['https://attacker.example'], token_endpoint_auth_method: 'none' }) });
  await assert.rejects(badRegistration.oauth.begin(PORTAL, REDIRECT), { code: 'LAYR_OAUTH_RESPONSE' });
  for (const patch of [{ access_token: 'bad' }, { access_token: ['t'.repeat(43)] }, { refresh_token: 'bad' }, { refresh_token: ['r'.repeat(43)] }, { token_type: 'Basic' }, { token_type: 123 }, { expires_in: '3600' }, { expires_in: 0 }, { scope: 'other' }]) {
    const { oauth } = fixture({ fetchImpl: async () => Response.json({ ...tokens(), ...patch }) });
    await assert.rejects(oauth.refresh({ portalUrl: PORTAL, clientId: CLIENT, refreshToken: 'q'.repeat(43) }), { code: 'LAYR_OAUTH_RESPONSE' });
  }
});

test('PrintByLayr OAuth bounds advertised and streamed response size and rejects malformed JSON', async () => {
  for (const response of [
    new Response('{}', { headers: { 'content-length': '65537' } }),
    new Response('x'.repeat(65537)),
    new Response('not JSON'),
    Response.json([]),
  ]) {
    const { oauth } = fixture({ fetchImpl: async () => response });
    await assert.rejects(oauth.begin(PORTAL, REDIRECT), { code: 'LAYR_OAUTH_RESPONSE' });
  }
});

test('PrintByLayr OAuth does not retry rejected rotating tokens or expose server response text', async () => {
  let attempts = 0;
  const { oauth } = fixture({ fetchImpl: async () => { attempts++; return Response.json({ error_description: 'private refresh token or diagnostic' }, { status: 400 }); } });
  const error = await oauth.refresh({ portalUrl: PORTAL, clientId: CLIENT, refreshToken: 'q'.repeat(43) }).catch(error => error);
  assert.equal(error.code, 'LAYR_RECONNECT');
  assert.equal(error.message.includes('private refresh'), false);
  assert.equal(attempts, 1);
});

test('PrintByLayr OAuth passes cancellation to fetch and reports timeout without secrets', async () => {
  const controller = new AbortController();
  controller.abort();
  let seenSignal;
  const { oauth } = fixture({ fetchImpl: async (url, init) => { seenSignal = init.signal; init.signal.throwIfAborted(); } });
  await assert.rejects(oauth.begin(PORTAL, REDIRECT, { signal: controller.signal }), { code: 'LAYR_OAUTH_TIMEOUT' });
  assert.equal(seenSignal.aborted, true);
  const hold = setTimeout(() => {}, 1000);
  try {
    const waiting = fixture({ timeoutMs: 10, fetchImpl: async (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }) });
    await assert.rejects(waiting.oauth.begin(PORTAL, REDIRECT), { code: 'LAYR_OAUTH_TIMEOUT' });
  } finally { clearTimeout(hold); }
});
