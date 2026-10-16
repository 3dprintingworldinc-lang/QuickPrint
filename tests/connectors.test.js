'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { ConnectorManager, validateConnector } = require('../src/connectors');

async function fixture(t, configs = []) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-connectors-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const submissions = [];
  const events = [];
  const identities = new Map();
  const service = {
    dataDir,
    getConnectors: () => configs,
    recordEvent: event => events.push(event),
    submit: async submission => {
      const identity = `${submission.source}:${submission.sourceId}`;
      if (identities.has(identity)) return { jobs: identities.get(identity), duplicate: true };
      const jobs = submission.files.map((_, index) => ({ id: `${submissions.length}-${index}` }));
      submissions.push(submission);
      identities.set(identity, jobs);
      return { jobs, duplicate: false };
    },
  };
  let time = 1700000000000;
  const makeManager = async options => {
    const manager = new ConnectorManager({ service, now: () => time, tickMs: 86400000, ...options });
    await manager.start();
    t.after(() => manager.stop());
    return manager;
  };
  return { service, dataDir, configs, submissions, events, makeManager, advance: amount => { time += amount; } };
}

function mailboxFactory(messages, { validity = '100', failConnect, onOptions } = {}) {
  const calls = [];
  const factory = options => {
    onOptions?.(options);
    const client = new EventEmitter();
    client.mailbox = { uidValidity: BigInt(validity) };
    client.connect = async () => { calls.push(['connect']); if (failConnect) throw failConnect; };
    client.getMailboxLock = async (...args) => { calls.push(['lock', ...args]); return { release: () => calls.push(['release']) }; };
    client.search = async (...args) => { calls.push(['search', ...args]); return [...messages.keys()]; };
    client.fetchOne = async (uid, query, options) => {
      calls.push(['fetch', uid, query, options]);
      const message = messages.get(uid);
      if (!message) return false;
      return query.source ? { uid, source: message } : { uid, size: message.length };
    };
    client.logout = async () => calls.push(['logout']);
    client.close = () => calls.push(['close']);
    return client;
  };
  return { factory, calls };
}

function rawEmail({ subject = 'Bracket order', filename = 'bracket.stl', content = 'solid bracket\nendsolid bracket' } = {}) {
  return Buffer.from([
    'From: Customer <customer@example.test>',
    'To: makerspace@example.test',
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="fixture-boundary"', '',
    '--fixture-boundary', 'Content-Type: text/plain', '', 'Please print this part.',
    '--fixture-boundary', `Content-Type: application/octet-stream; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`, 'Content-Transfer-Encoding: base64', '',
    Buffer.from(content).toString('base64'), '--fixture-boundary--', '',
  ].join('\r\n'));
}

test('folder imports only stable files, preserves originals and deduplicates across restart', async t => {
  const f = await fixture(t);
  const inbox = path.join(f.dataDir, 'inbox');
  await fs.mkdir(inbox);
  f.configs.push({ id: 'folder-one', type: 'folder', path: inbox, settleMs: 1000, defaults: { quantity: 2, customer: 'Design' } });
  const model = path.join(inbox, 'part.stl');
  await fs.writeFile(model, 'solid part\nendsolid part');
  let manager = await f.makeManager();
  await manager.pollNow('folder-one');
  assert.equal(f.submissions.length, 0);
  f.advance(999);
  await manager.pollNow('folder-one');
  assert.equal(f.submissions.length, 0);
  f.advance(1);
  await manager.pollNow('folder-one');
  assert.equal(f.submissions.length, 1);
  assert.equal(f.submissions[0].quantity, 2);
  assert.equal(f.submissions[0].source, 'folder:folder-one');
  assert.equal(await fs.readFile(model, 'utf8'), 'solid part\nendsolid part');
  await manager.stop();
  manager = await f.makeManager();
  await manager.pollNow('folder-one');
  assert.equal(f.submissions.length, 1);
  // A changed file represents a new design/order even at the same path.
  await fs.writeFile(model, 'solid revised-part\nendsolid revised-part');
  await manager.pollNow('folder-one');
  f.advance(1000);
  await manager.pollNow('folder-one');
  assert.equal(f.submissions.length, 2);
  assert.notEqual(f.submissions[0].sourceId, f.submissions[1].sourceId);
});

