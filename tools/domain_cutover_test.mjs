import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
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
  waitForOperation,
} from './domain_cutover_lib.mjs';

const FALLBACK = 'https://myfirstapp-fa30f52b.web.app';
const TARGET = 'https://stayserve.co.in';

function sourceFiles(origin = FALLBACK) {
  return {
    'web/index.html': `<link rel="canonical" href="${origin}/"><meta property="og:url" content="${origin}/">`,
    'web/home/index.html': `<link rel="canonical" href="${origin}/home/"><meta property="og:url" content="${origin}/home/">`,
    'web/terms/index.html': `<link rel="canonical" href="${origin}/terms/"><meta property="og:url" content="${origin}/terms/">`,
    'web/privacy-policy/index.html': `<link rel="canonical" href="${origin}/privacy-policy/"><meta property="og:url" content="${origin}/privacy-policy/">`,
    'web/robots.txt': `User-agent: *\nSitemap: ${origin}/sitemap.xml\n`,
    'web/sitemap.xml': `<url><loc>${origin}/home/</loc><lastmod>2026-01-01</lastmod></url>`,
    'storage.cors.json': JSON.stringify(
      [{origin: [FALLBACK], method: ['GET', 'HEAD']}],
      null,
      2,
    ),
  };
}

test('domain names are normalized and invalid values fail closed', () => {
  assert.equal(normalizeHostname(' StayServe.CO.IN. '), 'stayserve.co.in');
  assert.throws(() => normalizeHostname('localhost'));
  assert.throws(() => normalizeHostname('bad..example'));
  assert.throws(() => normalizeHostname('-bad.example'));
});

test('canonical sitemap origins must be absolute HTTPS sitemap URLs', () => {
  assert.equal(
    parseCanonicalOrigin(`Sitemap: ${FALLBACK}/sitemap.xml`),
    FALLBACK,
  );
  assert.throws(() => parseCanonicalOrigin('Sitemap: /sitemap.xml'));
  assert.throws(() =>
    parseCanonicalOrigin(`Sitemap: ${FALLBACK}/other.xml`),
  );
  assert.throws(() =>
    parseCanonicalOrigin(`Sitemap: ${FALLBACK}/sitemap.xml?token=value`),
  );
});

test('canonical alignment replaces every public origin and is idempotent', () => {
  const first = planOriginAlignment(sourceFiles(), {
    targetOrigin: TARGET,
    allowedCurrentOrigins: [FALLBACK, TARGET],
    lastModified: '2026-11-22',
  });

  assert.equal(first.currentOrigin, FALLBACK);
  assert.equal(first.targetOrigin, TARGET);
  assert.equal(first.changes.size, 7);
  assert.match(first.changes.get('web/robots.txt'), /stayserve\.co\.in/);
  assert.match(first.changes.get('web/sitemap.xml'), /<lastmod>2026-11-22<\/lastmod>/);
  assert.match(first.changes.get('storage.cors.json'), /stayserve\.co\.in/);

  const aligned = Object.fromEntries(
    [...first.changes].map(([file, content]) => [
      file,
      content,
    ]),
  );
  const complete = {...sourceFiles(), ...aligned};
  const second = planOriginAlignment(complete, {
    targetOrigin: TARGET,
    allowedCurrentOrigins: [FALLBACK, TARGET],
    lastModified: '2026-11-23',
  });
  assert.equal(second.changes.size, 0);
});

test('canonical file changes are written and remain idempotent', async () => {
  const projectRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'stayserve-domain-cutover-'),
  );

  try {
    const fixture = sourceFiles();
    for (const [relativePath, content] of Object.entries(fixture)) {
      const absolutePath = path.join(projectRoot, relativePath);
      await fs.mkdir(path.dirname(absolutePath), {recursive: true});
      await fs.writeFile(absolutePath, content);
    }

    const first = planOriginAlignment(fixture, {
      targetOrigin: TARGET,
      allowedCurrentOrigins: [FALLBACK, TARGET],
      lastModified: '2026-11-22',
    });
    await applyFileChanges(projectRoot, first.changes);

    const aligned = await readProjectFiles(projectRoot, Object.keys(fixture));
    assert.match(aligned['web/robots.txt'], /stayserve\.co\.in/);
    assert.match(aligned['storage.cors.json'], /stayserve\.co\.in/);

    const second = planOriginAlignment(aligned, {
      targetOrigin: TARGET,
      allowedCurrentOrigins: [FALLBACK, TARGET],
      lastModified: '2026-11-23',
    });
    assert.equal(second.changes.size, 0);
  } finally {
    await fs.rm(projectRoot, {recursive: true, force: true});
  }
});

test('canonical alignment refuses an unexpected source origin', () => {
  assert.throws(
    () =>
      planOriginAlignment(sourceFiles('https://untrusted.example'), {
        targetOrigin: TARGET,
        allowedCurrentOrigins: [FALLBACK, TARGET],
      }),
    /unexpected canonical origin/,
  );
});

