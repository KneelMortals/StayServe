// A tiny mail.tm helper used for the on-device sign-up test.
//
//   node tools/mail_inbox.mjs new     -> creates an inbox, prints the address
//                                         and stores the credentials in
//                                         .mail_inbox.json
//   node tools/mail_inbox.mjs code    -> waits for a 6-digit code and prints it
//   node tools/mail_inbox.mjs cleanup -> deletes the inbox again

import fs from 'fs';
import path from 'path';

const STORE = path.join(process.cwd(), '.mail_inbox.json');
const PASSWORD = 'TmpPass!2026x';

async function json(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

function load() {
  if (!fs.existsSync(STORE)) {
    throw new Error('No inbox yet — run `node tools/mail_inbox.mjs new` first');
  }
  return JSON.parse(fs.readFileSync(STORE, 'utf8'));
}

function save(v) {
  fs.writeFileSync(STORE, JSON.stringify(v, null, 2));
}

async function createInbox() {
  const domains = await json('https://api.mail.tm/domains');
  const domain = domains.body['hydra:member']?.[0]?.domain;
  if (!domain) throw new Error('mail.tm domains unavailable');

  const address = `stayserve.device.${Date.now()}@${domain}`;
  const created = await json('https://api.mail.tm/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, password: PASSWORD }),
  });
  if (created.status >= 400) {
    throw new Error('mail.tm account failed: ' + JSON.stringify(created.body).slice(0, 200));
  }

  const tokenRes = await json('https://api.mail.tm/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: created.body.address || address, password: PASSWORD }),
  });
  if (tokenRes.status >= 400) throw new Error('mail.tm token failed');

  const store = {
    id: created.body.id,
    address: created.body.address || address,
    token: tokenRes.body.token,
  };
  save(store);
  console.log(store.address);
}

async function readCode() {
  const store = load();
  const headers = { Authorization: `Bearer ${store.token}` };

  for (let i = 0; i < 30; i++) {
    const list = await json('https://api.mail.tm/messages', { headers });
    const msgs = list.body['hydra:member'] || [];
    for (const msg of msgs) {
      const full = await json(`https://api.mail.tm/messages/${msg.id}`, { headers });
      const text = [
        full.body.subject,
        full.body.text,
        ...(full.body['textAsHtml'] || []),
      ].join('\n');
      const m = text.match(/\b(\d{6})\b/);
      if (m) {
        console.log(m[1]);
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error('No 6-digit code arrived');
}

async function cleanup() {
  if (!fs.existsSync(STORE)) return;
  const store = load();
  await json(`https://api.mail.tm/accounts/${store.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${store.token}` },
  });
  fs.rmSync(STORE, { force: true });
  console.log('inbox deleted');
}

const cmd = process.argv[2];
if (cmd === 'new') await createInbox();
else if (cmd === 'code') await readCode();
else if (cmd === 'cleanup') await cleanup();
else {
  console.error('usage: mail_inbox.mjs new|code|cleanup');
  process.exit(2);
}