test('ongoing file writes reset stability and separate same-content filenames remain distinct orders', async t => {
  const f = await fixture(t);
  const inbox = path.join(f.dataDir, 'inbox');
  await fs.mkdir(inbox);
  f.configs.push({ id: 'folder', type: 'folder', path: inbox, settleMs: 1000 });
  await fs.writeFile(path.join(inbox, 'a.stl'), 'solid');
  const manager = await f.makeManager();
  await manager.pollNow('folder');
  f.advance(1000);
  await fs.appendFile(path.join(inbox, 'a.stl'), ' part\nendsolid part');
  await manager.pollNow('folder');
  assert.equal(f.submissions.length, 0);
  f.advance(1000);
  await manager.pollNow('folder');
  await fs.copyFile(path.join(inbox, 'a.stl'), path.join(inbox, 'b.stl'));
  await manager.pollNow('folder');
  f.advance(1000);
  await manager.pollNow('folder');
  assert.equal(f.submissions.length, 2);
  assert.notEqual(f.submissions[0].sourceId, f.submissions[1].sourceId);
});

test('folder skips partial, unsupported and symlink files without deleting anything', async t => {
  const f = await fixture(t);
  const inbox = path.join(f.dataDir, 'inbox');
  await fs.mkdir(inbox);
  await fs.writeFile(path.join(inbox, 'download.stl.part'), 'incomplete');
  await fs.writeFile(path.join(inbox, 'notes.txt'), 'not a print');
  await fs.writeFile(path.join(f.dataDir, 'external.stl'), 'secret outside inbox');
  if (process.platform !== 'win32') await fs.symlink(path.join(f.dataDir, 'external.stl'), path.join(inbox, 'linked.stl'));
  f.configs.push({ id: 'folder', type: 'folder', path: inbox, settleMs: 1000 });
  const manager = await f.makeManager();
  await manager.pollNow('folder');
  f.advance(1000);
  await manager.pollNow('folder');
  await manager.pollNow('folder');
  assert.equal(f.submissions.length, 0);
  assert.equal(f.events.filter(event => event.type === 'connector.file_skipped').length, 1);
  assert.equal(await fs.readFile(path.join(inbox, 'notes.txt'), 'utf8'), 'not a print');
});

test('folder retries a transient submission failure without losing or duplicating a file', async t => {
  const f = await fixture(t);
  const inbox = path.join(f.dataDir, 'inbox');
  await fs.mkdir(inbox);
  await fs.writeFile(path.join(inbox, 'part.gcode'), 'G28\nG1 X1 Y1');
  f.configs.push({ id: 'folder', type: 'folder', path: inbox, settleMs: 1000 });
  const submit = f.service.submit;
  let attempts = 0;
  f.service.submit = async input => { if (++attempts === 1) throw new Error('storage temporarily unavailable'); return submit(input); };
  const manager = await f.makeManager();
  await manager.pollNow('folder');
  f.advance(1000);
  const failed = await manager.pollNow('folder');
  assert.equal(failed.state, 'error');
  assert.equal(f.submissions.length, 0);
  const recovered = await manager.pollNow('folder');
  assert.equal(recovered.state, 'idle');
  assert.equal(f.submissions.length, 1);
  await manager.pollNow('folder');
  assert.equal(f.submissions.length, 1);
});

test('email imports real MIME attachments read-only and persists UID checkpoints across restart', async t => {
  const f = await fixture(t, [{ id: 'mail', type: 'email', host: 'mail.example.test', username: 'user', password: 'private-value' }]);
  const messages = new Map([[1, rawEmail()]]);
  let options;
  const mock = mailboxFactory(messages, { onOptions: value => { options = value; } });
  let manager = await f.makeManager({ imapFactory: mock.factory });
  await manager.pollNow('mail');
  assert.equal(f.submissions.length, 1);
  assert.equal(f.submissions[0].files[0].name, 'bracket.stl');
  assert.equal(f.submissions[0].files[0].data.toString(), 'solid bracket\nendsolid bracket');
  assert.equal(options.secure, true);
  assert.equal(options.tls.rejectUnauthorized, true);
  assert.equal(options.logger, false);
  assert.deepEqual(mock.calls.find(call => call[0] === 'lock').slice(1), ['INBOX', { readOnly: true }]);
  await manager.stop();
  manager = await f.makeManager({ imapFactory: mock.factory });
  await manager.pollNow('mail');
  assert.equal(f.submissions.length, 1);
  messages.set(2, rawEmail());
  await manager.pollNow('mail');
  assert.equal(f.submissions.length, 2, 'identical attached content in a new message is a new order');
  assert.notEqual(f.submissions[0].sourceId, f.submissions[1].sourceId);
  const checkpoint = await fs.readFile(manager.stateFile, 'utf8');
  assert.ok(!checkpoint.includes('private-value'));
  assert.ok(!checkpoint.includes('user'));
});

