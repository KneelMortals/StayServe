import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  applyFileChanges,
  ensureCustomDomain,
  formatDnsRecords,
  getDesiredDnsRecords,
  getDomainReadinessProblems,
  HostingApiError,
  isDomainReady,
  normalizeHostname,
  parseCanonicalOrigin,
  planOriginAlignment,
  readProjectFiles,
  waitForOperation,
} from './domain_cutover_lib.mjs';
import {
  alignCanonicalSources,
  attachDomains,
  getDomainStatusAction,
} from './domain_cutover.mjs';

const FALLBACK = 'https://myfirstapp-fa30f52b.web.app';
const TARGET = 'https://stayserve.co.in';

function sourceFiles(origin = FALLBACK) {
  return {
    'web/index.html': `<link rel="canonical" href="${origin}/"><meta property="og:url" content="${origin}/">`,
    'web/home/index.html': `<link rel="canonical" href="${origin}/home/"><meta property="og:url" content="${origin}/home/">`,
    'web/terms/index.html': `<link rel="canonical" href="${origin}/terms/"><meta property="og:url" content="${origin}/terms/">`,
    'web/privacy-policy/index.html': `<link rel="canonical" href="${origin}/privacy-policy/"><meta property="og:url" content="${origin}/privacy-policy/">`,
    'web/robots.txt': `User-agent: *\nSitemap: ${origin}/sitemap.xml\n`,
    'web/sitemap.xml': [
      `<url><loc>${origin}/home/</loc><lastmod>2026-01-01</lastmod></url>`,
      `<url><loc>${origin}/terms/</loc><lastmod>2026-01-01</lastmod></url>`,
      `<url><loc>${origin}/privacy-policy/</loc><lastmod>2026-01-01</lastmod></url>`,
    ].join('\n'),
    'storage.cors.json': JSON.stringify(
      [{origin: [FALLBACK], method: ['GET', 'HEAD']}],
      null,
      2,
    ),
  };
}

const CONFIGURATION = {
  projectId: 'project',
  siteId: 'site',
  canonicalDomain: 'stayserve.co.in',
  redirectDomain: 'www.stayserve.co.in',
  fallbackOrigin: FALLBACK,
  targetOrigin: TARGET,
};

const NOOP_LOGGER = {log() {}};

async function writeProjectFixture(projectRoot, files = sourceFiles()) {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(projectRoot, relativePath);
    await fs.mkdir(path.dirname(absolutePath), {recursive: true});
    await fs.writeFile(absolutePath, content);
  }
}

function readyCanonical(overrides = {}) {
  return {
    name: 'projects/project/sites/site/customDomains/stayserve.co.in',
    ownershipState: 'OWNERSHIP_ACTIVE',
    hostState: 'HOST_ACTIVE',
    cert: {state: 'CERT_ACTIVE'},
    issues: [],
    ...overrides,
  };
}

