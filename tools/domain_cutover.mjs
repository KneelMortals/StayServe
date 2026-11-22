#!/usr/bin/env node

// Prepares the StayServe custom-domain cutover without changing DNS or
// deploying Hosting.
//
// Read-only status (default):
//   node tools/domain_cutover.mjs status
//
// Idempotently attach the canonical domain, and optionally the www redirect:
//   node tools/domain_cutover.mjs attach \
//     --confirm-domain=stayserve.co.in --include-www
//
// Preview or apply the checked-in canonical-origin changes after Firebase
// reports DNS ownership, host routing, and TLS certificate as active:
//   node tools/domain_cutover.mjs align \
//     --confirm-domain=stayserve.co.in [--apply]
//
// This tool never deletes a domain, changes registrar DNS, applies Storage
// CORS, or deploys a Hosting release.

import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  CORS_FILE,
  PUBLIC_ORIGIN_FILES,
  FirebaseHostingApi,
  applyFileChanges,
  ensureCustomDomain,
  formatDnsRecords,
  getDesiredDnsRecords,
  getDomainReadinessProblems,
  isDomainReady,
  normalizeHostname,
  parseCanonicalOrigin,
  planOriginAlignment,
  readProjectFiles,
} from './domain_cutover_lib.mjs';

const require = createRequire(import.meta.url);
const firebaseToolsAuth = require('firebase-tools/lib/auth');

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const CONFIG_FILE = path.join(
  PROJECT_ROOT,
  'tools',
  'domain-cutover.config.json',
);

function fail(message) {
  throw new Error(message);
}

function parseArguments(argumentsList) {
  const [command = 'status', ...rest] = argumentsList;
  const options = {
    apply: false,
    includeWww: false,
    confirmDomain: null,
  };

  for (const argument of rest) {
    if (argument === '--apply') {
      options.apply = true;
    } else if (argument === '--include-www') {
      options.includeWww = true;
    } else if (argument.startsWith('--confirm-domain=')) {
      options.confirmDomain = argument.slice('--confirm-domain='.length);
    } else {
      fail(`Unknown option: ${argument}`);
    }
  }

  return {command, options};
}

async function loadConfiguration() {
  const configuration = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
  const projectId = String(configuration.projectId || '').trim();
  const hostingSiteId = String(configuration.hostingSiteId || '').trim();
  const canonicalDomain = normalizeHostname(configuration.canonicalDomain);
  const redirectDomain = normalizeHostname(configuration.redirectDomain);
  const fallbackUrl = new URL(configuration.fallbackOrigin);
  const fallbackOrigin = fallbackUrl.origin;

  if (!projectId || !hostingSiteId) {
    fail('The cutover configuration must define projectId and hostingSiteId.');
  }
  if (!/^[a-z0-9-]+$/.test(projectId) || !/^[a-z0-9-]+$/.test(hostingSiteId)) {
    fail('The cutover project and Hosting site IDs contain invalid characters.');
  }
  if (
    fallbackUrl.protocol !== 'https:' ||
    fallbackUrl.pathname !== '/' ||
    fallbackUrl.username ||
    fallbackUrl.password ||
    fallbackUrl.search ||
    fallbackUrl.hash
  ) {
    fail('The fallback origin must be an HTTPS origin.');
  }
  if (redirectDomain !== `www.${canonicalDomain}`) {
    fail('The redirect domain must be www.<canonical domain>.');
  }
  if (fallbackOrigin === `https://${canonicalDomain}`) {
    fail('The fallback origin must differ from the canonical origin.');
  }

  const firebaserc = JSON.parse(
    await fs.readFile(path.join(PROJECT_ROOT, '.firebaserc'), 'utf8'),
  );
  if (firebaserc.projects?.default !== projectId) {
    fail(
      `The cutover project ${projectId} does not match .firebaserc ` +
        `(${firebaserc.projects?.default || 'missing'}).`,
    );
  }

  return {
    projectId,
    hostingSiteId,
    canonicalDomain,
    redirectDomain,
    fallbackOrigin,
    targetOrigin: `https://${canonicalDomain}`,
  };
}

async function accessToken() {
  const account =
    firebaseToolsAuth.getProjectDefaultAccount(PROJECT_ROOT) ||
    firebaseToolsAuth.getGlobalDefaultAccount();
  if (!account?.tokens?.refresh_token) {
    fail('No Firebase CLI refresh token. Run `firebase login` first.');
  }

  const token = await firebaseToolsAuth.getAccessToken(
    account.tokens.refresh_token,
    ['https://www.googleapis.com/auth/cloud-platform'],
  );
  if (!token?.access_token) {
    fail('Could not refresh the Firebase CLI access token.');
  }
  return token.access_token;
}

