import fs from 'node:fs/promises';
import path from 'node:path';

export const PUBLIC_ORIGIN_FILES = Object.freeze([
  'web/index.html',
  'web/home/index.html',
  'web/terms/index.html',
  'web/privacy-policy/index.html',
  'web/robots.txt',
  'web/sitemap.xml',
]);

export const CORS_FILE = 'storage.cors.json';

export class HostingApiError extends Error {
  constructor(message, {status = null, body = null} = {}) {
    super(message);
    this.name = 'HostingApiError';
    this.status = status;
    this.body = body;
  }
}

export function normalizeHostname(value) {
  if (typeof value !== 'string') {
    throw new Error('A domain name must be a string.');
  }

  const hostname = value.trim().toLowerCase().replace(/\.$/, '');
  if (
    hostname.length === 0 ||
    hostname.length > 253 ||
    !hostname.includes('.') ||
    hostname.startsWith('.') ||
    hostname.endsWith('.') ||
    hostname.includes('..')
  ) {
    throw new Error(`Invalid domain name: ${value}`);
  }

  for (const label of hostname.split('.')) {
    if (
      label.length === 0 ||
      label.length > 63 ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    ) {
      throw new Error(`Invalid domain name: ${value}`);
    }
  }

  return hostname;
}

export function parseCanonicalOrigin(robotsContent) {
  const match = robotsContent.match(/^Sitemap:\s+(\S+)\s*$/m);
  if (!match) {
    throw new Error('robots.txt does not declare an absolute sitemap URL.');
  }

  const url = new URL(match[1]);
  if (url.protocol !== 'https:' || url.pathname !== '/sitemap.xml') {
    throw new Error('The sitemap declaration must be an HTTPS /sitemap.xml URL.');
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new Error('The sitemap declaration must not contain credentials, a query, or a fragment.');
  }

  return url.origin;
}

function normalizeHttpsOrigin(value, description) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.pathname !== '/' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`The ${description} must be an HTTPS origin.`);
  }
  return url.origin;
}

