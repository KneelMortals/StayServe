#!/usr/bin/env node

/**
 * Operator CLI for the staged room-location privacy migration.
 *
 * The command uses the Firebase Admin SDK in `functions/lib`, so the caller
 * must already have an authenticated Admin SDK environment (Application
 * Default Credentials, an emulator, or another trusted local setup). The CLI
 * is deliberately separate from the app: no client can invoke it.
 *
 * Examples:
 *
 *   node tools/private_location_migration.mjs migrate
 *   node tools/private_location_migration.mjs migrate --apply
 *   node tools/private_location_migration.mjs verify --all
 *   ROOM_LOCATION_STAGE=private \
 *     node tools/private_location_migration.mjs finalize --apply
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const command = args[0];
const apply = args.includes('--apply');
const all = args.includes('--all');

function option(name, fallback) {
  const prefix = `--${name}=`;
  const found = args.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const limit = Math.min(
  200,
  Math.max(1, Number.parseInt(option('limit', '100'), 10) || 100),
);
const initialCursor = option('cursor', '') || null;

function usage() {
  console.error(
    [
      'Usage:',
      '  node tools/private_location_migration.mjs migrate [--apply] [--limit=N] [--cursor=ID]',
      '  node tools/private_location_migration.mjs verify [--all] [--limit=N] [--cursor=ID]',
      '  ROOM_LOCATION_STAGE=private node tools/private_location_migration.mjs finalize [--apply] [--limit=N] [--cursor=ID]',
      '  node tools/private_location_migration.mjs switch --enabled=true|false',
      '',
      'Without --apply, migration and finalization are dry runs.',
      'Use --all with verify to audit every room in one operation.',
    ].join('\n'),
  );
  process.exit(2);
}

if (!['migrate', 'verify', 'finalize', 'switch'].includes(command)) usage();

let privateLocations;
try {
  privateLocations = require(
    path.join(ROOT, 'functions', 'lib', 'privateLocations.js'),
  );
} catch (error) {
  console.error('Could not load the compiled Functions helpers.');
  console.error('Run `npm --prefix functions run build` first.');
  console.error(error);
  process.exit(1);
}

function printPage(page) {
  console.log(JSON.stringify(page, null, 2));
}

async function runPaged(operation, dryRun) {
  let cursor = initialCursor;
  let pageNumber = 0;

  while (true) {
    const page = await operation({
      cursor: cursor || undefined,
      limit,
      ...(dryRun === undefined ? {} : { dryRun }),
    });
    pageNumber += 1;
    printPage(page);

    if (!page.hasMore) return;
    if (!page.nextCursor || page.nextCursor === cursor) {
      throw new Error('The migration did not advance its cursor');
    }
    cursor = page.nextCursor;
    if (pageNumber >= 10000) {
      throw new Error('The migration exceeded the 10000-page safety limit');
    }
  }
}

async function runOnePage(operation) {
  printPage(
    await operation({
      cursor: initialCursor || undefined,
      limit,
    }),
  );
}

try {
  if (command === 'migrate') {
    await runPaged(
      privateLocations.migrateRoomPrivateLocationsPage,
      !apply,
    );
  } else if (command === 'verify') {
    if (all) {
      printPage(await privateLocations.verifyAllRoomPrivateLocations());
    } else {
      await runOnePage(privateLocations.verifyRoomPrivateLocationsPage);
    }
  } else if (command === 'finalize') {
    await runPaged(
      privateLocations.finalizeRoomLocationPrivacyPage,
      !apply,
    );
  } else {
    const enabledValue = option('enabled', '').toLowerCase();
    if (enabledValue !== 'true' && enabledValue !== 'false') {
      throw new Error('switch requires --enabled=true or --enabled=false');
    }
    const enabled = enabledValue === 'true';
    await privateLocations.setClientExactLocationWritesAllowed(enabled);
    console.log(
      JSON.stringify(
        {
          allowClientExactLocationWrites: enabled,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  }
} catch (error) {
  console.error(error?.message || error);
  process.exit(1);
}