function readyRedirect(overrides = {}) {
  return {
    name: 'projects/project/sites/site/customDomains/www.stayserve.co.in',
    redirectTarget: 'stayserve.co.in',
    ...overrides,
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

test('canonical alignment refuses unexpected sitemap URLs', () => {
  const files = sourceFiles();
  files['web/sitemap.xml'] +=
    '\n<url><loc>https://untrusted.example/extra/</loc></url>';

  assert.throws(
    () =>
      planOriginAlignment(files, {
        targetOrigin: TARGET,
        allowedCurrentOrigins: [FALLBACK, TARGET],
      }),
    /unexpected public URL/,
  );
});

test('canonical alignment refuses sitemap queries and fragments', () => {
  const files = sourceFiles();
  files['web/sitemap.xml'] = files['web/sitemap.xml'].replace(
    `${FALLBACK}/home/`,
    `${FALLBACK}/home/?campaign=1`,
  );

  assert.throws(
    () =>
      planOriginAlignment(files, {
        targetOrigin: TARGET,
        allowedCurrentOrigins: [FALLBACK, TARGET],
      }),
    /without credentials, a query, or a fragment/,
  );
});

test('built-output SEO verification rejects sitemap query strings', async () => {
  const projectRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'stayserve-seo-verifier-'),
  );

  try {
    await writeProjectFixture(projectRoot, {
      'robots.txt': `User-agent: *\nSitemap: ${FALLBACK}/sitemap.xml\n`,
      'sitemap.xml': [
        `<url><loc>${FALLBACK}/home/?campaign=1</loc></url>`,
        `<url><loc>${FALLBACK}/terms/</loc></url>`,
        `<url><loc>${FALLBACK}/privacy-policy/</loc></url>`,
      ].join('\n'),
      'index.html': [
        `<link rel="canonical" href="${FALLBACK}/">`,
        `<meta property="og:url" content="${FALLBACK}/">`,
        '<meta name="robots" content="noindex, follow">',
      ].join(''),
      'home/index.html': [
        `<link rel="canonical" href="${FALLBACK}/home/">`,
        `<meta property="og:url" content="${FALLBACK}/home/">`,
        '<meta name="robots" content="index, follow">',
      ].join(''),
      'terms/index.html': `<link rel="canonical" href="${FALLBACK}/terms/">`,
      'privacy-policy/index.html': `<link rel="canonical" href="${FALLBACK}/privacy-policy/">`,
    });

    const result = spawnSync(
      process.execPath,
      [path.resolve('tools/verify_web_seo.mjs'), projectRoot],
      {encoding: 'utf8'},
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Sitemap URL must not contain a query/);
  } finally {
    await fs.rm(projectRoot, {recursive: true, force: true});
  }
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
    /canonical URL is outside the target origin/,
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

test('Firebase desired and certificate DNS records are reported without hard-coded values', () => {
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
    cert: {
      verification: {
        dns: {
          desired: [
            {
              domainName: '_acme-challenge.stayserve.co.in.',
              records: [
                {
                  type: 'TXT',
                  rdata: 'certificate-challenge=example',
                  requiredAction: 'ADD',
                },
              ],
            },
          ],
        },
      },
    },
  };
  const records = getDesiredDnsRecords(domain);
  assert.equal(records.length, 3);
  assert.equal(records[0].source, 'hosting');
  assert.equal(records[2].source, 'certificate');
  assert.equal(records[0].host, 'stayserve.co.in.');
  assert.match(formatDnsRecords(records), /192\.0\.2\.1/);
  assert.match(formatDnsRecords(records), /firebase-site-verification=example/);
  assert.match(formatDnsRecords(records), /certificate-challenge=example/);
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

test('status does not recommend alignment for a redirecting canonical domain', () => {
  const action = getDomainStatusAction(
    readyCanonical({redirectTarget: 'other.example'}),
    readyRedirect(),
    CONFIGURATION,
  );

  assert.match(action, /configured as a redirect/);
  assert.match(action, /alignment is blocked/);
  assert.doesNotMatch(action, /align command/);
});

test('CLI confirmation prevents every domain mutation', async () => {
  let listCalls = 0;
  const api = {
    async listCustomDomains() {
      listCalls += 1;
      return [];
    },
  };
  const options = {
    confirmDomain: 'wrong.example',
    apply: true,
    includeWww: true,
  };

  await assert.rejects(
    attachDomains(api, CONFIGURATION, options, {logger: NOOP_LOGGER}),
    /Pass --confirm-domain=stayserve\.co\.in/,
  );
  await assert.rejects(
    alignCanonicalSources(api, CONFIGURATION, options, {
      logger: NOOP_LOGGER,
    }),
    /Pass --confirm-domain=stayserve\.co\.in/,
  );
  assert.equal(listCalls, 0);
});

test('CLI alignment refuses missing, incorrect, and redirecting mappings without writing files', async () => {
  const projectRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'stayserve-domain-cli-'),
  );

  try {
    const fixture = sourceFiles();
    await writeProjectFixture(projectRoot, fixture);
    const before = await readProjectFiles(projectRoot, Object.keys(fixture));
    const options = {
      confirmDomain: CONFIGURATION.canonicalDomain,
      apply: true,
    };

    const scenarios = [
      {
        domains: [readyCanonical()],
        error: /www\.stayserve\.co\.in is not attached/,
      },
      {
        domains: [
          readyCanonical(),
          readyRedirect({redirectTarget: 'other.example'}),
        ],
        error: /does not redirect to stayserve\.co\.in/,
      },
      {
        domains: [
          readyCanonical({redirectTarget: 'other.example'}),
          readyRedirect(),
        ],
        error: /configured as a redirect/,
      },
      {
        domains: [
          readyCanonical({
            ownershipState: 'OWNERSHIP_PENDING',
          }),
          readyRedirect(),
        ],
        error: /Refusing to align canonical URLs/,
      },
      {
        domains: [
          readyCanonical({hostState: 'HOST_UNHOSTED'}),
          readyRedirect(),
        ],
        error: /Refusing to align canonical URLs/,
      },
      {
        domains: [
          readyCanonical({cert: {state: 'CERT_PREPARING'}}),
          readyRedirect(),
        ],
        error: /Refusing to align canonical URLs/,
      },
    ];

    for (const scenario of scenarios) {
      const api = {
        async listCustomDomains() {
          return scenario.domains;
        },
      };
      await assert.rejects(
        alignCanonicalSources(api, CONFIGURATION, options, {
          projectRoot,
          logger: NOOP_LOGGER,
        }),
        scenario.error,
      );
    }

    const after = await readProjectFiles(projectRoot, Object.keys(fixture));
    assert.deepEqual(after, before);
  } finally {
    await fs.rm(projectRoot, {recursive: true, force: true});
  }
});

test('CLI alignment writes only after every mapping gate passes', async () => {
  const projectRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'stayserve-domain-cli-'),
  );

  try {
    const fixture = sourceFiles();
    await writeProjectFixture(projectRoot, fixture);
    const api = {
      async listCustomDomains() {
        return [readyCanonical(), readyRedirect()];
      },
    };
    const options = {
      confirmDomain: CONFIGURATION.canonicalDomain,
      apply: true,
    };

    await alignCanonicalSources(api, CONFIGURATION, options, {
      projectRoot,
      logger: NOOP_LOGGER,
    });

    const aligned = await readProjectFiles(projectRoot, Object.keys(fixture));
    assert.match(aligned['web/robots.txt'], /stayserve\.co\.in/);
    assert.match(aligned['storage.cors.json'], /stayserve\.co\.in/);
  } finally {
    await fs.rm(projectRoot, {recursive: true, force: true});
  }
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

test('operation polling survives an operation which cannot be read', async () => {
  // The custom-domain operations of Firebase Hosting cannot be fetched: the
  // API answers with `404 NOT_FOUND`. The domain resource is the source of
  // truth, so the missing operation must not stop the cutover.
  const api = {
    async getOperation() {
      throw new HostingApiError('Firebase Hosting returned HTTP 404', {
        status: 404,
      });
    },
  };

  const response = await waitForOperation(
    api,
    {name: 'operations/one'},
    {sleep: async () => {}},
  );
  assert.equal(response, null);
});

test('attaching a domain survives an operation which cannot be read', async () => {
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
      return {name: `operations/${domain}`};
    },
    async getOperation() {
      throw new HostingApiError('Firebase Hosting returned HTTP 404', {
        status: 404,
      });
    },
    async getCustomDomain() {
      return attached;
    },
  };

  const result = await ensureCustomDomain(api, {
    projectId: 'project',
    siteId: 'site',
    domain: 'stayserve.co.in',
    sleep: async () => {},
  });
  assert.equal(result.created, true);
  assert.equal(result.domain, attached);
  assert.equal(calls.length, 2);
});

