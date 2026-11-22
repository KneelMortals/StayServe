# StayServe domain and Google Search readiness

Last reviewed: **2026-11-22**

This document records the non-production domain and search readiness work for
StayServe. It does **not** authorize a production deployment or a DNS change.

## Current state

- Firebase project: `myfirstapp-fa30f52b`
- Firebase Hosting site: `myfirstapp-fa30f52b`
- Current public Hosting origin: `https://myfirstapp-fa30f52b.web.app`
- Custom domains attached to the Hosting site: **none**
- Selected target domain: **`stayserve.co.in`**
- Target-domain registration status on 2026-11-22: **not yet registered by the owner**
- Checked-in canonical origin: `https://myfirstapp-fa30f52b.web.app`
- Production deployment performed during this work: **none**

The checked-in canonical origin deliberately points to the domain that is
actually attached to Hosting today. Do not point canonical metadata, the
sitemap, or the robots sitemap directive at a candidate domain until that
domain is connected and its managed TLS certificate is active.

## Implemented technical readiness

The web source now contains:

- `web/robots.txt`, with private application routes disallowed and an
  absolute sitemap declaration;
- `web/sitemap.xml`, containing only the public landing, terms, and privacy
  URLs;
- `web/home/index.html`, a responsive, static public landing page with
  meaningful student and owner content, account links, and legal links;
- one self-referential canonical URL per public HTML page;
- Open Graph and Twitter metadata for the landing, app shell, and legal pages;
- `WebSite`, `Organization`, and `WebPage` structured data for the landing;
- a `noindex, follow` directive on the authenticated app shell, so it cannot
  compete with the public landing page;
- a language declaration and crawl directives on every public HTML page;
- cache headers for the crawler files in `firebase.json`;
- `test/web_seo_test.dart`, which keeps canonical URLs, sitemap entries,
  robots rules, and the Storage CORS allowlist consistent;
- `tools/verify_web_seo.mjs`, which verifies the actual Flutter web build
  output after `flutter build web --release`;
- HTML5 validation for every public HTML page;
- `tools/domain_cutover.mjs`, an idempotent helper that reports Firebase's
  exact DNS records, attaches the canonical domain and optional `www` redirect,
  and updates checked-in canonical URLs only after remote readiness checks;
- unit tests for the cutover helper's safety gates and idempotent behavior.

Validate the source and build output with:

```bash
flutter test test/web_seo_test.dart
npm run test:domain
npm run web:html:check
flutter build web --release
npm run web:seo:check
```

The authenticated student, owner, admin, room, chat, invoice, and notification
routes are intentionally excluded from crawling and from the sitemap. They are
not public marketing pages and may expose account-specific or authenticated
content after rendering.

## Domain assessment

Availability and DNS can change at any time. The registrar checkout page is
the final authority; the observations below are only a point-in-time
screening.

| Domain | Observation on 2026-11-22 | Decision needed |
|---|---|---|
| `stayserve.com` | Registered at GoDaddy; DNS still points away from Firebase Hosting. The apex resolves to GoDaddy infrastructure and `www` points to `ghs.googlehosted.com`; HTTPS was not healthy during the check. A public `google-site-verification` TXT record is present, but it is unrelated to the selected `.co.in` domain. | Not selected; registration predates this work. |
| `stayserve.in` | Registered at Hostinger on 2026-08-19; DNS currently uses Hostinger parking nameservers and a parking address. | Not selected; registration predates this work. |
| `stayserve.co.in` | Registry RDAP returned no registration on 2026-11-22. | **Selected target.** Register it through an accredited `.IN` registrar and complete mandatory eKYC/contact validation. |
| `stayserve.co` | Registry RDAP returned no registration on 2026-11-22. | Available alternative. |
| `stayserve.io` | Registry RDAP returned no registration on 2026-11-22. | Available alternative. |
| `getstayserve.com` | Registry RDAP returned no registration on 2026-11-22. | Available global `.com` alternative. |
| `stay-serve.com` | Reported available by registry WHOIS. | Available alternative. |
| `stayserve.app` | Registry RDAP returned no registration on 2026-11-22. | Available alternative; renewal is normally more expensive. |

Selected target: **`stayserve.co.in`**. It preserves the exact product name and
is appropriate for the India-focused student market. The owner must complete
the registration and payment in a registrar account; domain purchases cannot
be completed safely by an automated tool.

## Custom-domain cutover checklist

### 1. Register `stayserve.co.in`

Register the selected domain through an accredited `.IN` registrar. The
registry publishes a wholesale price of ₹400 per year for `.co.in`; retail
registration and renewal prices are set by the registrar and can be higher.
The checkout price is authoritative.

Examples of registrar search pages:

- Hostinger: <https://hostinger.com/in/tld/co-in-domain>
- Namecheap: <https://www.namecheap.com/domains/registration/results/?domain=stayserve.co.in>
- GoDaddy: <https://www.godaddy.com/domainsearch/find?domainToCheck=stayserve.co.in>

During checkout:

1. use accurate registrant, administrative, technical, and billing contact
   details, as required by `.IN` registry policy;
2. enable auto-renew;
3. complete the registry's mandatory eKYC/contact-validation request;
4. keep the registrar account accessible for DNS changes.

Do not change nameservers or DNS records as part of the purchase. Firebase must
issue the exact records for this Hosting site first.

### 2. Confirm the canonical hostname

Use the apex (`https://stayserve.co.in`) as the canonical hostname. The
`www` hostname must redirect permanently to the apex.