export function planOriginAlignment(fileContents, options) {
  const {
    targetOrigin,
    allowedCurrentOrigins,
    lastModified = new Date().toISOString().slice(0, 10),
  } = options;

  const normalizedTarget = normalizeHttpsOrigin(
    targetOrigin,
    'alignment target',
  );

  const allowedOrigins = new Set(
    allowedCurrentOrigins.map((origin) =>
      normalizeHttpsOrigin(origin, 'allowed current origin'),
    ),
  );
  if (!allowedOrigins.has(normalizedTarget)) {
    throw new Error('The alignment target must be one of the allowed origins.');
  }

  const robots = fileContents['web/robots.txt'];
  if (typeof robots !== 'string') {
    throw new Error('web/robots.txt is required for canonical alignment.');
  }

  const currentOrigin = parseCanonicalOrigin(robots);
  if (!allowedOrigins.has(currentOrigin)) {
    throw new Error(
      `Refusing to replace an unexpected canonical origin: ${currentOrigin}`,
    );
  }

  const changes = new Map();

  for (const relativePath of PUBLIC_ORIGIN_FILES) {
    const original = fileContents[relativePath];
    if (typeof original !== 'string') {
      throw new Error(`Missing canonical source file: ${relativePath}`);
    }

    let updated = original;
    for (const origin of allowedOrigins) {
      if (origin !== normalizedTarget) {
        updated = updated.replaceAll(origin, normalizedTarget);
      }
    }

    if (relativePath.endsWith('.html')) {
      const canonicalMatch = updated.match(
        /<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/i,
      );
      if (!canonicalMatch) {
        throw new Error(`${relativePath} is missing its canonical link.`);
      }
      if (new URL(canonicalMatch[1]).origin !== normalizedTarget) {
        throw new Error(
          `${relativePath} has a canonical URL outside the target origin.`,
        );
      }

      const openGraphMatch = updated.match(
        /<meta\s+property=["']og:url["']\s+content=["']([^"']+)["']/i,
      );
      if (!openGraphMatch) {
        throw new Error(`${relativePath} is missing its Open Graph URL.`);
      }
      if (new URL(openGraphMatch[1]).origin !== normalizedTarget) {
        throw new Error(
          `${relativePath} has an Open Graph URL outside the target origin.`,
        );
      }
    }

    if (!updated.includes(normalizedTarget)) {
      throw new Error(
        `${relativePath} does not contain the expected canonical origin.`,
      );
    }

    const originChanged = updated !== original;
    if (relativePath === 'web/sitemap.xml' && originChanged) {
      updated = updated.replace(
        /<lastmod>[^<]*<\/lastmod>/g,
        `<lastmod>${lastModified}</lastmod>`,
      );
    }

    if (updated !== original) {
      changes.set(relativePath, updated);
    }
  }

  const corsText = fileContents[CORS_FILE];
  if (typeof corsText !== 'string') {
    throw new Error(`${CORS_FILE} is required for canonical alignment.`);
  }

  let corsPolicy;
  try {
    corsPolicy = JSON.parse(corsText);
  } catch (error) {
    throw new Error(`${CORS_FILE} is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(corsPolicy) || corsPolicy.length === 0) {
    throw new Error(`${CORS_FILE} must contain at least one CORS rule.`);
  }

  const getRules = corsPolicy.filter(
    (rule) =>
      Array.isArray(rule.method) &&
      rule.method.includes('GET') &&
      Array.isArray(rule.origin),
  );
  if (getRules.length === 0) {
    throw new Error(`${CORS_FILE} must contain a rule which allows GET.`);
  }
  if (
    corsPolicy.some(
      (rule) =>
        Array.isArray(rule.origin) && rule.origin.includes('*'),
    )
  ) {
    throw new Error(`${CORS_FILE} must not contain a wildcard origin.`);
  }

  const targetRule =
    getRules.find((rule) => rule.origin.includes(normalizedTarget)) ||
    getRules[0];
  if (!Array.isArray(targetRule.origin)) {
    throw new Error(`${CORS_FILE} must contain an origin list.`);
  }
  if (!targetRule.origin.includes(normalizedTarget)) {
    targetRule.origin.push(normalizedTarget);
  }

  const updatedCors = `${JSON.stringify(corsPolicy, null, 2)}\n`;
  if (updatedCors !== corsText) {
    changes.set(CORS_FILE, updatedCors);
  }

  return {
    currentOrigin,
    targetOrigin: normalizedTarget,
    changes,
  };
}

export async function readProjectFiles(projectRoot, relativePaths) {
  const entries = await Promise.all(
    relativePaths.map(async (relativePath) => {
      const absolutePath = path.resolve(projectRoot, relativePath);
      if (!absolutePath.startsWith(`${path.resolve(projectRoot)}${path.sep}`)) {
        throw new Error(`Refusing to read outside the project: ${relativePath}`);
      }
      return [relativePath, await fs.readFile(absolutePath, 'utf8')];
    }),
  );
  return Object.fromEntries(entries);
}

export async function applyFileChanges(projectRoot, changes) {
  const root = path.resolve(projectRoot);
  const staged = [];

  try {
    for (const [relativePath, content] of changes) {
      const absolutePath = path.resolve(root, relativePath);
      if (!absolutePath.startsWith(`${root}${path.sep}`)) {
        throw new Error(`Refusing to write outside the project: ${relativePath}`);
      }

      const temporaryPath = `${absolutePath}.stayserve-${process.pid}.tmp`;
      const mode = (await fs.stat(absolutePath)).mode;
      await fs.writeFile(temporaryPath, content, {mode});
      staged.push({absolutePath, temporaryPath});
    }

    for (const {absolutePath, temporaryPath} of staged) {
      await fs.rename(temporaryPath, absolutePath);
    }
  } catch (error) {
    await Promise.all(
      staged.map(async ({temporaryPath}) => {
        try {
          await fs.unlink(temporaryPath);
        } catch {
          // The file may already have been renamed successfully.
        }
      }),
    );
    throw error;
  }
}

export function getDomainReadinessProblems(domain) {
  const problems = [];
  const ownershipState = domain?.ownershipState;
  const hostState = domain?.hostState;
  const certState = domain?.cert?.state ?? domain?.certState;

  if (ownershipState !== 'OWNERSHIP_ACTIVE') {
    problems.push(
      `DNS ownership is ${ownershipState || 'unknown'} (expected OWNERSHIP_ACTIVE).`,
    );
  }
  if (hostState !== 'HOST_ACTIVE') {
    problems.push(
      `Host routing is ${hostState || 'unknown'} (expected HOST_ACTIVE).`,
    );
  }
  if (!['CERT_ACTIVE', 'CERT_STATE_ACTIVE'].includes(certState)) {
    problems.push(
      `TLS certificate is ${certState || 'unknown'} (expected CERT_ACTIVE).`,
    );
  }
  if (Array.isArray(domain?.issues) && domain.issues.length > 0) {
    problems.push(
      `Firebase reported ${domain.issues.length} domain issue(s): ` +
        domain.issues
          .map((issue) => issue.message || JSON.stringify(issue))
          .join('; '),
    );
  }

  return problems;
}

export function isDomainReady(domain) {
  return getDomainReadinessProblems(domain).length === 0;
}

export function getDesiredDnsRecords(domain) {
  const recordSets = domain?.requiredDnsUpdates?.desired || [];
  return recordSets.flatMap((recordSet) =>
    (recordSet.records || []).map((record) => ({
      type: record.type,
      host: recordSet.domainName,
      value: record.rdata,
      action: record.requiredAction,
    })),
  );
}

export function formatDnsRecords(records) {
  if (records.length === 0) {
    return 'No desired DNS records were returned by Firebase.';
  }

  const header = ['TYPE', 'HOST', 'VALUE', 'ACTION'];
  const rows = records.map((record) => [
    record.type || '-',
    record.host || '-',
    record.value || '-',
    record.action || '-',
  ]);
  const widths = header.map((value, index) =>
    Math.max(value.length, ...rows.map((row) => row[index].length)),
  );
  const formatRow = (row) =>
    row.map((value, index) => value.padEnd(widths[index])).join('  ');

  return [formatRow(header), formatRow(widths.map((width) => '-'.repeat(width))), ...rows.map(formatRow)].join(
    '\n',
  );
}

export class FirebaseHostingApi {
  constructor({token, baseUrl = 'https://firebasehosting.googleapis.com/v1beta1', fetchImpl = fetch}) {
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
  }

  async request(resourcePath, {method = 'GET', query = {}, body} = {}) {
    const url = new URL(`${this.baseUrl}/${resourcePath}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }

    const response = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
      },
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    });

    const text = await response.text();
    let responseBody = null;
    if (text) {
      try {
        responseBody = JSON.parse(text);
      } catch {
        responseBody = {raw: text};
      }
    }

    if (!response.ok) {
      throw new HostingApiError(
        `Firebase Hosting returned HTTP ${response.status}: ` +
          JSON.stringify(responseBody),
        {status: response.status, body: responseBody},
      );
    }

    return responseBody;
  }

  async listCustomDomains(projectId, siteId) {
    const parent = `projects/${projectId}/sites/${siteId}`;
    const customDomains = [];
    let pageToken;

    do {
      const response = await this.request(`${parent}/customDomains`, {
        query: {pageSize: 100, pageToken},
      });
      customDomains.push(...(response.customDomains || []));
      pageToken = response.nextPageToken;
    } while (pageToken);

    return customDomains;
  }

  async getCustomDomain(projectId, siteId, domain) {
    const name = `projects/${projectId}/sites/${siteId}/customDomains/${domain}`;
    return this.request(name);
  }

  async createCustomDomain(projectId, siteId, domain, {redirectTarget, validateOnly = false} = {}) {
    const parent = `projects/${projectId}/sites/${siteId}`;
    const name = `${parent}/customDomains/${domain}`;
    return this.request(`${parent}/customDomains`, {
      method: 'POST',
      query: {customDomainId: domain, validateOnly},
      body: {
        name,
        ...(redirectTarget ? {redirectTarget} : {}),
      },
    });
  }

  async getOperation(name) {
    return this.request(name);
  }
}

