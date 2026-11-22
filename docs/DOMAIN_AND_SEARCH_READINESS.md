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
- `web/sitemap.xml`, containing only the public home, terms, and privacy
  URLs;
- one self-referential canonical URL per public HTML page;
- Open Graph and Twitter metadata for the app shell and legal pages;
- `WebSite` structured data in `web/index.html`;
- a language declaration and crawl directives on every public HTML page;
- cache headers for the crawler files in `firebase.json`;
- `test/web_seo_test.dart`, which keeps canonical URLs, sitemap entries,
  robots rules, and the Storage CORS allowlist consistent;
- `tools/verify_web_seo.mjs`, which verifies the actual Flutter web build
  output after `flutter build web --release`.

Validate the source and build output with:

```bash
flutter test test/web_seo_test.dart
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

### 2. Choose the canonical hostname

Choose either the apex or `www` as the canonical hostname. Prefer the apex
(`https://stayserve.co.in`) unless there is a specific reason not to. The
other hostname should redirect permanently to the canonical host.

### 3. Attach the domain to Firebase Hosting

In the Firebase console, open **Hosting → myfirstapp-fa30f52b → Add custom
domain**.

- Use **Quick Setup** for `stayserve.co.in`, because it is a new domain that
  does not currently receive traffic.
- Use **Advanced Setup** only if the domain becomes an existing live site
  before the cutover, so the old host can remain online until Firebase has
  verified ownership and provisioned TLS.

Follow the exact records displayed by the Firebase wizard. A typical setup
includes:

1. a Firebase-provided TXT ownership record at the apex;
2. the Firebase-provided A/AAAA records for the chosen hostname;
3. a CNAME for `www` when it is used as a separate hostname.

Keep the Firebase ownership TXT record permanently so Firebase can renew the
managed certificate. Remove conflicting A, CNAME, and AAAA records only when
the selected setup mode says it is safe to do so. DNS propagation and managed
certificate provisioning can take up to 24 hours.

Firebase provisions and renews the TLS certificate automatically. The domain
must show **Connected** before the cutover is considered complete.

### 4. Align all checked-in public URLs

After the hostname is attached, update the canonical origin in every file
below before building or deploying:

- `web/index.html`
- `web/terms/index.html`
- `web/privacy-policy/index.html`
- `web/robots.txt`
- `web/sitemap.xml`
- `storage.cors.json` (the canonical origin must be allowed to read room
  photos)

The SEO tests and `npm run web:seo:check` fail if these values drift apart.
Keep the Firebase-generated domain as a fallback only while the custom domain
is unavailable; do not publish conflicting canonicals.

### 5. Build and validate without cutting traffic over

```bash
flutter test test/web_seo_test.dart
flutter build web --release
npm run web:seo:check
```

After an explicitly approved Hosting release, verify:

```bash
curl -I https://THE-CANONICAL-HOST/
curl -I https://THE-CANONICAL-HOST/robots.txt
curl -I https://THE-CANONICAL-HOST/sitemap.xml
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
6. Use **URL Inspection** on the canonical home page and the two legal URLs.
   Confirm that each URL is fetchable, has the expected canonical, and is
   allowed for indexing, then request indexing for the home page.
7. Monitor **Pages** and **Sitemaps** for fetch, rendering, and canonical
   errors. A manual indexing request is a hint, not a guarantee, and may take
   days.

Search Console access is intentionally not automated: the Google account must
confirm ownership in the Search Console UI. The current Firebase CLI session
can manage the Firebase project, but that does not grant Search Console
property access.

## Important SPA limitation

Google can render JavaScript, but StayServe is an authenticated Flutter
single-page application. Its root currently leads into the startup/login
flow, while private routes are deliberately excluded from crawling. The static
title, description, canonical, structured data, sitemap, and legal pages make
the site technically crawlable, but they do not create a substantial public
landing page.

For meaningful organic search traffic, add a public, indexable landing page
with real descriptive content and crawlable links before requesting indexing.
That page should use the same canonical origin and should not require an
account. Do not represent authenticated listings or profiles as public pages
unless their content is intentionally public and rendered for crawlers.