### 3. Attach the domain to Firebase Hosting

After the registrar confirms the registration, inspect Firebase's current
state without changing anything:

```bash
npm run domain:status
```

Then attach the canonical domain and the permanent `www` redirect. The attach
operation is idempotent: running it again when the mappings already exist
makes no remote change.

```bash
npm run domain:attach -- \
  --confirm-domain=stayserve.co.in \
  --include-www
```

The helper attaches only the domain mappings. It does **not** change DNS,
apply Storage CORS, or deploy Hosting. It prints the exact records Firebase
requires. Apply each row according to its `ACTION` value: `ADD` means add the
record, `REMOVE` means remove the conflicting record, and `NONE` means no DNS
change is required. A setup commonly includes:

1. a Firebase-provided TXT ownership record at the apex;
2. the Firebase-provided A/AAAA records for each hostname;
3. any additional record type Firebase explicitly requests for that hostname.

Use only the current records printed by Firebase; do not assume that every
hostname uses the same record type. Keep the Firebase ownership TXT record
permanently so Firebase can renew the managed certificate. Remove conflicting
A, CNAME, and AAAA records only when Firebase says it is safe to do so. DNS
propagation and managed certificate provisioning can take up to 24 hours.

If the CLI session lacks the required permission, use the Firebase console
instead: **Hosting → myfirstapp-fa30f52b → Add custom domain**. Use **Quick
Setup** for the new domain. Use **Advanced Setup** only if the domain becomes
an existing live site before the cutover.

Run `npm run domain:status` again while DNS propagates. Firebase provisions
and renews the TLS certificate automatically. The domain is ready only when
DNS ownership, host routing, and the TLS certificate all report active.

### 4. Align all checked-in public URLs

After Firebase reports the domain fully active, preview the local changes:

```bash
npm run domain:align -- --confirm-domain=stayserve.co.in
```

Review the listed files, then apply the same idempotent operation:

```bash
npm run domain:align -- \
  --confirm-domain=stayserve.co.in \
  --apply
```

The helper refuses to align anything until Firebase reports DNS ownership,
host routing, and TLS certificate as active. It updates the canonical origin
in:

- `web/index.html`
- `web/home/index.html`
- `web/terms/index.html`
- `web/privacy-policy/index.html`
- `web/robots.txt`
- `web/sitemap.xml`
- `storage.cors.json` (the canonical origin must be allowed to read room
  photos)

It changes checked-in files only. It does not apply the production Storage
CORS policy or deploy Hosting. After the source is aligned, validate it with:

```bash
flutter test test/web_seo_test.dart
npm run test:domain
npm run web:html:check
```

Keep the Firebase-generated domain as a fallback only while the custom domain
is unavailable; do not publish conflicting canonicals.

### 5. Build and validate without cutting traffic over

```bash
flutter test test/web_seo_test.dart
npm run test:domain
npm run web:html:check
flutter build web --release
npm run web:seo:check
```

After separately approving the production Storage CORS change, check and then
apply the checked-in policy. The first command is read-only; the second
changes production bucket metadata:

```bash
npm run storage:cors:check
npm run storage:cors:apply
```

After an explicitly approved Hosting release, verify:

```bash
curl -I https://THE-CANONICAL-HOST/
curl -I https://THE-CANONICAL-HOST/robots.txt
curl -I https://THE-CANONICAL-HOST/sitemap.xml
curl -I https://THE-CANONICAL-HOST/home/
curl -I https://THE-CANONICAL-HOST/terms/
curl -I https://THE-CANONICAL-HOST/privacy-policy/
```

The crawler files must return their real static content rather than the SPA
fallback. The canonical host must use a valid HTTPS certificate, and the
redirected hostname must not create a second crawlable copy of the site.

## Google Search Console setup

Use a **Domain property** for `stayserve.co.in`, not a URL-prefix property. A
Domain property covers the apex, `www`, and both HTTP and HTTPS variants.

1. Open Google Search Console with the Google account that owns or manages
   the domain.
2. Add a **Domain** property using `stayserve.co.in` only; do not include
   `www`, a protocol, or a path.
3. Copy the Search Console-provided `google-site-verification` TXT value into
   the domain's DNS settings. Keep that record permanently. This Search
   Console TXT record is separate from Firebase's domain-ownership TXT
   record; both may need to coexist.
4. Wait until the property is verified.
5. In **Sitemaps**, submit:
   `https://THE-CANONICAL-HOST/sitemap.xml`
6. Use **URL Inspection** on the public landing page (`/home/`) and the two
   legal URLs. Confirm that each URL is fetchable, has the expected canonical,
   and is allowed for indexing, then request indexing for the landing page.
7. Monitor **Pages** and **Sitemaps** for fetch, rendering, and canonical
   errors. A manual indexing request is a hint, not a guarantee, and may take
   days.

Search Console access is intentionally not automated: the Google account must
confirm ownership in the Search Console UI. The current Firebase CLI session
can manage the Firebase project, but that does not grant Search Console
property access.

## Authenticated app versus public search content

Google can render JavaScript, but StayServe's root is an authenticated Flutter
application shell. It therefore carries `noindex, follow`, and all private
application routes remain excluded from crawling and the sitemap.

Meaningful public search content is served separately at `/home/` as static,
responsive HTML. It does not require an account, has its own canonical and
structured data, and links to the terms and privacy pages. The authenticated
app shell remains available at `/` without competing with that landing page in
search results.

Do not represent authenticated listings or profiles as public pages unless
their content is intentionally public and rendered for crawlers.