export async function waitForOperation(api, operation, {timeoutMs = 120000, intervalMs = 2000, sleep} = {}) {
  if (!operation?.name) {
    throw new Error('Firebase did not return a custom-domain operation name.');
  }
  if (operation.done) {
    if (operation.error) {
      throw new HostingApiError(
        `Firebase custom-domain operation failed: ` +
          JSON.stringify(operation.error),
      );
    }
    return operation.response;
  }

  const wait = sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await wait(intervalMs);
    const latest = await api.getOperation(operation.name);
    if (latest.done) {
      if (latest.error) {
        throw new HostingApiError(
          `Firebase custom-domain operation failed: ` +
            JSON.stringify(latest.error),
        );
      }
      return latest.response;
    }
  }

  throw new HostingApiError(
    `Firebase custom-domain operation did not finish within ${timeoutMs}ms: ${operation.name}`,
  );
}

export async function ensureCustomDomain(api, {projectId, siteId, domain, redirectTarget, sleep}) {
  const existingDomains = await api.listCustomDomains(projectId, siteId);
  const existing = existingDomains.find(
    (candidate) =>
      candidate.name === `projects/${projectId}/sites/${siteId}/customDomains/${domain}`,
  );

  if (existing) {
    const existingRedirect = existing.redirectTarget || '';
    if ((redirectTarget || '') !== existingRedirect) {
      throw new Error(
        `${domain} is already attached with redirect target ` +
          `${existingRedirect || '(none)'}; refusing to change it automatically.`,
      );
    }
    return {domain: existing, created: false};
  }

  const validation = await api.createCustomDomain(projectId, siteId, domain, {
    redirectTarget,
    validateOnly: true,
  });
  await waitForOperation(api, validation, {sleep});

  const operation = await api.createCustomDomain(projectId, siteId, domain, {
    redirectTarget,
    validateOnly: false,
  });
  await waitForOperation(api, operation, {sleep});
  const attached = await api.getCustomDomain(projectId, siteId, domain);
  return {domain: attached, created: true};
}