test('attaching recognises a domain which the API names with the project number', async () => {
  // The API names the resource with the number of the project, so the
  // comparison with the project id would never match and the tool would try
  // to attach the domain a second time.
  const existing = {
    name: 'projects/96035616668/sites/myfirstapp-fa30f52b/customDomains/stayserve.co.in',
    ownershipState: 'OWNERSHIP_MISSING',
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
    projectId: 'myfirstapp-fa30f52b',
    siteId: 'myfirstapp-fa30f52b',
    domain: 'stayserve.co.in',
  });
  assert.equal(result.created, false);
  assert.equal(result.domain, existing);
  assert.equal(createCalls, 0);
});

test('attaching survives an operation which never reports a result', async () => {
  // The custom-domain operations of Firebase Hosting sometimes stay pending
  // forever. The domain resource shows the result.
  const attached = {
    name: 'projects/project/sites/site/customDomains/stayserve.co.in',
    ownershipState: 'OWNERSHIP_PENDING',
  };
  const api = {
    async listCustomDomains() {
      return [];
    },
    async createCustomDomain() {
      return {name: 'operations/one'};
    },
    async getOperation() {
      return {done: false};
    },
    async getCustomDomain() {
      return attached;
    },
  };

  const result = await ensureCustomDomain(api, {
    projectId: 'project',
    siteId: 'site',
    domain: 'stayserve.co.in',
    sleep: async () => {},
    operationTimeoutMs: 0,
  });
  assert.equal(result.created, true);
  assert.equal(result.domain, attached);
});

test('attaching stops when the API reports a failed validation', async () => {
  const api = {
    async listCustomDomains() {
      return [];
    },
    async createCustomDomain() {
      return {
        name: 'operations/one',
        done: true,
        error: {code: 400, message: 'the domain is not usable'},
      };
    },
    async getCustomDomain() {
      throw new Error('the domain must not be read');
    },
  };

  await assert.rejects(
    ensureCustomDomain(api, {
      projectId: 'project',
      siteId: 'site',
      domain: 'stayserve.co.in',
      sleep: async () => {},
    }),
    /the domain is not usable/,
  );
});

test('attaching fails when the domain is not attached after the operation', async () => {
  const api = {
    async listCustomDomains() {
      return [];
    },
    async createCustomDomain() {
      return {name: 'operations/one', done: true, response: {}};
    },
    async getCustomDomain() {
      return null;
    },
  };

  await assert.rejects(
    ensureCustomDomain(api, {
      projectId: 'project',
      siteId: 'site',
      domain: 'stayserve.co.in',
      sleep: async () => {},
    }),
    /did not attach/,
  );
});