async function createApi() {
  return new FirebaseHostingApi({token: await accessToken()});
}

function findDomain(domains, domainName) {
  return domains.find((domain) => domain.name?.endsWith(`/customDomains/${domainName}`));
}

export function getDomainStatusAction(canonical, redirect, configuration) {
  if (!canonical) {
    return (
      'Attach the domain with the attach command, then apply the exact DNS records.'
    );
  }
  if (canonical.redirectTarget) {
    return (
      `${configuration.canonicalDomain} is configured as a redirect to ` +
      `${canonical.redirectTarget}; canonical alignment is blocked.`
    );
  }
  if (!isDomainReady(canonical)) {
    return 'Apply the exact Firebase-requested DNS records at the registrar.';
  }
  if (!redirect) {
    return (
      'Attach the www redirect with the attach command and --include-www.'
    );
  }
  if (redirect.redirectTarget !== configuration.canonicalDomain) {
    return (
      `${configuration.redirectDomain} has an unexpected redirect target. ` +
      'The helper will not repoint it automatically; review it in Firebase.'
    );
  }
  return 'Run the align command with --apply to update checked-in canonical URLs.';
}

function printDomainStatus(domain) {
  const certState = domain.cert?.state || domain.certState || 'unknown';
  console.log(`- ${domain.name?.split('/').pop()}`);
  console.log(`  DNS ownership: ${domain.ownershipState || 'unknown'}`);
  console.log(`  Host routing:  ${domain.hostState || 'unknown'}`);
  console.log(`  TLS certificate: ${certState}`);
  console.log(`  Redirect target: ${domain.redirectTarget || '(none)'}`);

  const problems = getDomainReadinessProblems(domain);
  if (problems.length > 0) {
    for (const problem of problems) {
      console.log(`  Not ready: ${problem}`);
    }
  } else {
    console.log('  Ready: DNS ownership, host routing, and TLS are active.');
  }
}

async function printStatus(api, configuration) {
  const domains = await api.listCustomDomains(
    configuration.projectId,
    configuration.hostingSiteId,
  );

  console.log(
    `Firebase project: ${configuration.projectId}`,
  );
  console.log(`Hosting site:    ${configuration.hostingSiteId}`);
  console.log(`Canonical target: ${configuration.targetOrigin}`);
  console.log(`Redirect target:  https://${configuration.redirectDomain}`);
  console.log('Custom domains:');

  if (domains.length === 0) {
    console.log('- (none attached)');
  } else {
    for (const domain of domains) {
      printDomainStatus(domain);
    }
  }

  const canonical = findDomain(domains, configuration.canonicalDomain);
  console.log('\nFirebase-requested DNS records:');
  if (domains.length === 0) {
    console.log('No records are available until a domain is attached.');
  } else {
    for (const domain of domains) {
      console.log(`\n${domain.name?.split('/').pop()}:`);
      console.log(formatDnsRecords(getDesiredDnsRecords(domain)));
    }
  }

  const files = await readProjectFiles(PROJECT_ROOT, [
    ...PUBLIC_ORIGIN_FILES,
    CORS_FILE,
  ]);
  const localOrigin = parseCanonicalOrigin(files['web/robots.txt']);
  console.log(`\nChecked-in canonical origin: ${localOrigin}`);
  console.log(
    localOrigin === configuration.targetOrigin
      ? 'Local canonical URLs already use the target origin.'
      : `Local canonical URLs still use ${localOrigin}; alignment is gated on the remote readiness checks.`,
  );

  const redirect = findDomain(domains, configuration.redirectDomain);
  console.log('\nNext action:');
  console.log(
    getDomainStatusAction(canonical, redirect, configuration),
  );
}

function requireConfirmation(configuration, options) {
  if (options.confirmDomain !== configuration.canonicalDomain) {
    fail(
      `Pass --confirm-domain=${configuration.canonicalDomain} for this mutating command.`,
    );
  }
}

export async function attachDomains(
  api,
  configuration,
  options,
  {logger = console} = {},
) {
  requireConfirmation(configuration, options);

  const canonical = await ensureCustomDomain(api, {
    projectId: configuration.projectId,
    siteId: configuration.hostingSiteId,
    domain: configuration.canonicalDomain,
  });
  logger.log(
    canonical.created
      ? `Attached ${configuration.canonicalDomain} to Firebase Hosting.`
      : `${configuration.canonicalDomain} was already attached; no change was made.`,
  );

  if (options.includeWww) {
    const redirect = await ensureCustomDomain(api, {
      projectId: configuration.projectId,
      siteId: configuration.hostingSiteId,
      domain: configuration.redirectDomain,
      redirectTarget: configuration.canonicalDomain,
    });
    logger.log(
      redirect.created
        ? `Attached ${configuration.redirectDomain} as a redirect to ${configuration.canonicalDomain}.`
        : `${configuration.redirectDomain} was already attached with the expected redirect; no change was made.`,
    );
  }

  logger.log(
    '\nNo DNS records were changed. Apply the Firebase-requested records below ' +
      'at the registrar according to their ACTION values:',
  );
  const domains = await api.listCustomDomains(
    configuration.projectId,
    configuration.hostingSiteId,
  );
  for (const domainName of [
    configuration.canonicalDomain,
    ...(options.includeWww ? [configuration.redirectDomain] : []),
  ]) {
    const domain = findDomain(domains, domainName);
    logger.log(`\n${domainName}:`);
    logger.log(formatDnsRecords(getDesiredDnsRecords(domain)));
  }
}

