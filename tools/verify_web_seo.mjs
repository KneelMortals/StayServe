import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const outputDirectory = path.resolve(
  process.argv[2] ?? path.join('build', 'web'),
);
const failures = [];

function read(relativePath) {
  const absolutePath = path.join(outputDirectory, relativePath);
  if (!fs.existsSync(absolutePath)) {
    failures.push(`Missing build output: ${relativePath}`);
    return '';
  }
  return fs.readFileSync(absolutePath, 'utf8');
}

function requireText(content, expected, description) {
  if (!content.includes(expected)) {
    failures.push(`${description} does not contain ${expected}`);
  }
}

if (!fs.existsSync(outputDirectory)) {
  console.error(
    `Web output directory does not exist: ${outputDirectory}. ` +
      'Run `flutter build web --release` first.',
  );
  process.exit(1);
}

const robots = read('robots.txt');
const sitemap = read('sitemap.xml');
const index = read('index.html');
const landing = read(path.join('home', 'index.html'));
const terms = read(path.join('terms', 'index.html'));
const privacy = read(path.join('privacy-policy', 'index.html'));

const sitemapMatch = robots.match(/^Sitemap:\s+(\S+)\s*$/m);
if (!sitemapMatch) {
  failures.push('robots.txt does not declare an absolute sitemap URL');
} else {
  const sitemapUrl = new URL(sitemapMatch[1]);
  if (sitemapUrl.protocol !== 'https:') {
    failures.push('The sitemap URL must use HTTPS');
  }
  if (sitemapUrl.pathname !== '/sitemap.xml') {
    failures.push('The sitemap URL must point to /sitemap.xml');
  }

  const origin = sitemapUrl.origin;
  requireText(
    index,
    `<link rel="canonical" href="${origin}/">`,
    'index.html canonical metadata',
  );
  requireText(
    index,
    `<meta property="og:url" content="${origin}/">`,
    'index.html Open Graph metadata',
  );
  requireText(
    index,
    'name="robots" content="noindex, follow',
    'index.html robots metadata',
  );
  requireText(
    landing,
    `<link rel="canonical" href="${origin}/home/">`,
    'home/index.html canonical metadata',
  );
  requireText(
    landing,
    `<meta property="og:url" content="${origin}/home/">`,
    'home/index.html Open Graph metadata',
  );
  requireText(
    landing,
    'name="robots" content="index, follow',
    'home/index.html robots metadata',
  );
  requireText(
    terms,
    `<link rel="canonical" href="${origin}/terms/">`,
    'terms/index.html canonical metadata',
  );
  requireText(
    privacy,
    `<link rel="canonical" href="${origin}/privacy-policy/">`,
    'privacy-policy/index.html canonical metadata',
  );

  const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
    (match) => new URL(match[1]),
  );
  const expectedPaths = new Set(['/home/', '/terms/', '/privacy-policy/']);
  if (locations.length !== expectedPaths.size) {
    failures.push(
      `sitemap.xml must contain ${expectedPaths.size} public URLs; found ${locations.length}`,
    );
  }
  const foundPaths = new Set();
  for (const location of locations) {
    if (location.origin !== origin) {
      failures.push(`Sitemap URL uses a different origin: ${location.href}`);
    }
    if (!expectedPaths.has(location.pathname)) {
      failures.push(`Sitemap contains an unexpected URL: ${location.href}`);
    }
    if (foundPaths.has(location.pathname)) {
      failures.push(`Sitemap contains a duplicate URL: ${location.href}`);
    }
    foundPaths.add(location.pathname);
  }
  for (const expectedPath of expectedPaths) {
    if (!foundPaths.has(expectedPath)) {
      failures.push(`Sitemap is missing the public URL path ${expectedPath}`);
    }
  }
}

if (failures.length > 0) {
  console.error('Web SEO verification failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

let baseUrl = process.argv[3];
if (baseUrl === 'auto') {
  baseUrl = undefined;
  for (let port = 5000; port <= 5020; port += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/robots.txt`);
      if ((await response.text()) === robots) {
        baseUrl = `http://127.0.0.1:${port}`;
        break;
      }
    } catch {
      // Another emulator instance (or no server) may occupy this port.
    }
  }
  if (!baseUrl) {
    failures.push('Could not locate the local Hosting emulator');
  }
}

if (baseUrl) {
  const requests = [
    {
      path: '/robots.txt',
      expectedContentType: /text\/plain/,
      expectedBody: robots,
    },
    {
      path: '/sitemap.xml',
      expectedContentType: /(application|text)\/xml/,
      expectedBody: sitemap,
    },
    {
      path: '/home/',
      expectedContentType: /text\/html/,
      expectedBody: landing,
    },
    {
      path: '/terms/',
      expectedContentType: /text\/html/,
      expectedBody: terms,
    },
    {
      path: '/privacy-policy/',
      expectedContentType: /text\/html/,
      expectedBody: privacy,
    },
  ];

  for (const request of requests) {
    const response = await fetch(new URL(request.path, baseUrl));
    const body = await response.text();
    if (!response.ok) {
      failures.push(`${request.path} returned HTTP ${response.status}`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!request.expectedContentType.test(contentType)) {
      failures.push(
        `${request.path} returned content type ${contentType || '(missing)'}`,
      );
    }
    if (body !== request.expectedBody) {
      failures.push(`${request.path} did not serve its static build file`);
    }
  }

  for (const requestPath of ['/robots.txt', '/sitemap.xml']) {
    const response = await fetch(new URL(requestPath, baseUrl));
    const cacheControl = response.headers.get('cache-control') ?? '';
    if (!cacheControl.includes('max-age=3600')) {
      failures.push(
        `${requestPath} is missing the configured one-hour cache header`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error('Web SEO verification failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Web SEO verification passed for ${path.relative(process.cwd(), outputDirectory)}.`,
);