test('email retries failed submissions without advancing the message checkpoint', async t => {
  const f = await fixture(t, [{ id: 'mail', type: 'email', host: 'mail.example.test', username: 'user', password: 'private-value', secure: false }]);
  const messages = new Map([[1, rawEmail()]]);
  let options;
  const mock = mailboxFactory(messages, { onOptions: value => { options = value; } });
  const original = f.service.submit;
  let fail = true;
  f.service.submit = input => { if (fail) throw new Error('temporary failure'); return original(input); };
  const manager = await f.makeManager({ imapFactory: mock.factory });
  await manager.pollNow('mail');
  assert.equal(manager.checkpoints.connectors.mail.lastUid, 0);
  assert.equal(options.doSTARTTLS, true);
  assert.equal(options.secure, false);
  fail = false;
  await manager.pollNow('mail');
  assert.equal(manager.checkpoints.connectors.mail.lastUid, 1);
  assert.equal(f.submissions.length, 1);
});

test('IMAP UID validity changes reset the cursor without conflating different messages', async t => {
  const f = await fixture(t, [{ id: 'mail', type: 'email', host: 'mail.example.test', username: 'user', password: 'private-value' }]);
  const messages = new Map([[1, rawEmail()]]);
  const manager = await f.makeManager({ imapFactory: mailboxFactory(messages).factory });
  await manager.pollNow('mail');
  manager.imapFactory = mailboxFactory(messages, { validity: '200' }).factory;
  await manager.pollNow('mail');
  assert.equal(f.submissions.length, 2);
  assert.notEqual(f.submissions[0].sourceId, f.submissions[1].sourceId);
});

test('mail diagnostics redact exception details and apply retry backoff', async t => {
  const secret = 'do-not-log-this-secret';
  const f = await fixture(t, [{ id: 'mail', type: 'email', host: 'mail.example.test', username: 'user', password: secret }]);
  const mock = mailboxFactory(new Map(), { failConnect: Object.assign(new Error(`password=${secret}`), { authenticationFailed: true }) });
  const manager = await f.makeManager({ imapFactory: mock.factory });
  const first = await manager.pollNow('mail');
  const second = await manager.pollNow('mail');
  assert.equal(first.state, 'error');
  assert.match(first.error, /authentication failed/i);
  assert.ok(new Date(second.nextPollAt) > new Date(first.nextPollAt));
  assert.ok(!JSON.stringify([manager.status(), f.events]).includes(secret));
  assert.equal(f.events.length, 1);
});

test('disabled inputs do not poll and invalid connector config is rejected', async t => {
  const f = await fixture(t, [{ id: 'disabled', type: 'folder', path: path.join(os.tmpdir(), 'nonexistent'), enabled: false }]);
  const manager = await f.makeManager();
  assert.equal(manager.status()[0].state, 'disabled');
  await assert.rejects(manager.pollNow('disabled'), { status: 409 });
  assert.throws(() => validateConnector({ type: 'folder', path: 'relative/path' }), { status: 400 });
  assert.throws(() => validateConnector({ type: 'email', host: 'https://mail.example.test', username: 'x', password: 'x' }), { status: 400 });
  assert.throws(() => validateConnector({ type: 'email', host: 'mail.example.test', username: 'x', password: '' }), { status: 400 });
});

test('corrupt checkpoints are preserved and block imports instead of silently resetting', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.dataDir, 'connectors'));
  const checkpoint = path.join(f.dataDir, 'connectors', 'checkpoints.json');
  await fs.writeFile(checkpoint, '{corrupt');
  const manager = new ConnectorManager({ service: f.service });
  await assert.rejects(manager.start(), /checkpoints could not be read/);
  assert.equal(await fs.readFile(checkpoint, 'utf8'), '{corrupt');
});

test('watched-folder intake integrates with the persistent core and creates review jobs without dispatch', async t => {
  const { QuickPrintService } = require('../src/core/service');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-connector-core-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const inbox = path.join(directory, 'inbox');
  await fs.mkdir(inbox);
  const longName = `${'part-'.repeat(40)}.stl`;
  await fs.writeFile(path.join(inbox, longName), 'solid bracket\nendsolid bracket');
  const service = new QuickPrintService({ dataDir: path.join(directory, 'data') });
  let manager;
  try {
    await service.init();
    const config = await service.saveConnector({ type: 'folder', name: 'Design folder', path: inbox, settleMs: 1000, defaults: { quantity: 3 } });
    let time = 1700000000000;
    manager = new ConnectorManager({ service, now: () => time, tickMs: 86400000 });
    await manager.start();
    await manager.pollNow(config.id);
    time += 1000;
    await manager.pollNow(config.id);
    const { jobs } = service.snapshot();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, 'review');
    assert.equal(jobs[0].quantity, 3);
    assert.match(jobs[0].fileName, /\.stl$/);
    assert.ok(jobs[0].fileName.length <= 180);
    assert.equal(jobs[0].printerId, undefined);
    await manager.pollNow(config.id);
    assert.equal(service.snapshot().jobs.length, 1);
    assert.equal(await fs.readFile(path.join(inbox, longName), 'utf8'), 'solid bracket\nendsolid bracket');
  } finally {
    await manager?.stop();
    await service.close();
  }
});