test('canonical alignment refuses conflicting HTML metadata', () => {
  const files = sourceFiles();
  files['web/terms/index.html'] =
    '<link rel="canonical" href="https://untrusted.example/terms/">' +
    '<meta property="og:url" content="https://untrusted.example/terms/">';

  assert.throws(
    () =>
      planOriginAlignment(files, {
        targetOrigin: TARGET,
        allowedCurrentOrigins: [FALLBACK, TARGET],
      }),
    /canonical URL outside the target origin/,
  );
});

test('canonical alignment requires a CORS rule which allows GET', () => {
  const files = sourceFiles();
  files['storage.cors.json'] = JSON.stringify(
    [{origin: [FALLBACK], method: ['HEAD']}],
    null,
    2,
  );

  assert.throws(
    () =>
      planOriginAlignment(files, {
        targetOrigin: TARGET,
        allowedCurrentOrigins: [FALLBACK, TARGET],
      }),
    /must contain a rule which allows GET/,
  );
});

test('domain readiness requires ownership, host routing, and active TLS', () => {
  const ready = {
    ownershipState: 'OWNERSHIP_ACTIVE',
    hostState: 'HOST_ACTIVE',
    cert: {state: 'CERT_ACTIVE'},
    issues: [],
  };
  assert.equal(isDomainReady(ready), true);
  assert.deepEqual(getDomainReadinessProblems(ready), []);

  const pending = {
    ownershipState: 'OWNERSHIP_PENDING',
    hostState: 'HOST_UNHOSTED',
    cert: {state: 'CERT_PREPARING'},
  };
  assert.equal(isDomainReady(pending), false);
  assert.equal(getDomainReadinessProblems(pending).length, 3);
});

test('Firebase desired DNS records are reported without hard-coded values', () => {
  const domain = {
    requiredDnsUpdates: {
      desired: [
        {
          domainName: 'stayserve.co.in.',
          records: [
            {type: 'A', rdata: '192.0.2.1', requiredAction: 'ADD'},
            {type: 'TXT', rdata: 'firebase-site-verification=example', requiredAction: 'ADD'},
          ],
        },
      ],
    },
  };
  const records = getDesiredDnsRecords(domain);
  assert.equal(records.length, 2);
  assert.equal(records[0].host, 'stayserve.co.in.');
  assert.match(formatDnsRecords(records), /192\.0\.2\.1/);
  assert.match(formatDnsRecords(records), /firebase-site-verification=example/);
});

test('attaching an existing domain is idempotent', async () => {
  const existing = {
    name: 'projects/project/sites/site/customDomains/stayserve.co.in',
    ownershipState: 'OWNERSHIP_PENDING',
  };
  let createCalls = 0;
  const api = {
    async listCustomDomains() {
      return [existing];
    },
    async createCustomDomain() {
      createCalls += 1;
      throw new Error('create should not run');
    },
  };

  const result = await ensureCustomDomain(api, {
    projectId: 'project',
    siteId: 'site',
    domain: 'stayserve.co.in',
  });
  assert.equal(result.created, false);
  assert.equal(result.domain, existing);
  assert.equal(createCalls, 0);
});

test('attaching a new domain validates first and waits for the operation', async () => {
  const calls = [];
  const attached = {
    name: 'projects/project/sites/site/customDomains/stayserve.co.in',
    ownershipState: 'OWNERSHIP_PENDING',
  };
  const api = {
    async listCustomDomains() {
      return [];
    },
    async createCustomDomain(projectId, siteId, domain, options) {
      calls.push({domain, options});
      return {name: 'operations/one', done: true, response: {}};
    },
    async getCustomDomain() {
      return attached;
    },
  };

  const result = await ensureCustomDomain(api, {
    projectId: 'project',
    siteId: 'site',
    domain: 'stayserve.co.in',
  });
  assert.equal(result.created, true);
  assert.equal(result.domain, attached);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.validateOnly, true);
  assert.equal(calls[1].options.validateOnly, false);
});

test('attaching refuses to repoint an existing redirect', async () => {
  const api = {
    async listCustomDomains() {
      return [
        {
          name: 'projects/project/sites/site/customDomains/www.stayserve.co.in',
          redirectTarget: 'other.example',
        },
      ];
    },
  };

  await assert.rejects(
    ensureCustomDomain(api, {
      projectId: 'project',
      siteId: 'site',
      domain: 'www.stayserve.co.in',
      redirectTarget: 'stayserve.co.in',
    }),
    /refusing to change it automatically/,
  );
});

test('operation polling returns the completed response', async () => {
  let polls = 0;
  const api = {
    async getOperation() {
      polls += 1;
      return {
        done: true,
        response: {name: 'projects/project/sites/site/customDomains/domain'},
      };
    },
  };

  const response = await waitForOperation(
    api,
    {name: 'operations/one'},
    {sleep: async () => {}},
  );
  assert.equal(polls, 1);
  assert.match(response.name, /customDomains\/domain$/);
});