export async function alignCanonicalSources(
  api,
  configuration,
  options,
  {projectRoot = PROJECT_ROOT, logger = console} = {},
) {
  requireConfirmation(configuration, options);

  const domains = await api.listCustomDomains(
    configuration.projectId,
    configuration.hostingSiteId,
  );
  const canonical = findDomain(domains, configuration.canonicalDomain);
  if (!canonical) {
    fail(`${configuration.canonicalDomain} is not attached to Firebase Hosting.`);
  }
  if (canonical.redirectTarget) {
    fail(
      `${configuration.canonicalDomain} is configured as a redirect to ` +
        `${canonical.redirectTarget}; refusing to align canonical URLs.`,
    );
  }

  const redirect = findDomain(domains, configuration.redirectDomain);
  if (!redirect) {
    fail(
      `${configuration.redirectDomain} is not attached. Run the attach command ` +
        'with --include-www before aligning canonical URLs.',
    );
  }
  if (redirect.redirectTarget !== configuration.canonicalDomain) {
    fail(
      `${configuration.redirectDomain} does not redirect to ` +
        `${configuration.canonicalDomain}; refusing to align canonical URLs.`,
    );
  }

  const problems = getDomainReadinessProblems(canonical);
  if (problems.length > 0) {
    fail(
      'Refusing to align canonical URLs before Firebase reports the domain ready:\n- ' +
        problems.join('\n- '),
    );
  }

  const files = await readProjectFiles(projectRoot, [
    ...PUBLIC_ORIGIN_FILES,
    CORS_FILE,
  ]);
  const plan = planOriginAlignment(files, {
    targetOrigin: configuration.targetOrigin,
    allowedCurrentOrigins: [
      configuration.fallbackOrigin,
      configuration.targetOrigin,
    ],
  });

  if (plan.changes.size === 0) {
    logger.log(
      'The checked-in canonical URLs and CORS policy are already aligned.',
    );
    return;
  }

  logger.log(
    `Canonical origin: ${plan.currentOrigin} -> ${plan.targetOrigin}`,
  );
  logger.log('Files to update:');
  for (const relativePath of plan.changes.keys()) {
    logger.log(`- ${relativePath}`);
  }

  if (!options.apply) {
    logger.log('\nDry run only. Add --apply to update the checked-in files.');
    return;
  }

  await applyFileChanges(projectRoot, plan.changes);
  logger.log(`\nUpdated ${plan.changes.size} checked-in file(s).`);
  logger.log(
    'No Storage CORS policy was applied and no Hosting release was deployed.',
  );
}

function printHelp() {
  console.log(`StayServe Firebase Hosting domain cutover

Usage:
  node tools/domain_cutover.mjs status
  node tools/domain_cutover.mjs attach --confirm-domain=DOMAIN [--include-www]
  node tools/domain_cutover.mjs align --confirm-domain=DOMAIN [--apply]

Commands:
  status   Show attached domains, readiness, Firebase-requested DNS records,
           and the current checked-in canonical origin. This is read-only.
  attach   Idempotently attach the canonical domain. Optionally attach www as
           a permanent redirect. This never changes DNS.
  align    Update checked-in canonical URLs and the CORS allowlist after the
           remote domain is fully active. Use --apply to write the files.

This tool never deletes domains, changes registrar DNS, applies Storage CORS,
or deploys Hosting.`);
}

export async function main() {
  const {command, options} = parseArguments(process.argv.slice(2));
  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }
  if (!['status', 'attach', 'align'].includes(command)) {
    fail(`Unknown command: ${command}. Run with help for usage.`);
  }

  const configuration = await loadConfiguration();
  const api = await createApi();

  if (command === 'status') {
    await printStatus(api, configuration);
  } else if (command === 'attach') {
    await attachDomains(api, configuration, options);
  } else {
    await alignCanonicalSources(api, configuration, options);
  }
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((error) => {
    console.error(`ERROR  ${error.message || error}`);
    process.exitCode = 1;
  });
}
