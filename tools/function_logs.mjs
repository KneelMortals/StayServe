// Reads the logs of one function from Cloud Logging.
//
//   node tools/function_logs.mjs <functionName> [sinceIso]

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PROJ = 'myfirstapp-fa30f52b';
const NAME = process.argv[2] || 'cleanOldNotifications';
const SINCE = process.argv[3] || '2026-11-14T00:00:00Z';

const raw = await readFile(
  join(homedir(), '.config/configstore/firebase-tools.json'),
  'utf8',
);
const token = JSON.parse(raw).tokens.access_token;

const filter = [
  'resource.type="cloud_function"',
  `resource.labels.function_name="${NAME}"`,
  `timestamp>="${SINCE}"`,
].join(' AND ');

const url = `https://logging.googleapis.com/v2/entries:list`;

const res = await fetch(url, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    resourceNames: [`projects/${PROJ}`],
    filter,
    pageSize: 100,
    orderBy: 'timestamp desc',
  }),
});
const text = await res.text();
if (res.status !== 200) {
  console.log('HTTP', res.status, text.slice(0, 400));
  process.exit(2);
}

const json = JSON.parse(text);
const entries = json.entries || [];
console.log(`${entries.length} log entr(ies)\n`);

for (const entry of entries) {
  const payload =
    entry.textPayload ||
    (entry.jsonPayload ? JSON.stringify(entry.jsonPayload) : '') ||
    (entry.insertId || '');
  console.log(`${entry.timestamp} [${entry.severity}] ${payload.slice(0, 220)}`);
}
