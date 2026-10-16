'use strict';

const { MAX_FILE_BYTES, supportedFile, safeFileName } = require('./validation');

const MAX_MESSAGE_BYTES = 140 * 1024 * 1024;

async function pollEmail(manager, config, checkpoint) {
  const client = manager.imapFactory({
    host: config.host,
    port: config.port ?? (config.secure === false ? 143 : 993),
    secure: config.secure !== false,
    ...(config.secure === false ? { doSTARTTLS: true } : {}),
    auth: { user: config.username, pass: config.password },
    tls: { rejectUnauthorized: true },
    logger: false,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    disableAutoIdle: true,
  });
  manager.clients.add(client);
  // ImapFlow emits errors in addition to rejecting commands. Never log raw
  // library errors because they can include mailbox or credential details.
  const onError = () => {};
  client.on?.('error', onError);
  let lock;
  try {
    await client.connect();
    lock = await client.getMailboxLock(config.mailbox || 'INBOX', { readOnly: true });
    const uidValidity = String(client.mailbox?.uidValidity ?? '');
    if (!/^\d+$/.test(uidValidity)) throw Object.assign(new Error('Mailbox UID validity is unavailable.'), { code: 'UIDVALIDITY' });
    if (checkpoint.uidValidity !== uidValidity) {
      checkpoint.uidValidity = uidValidity;
      checkpoint.lastUid = 0;
      await manager.persist();
    }
    const found = await client.search({ uid: `${checkpoint.lastUid + 1}:*` }, { uid: true });
    const ids = (Array.isArray(found) ? found : []).filter(uid => Number.isInteger(uid) && uid > checkpoint.lastUid).sort((a, b) => a - b).slice(0, 25);
    for (const uid of ids) {
      if (manager.stopping) break;
      const metadata = await client.fetchOne(uid, { uid: true, size: true }, { uid: true });
      if (!metadata) { checkpoint.lastUid = uid; await manager.persist(); continue; }
      if (!Number.isFinite(metadata.size) || metadata.size < 0 || metadata.size > MAX_MESSAGE_BYTES) {
        await manager.event(config, 'warning', 'connector.message_skipped', 'An email exceeded the 140 MiB message limit or did not report a valid size.');
        checkpoint.lastUid = uid;
        await manager.persist();
        continue;
      }
      const message = await client.fetchOne(uid, { uid: true, source: { start: 0, maxLength: MAX_MESSAGE_BYTES + 1 } }, { uid: true });
      if (!message) { checkpoint.lastUid = uid; await manager.persist(); continue; }
      if (!Buffer.isBuffer(message.source) || message.source.length > MAX_MESSAGE_BYTES) throw Object.assign(new Error('Message source could not be read.'), { code: 'MESSAGE_SOURCE' });
      let parsed;
      try {
        parsed = await manager.parseMail(message.source, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
      } catch {
        // Keep the cursor behind a transient parser failure; no message is lost.
        throw Object.assign(new Error('Email attachment parsing failed.'), { code: 'MAIL_PARSE' });
      }
      const files = [];
      let skipped = 0;
      for (const attachment of parsed.attachments || []) {
        const name = safeFileName(attachment.filename);
        if (!name || !supportedFile(name) || !Buffer.isBuffer(attachment.content) || attachment.content.length === 0 || attachment.content.length > MAX_FILE_BYTES) { skipped++; continue; }
        files.push({ name, data: attachment.content });
      }
      if (files.length > 50) throw Object.assign(new Error('Too many print attachments in one message.'), { code: 'ATTACHMENT_COUNT' });
      if (files.length) {
        const result = await manager.service.submit({
          source: `email:${config.id}`,
          sourceId: `${checkpoint.location}:${uidValidity}:${uid}`,
          name: String(parsed.subject || files[0].name).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200),
          customer: config.defaults?.customer || String(parsed.from?.text || '').slice(0, 500),
          quantity: config.defaults?.quantity || 1,
          notes: config.defaults?.notes || '',
          files,
        });
        if (!result.duplicate) manager.imported(config.id, result.jobs?.length || files.length);
      }
      if (skipped) await manager.event(config, 'warning', 'connector.attachments_skipped', 'Unsupported, empty or oversized email attachments were skipped. Only supported print files are imported.');
      checkpoint.lastUid = uid;
      await manager.persist();
    }
  } finally {
    try { lock?.release(); } catch { /* Connection may already have closed. */ }
    try { await client.logout(); } catch { try { client.close(); } catch { /* Already closed. */ } }
    client.removeListener?.('error', onError);
    manager.clients.delete(client);
  }
}

module.exports = { pollEmail };
