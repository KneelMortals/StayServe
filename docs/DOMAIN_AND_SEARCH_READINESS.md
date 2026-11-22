# StayServe domain and Google Search readiness

Last reviewed: **2026-11-22**

This document records the non-production domain and search readiness work for
StayServe. It does **not** authorize a production deployment or a DNS change.

## Current state

- Firebase project: `myfirstapp-fa30f52b`
- Firebase Hosting site: `myfirstapp-fa30f52b`
- Current public Hosting origin: `https://myfirstapp-fa30f52b.web.app`
- Custom domains attached to the Hosting site: **none**
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
| `stayserve.com` | Registered at GoDaddy; DNS still points away from Firebase Hosting. The apex resolves to GoDaddy infrastructure and `www` points to `ghs.googlehosted.com`; HTTPS was not healthy during the check. A public `google-site-verification` TXT record is present, which may allow an existing Search Console property to be reused. | Confirm ownership and whether the domain is serving or reserved. Use Firebase's **Advanced Setup** if traffic must be preserved. |
| `stayserve.in` | Registered at Hostinger on 2026-08-19; DNS currently uses Hostinger parking nameservers and a parking address. | Confirm ownership and whether this is the intended brand domain. |
| `stayserve.co.in` | Reported available by the `.co.in` registry WHOIS. | Candidate for an India-focused domain. |
| `stayserve.co` | Reported available by registry WHOIS. | Candidate. |
| `stayserve.io` | Reported available by registry WHOIS. | Candidate. |
| `getstayserve.com` | Reported available by registry WHOIS. | Candidate. |
| `stay-serve.com` | Reported available by registry WHOIS. | Candidate. |
| `stayserve.app` | The registry response did not conclusively establish availability. | Check at the registrar. |

Recommended preference, if the user controls it: **`stayserve.com`**. It is the
cleanest brand match and already has a Search Console verification record.
The alternative is to register one of the available names above. Do not buy a
domain automatically without the owner's approval.

## Custom-domain cutover checklist

### 1. Choose the canonical hostname

Choose either the apex or `www` as the canonical hostname. Prefer the apex
(`https://stayserve.com`) unless there is a specific reason not to. The other
hostname should redirect permanently to the canonical host.

### 2. Attach the domain to Firebase Hosting

In the Firebase console, open **Hosting → myfirstapp-fa30f52b → Add custom
domain**.

- Use **Quick Setup** for a new domain that does not currently receive
  traffic.
- Use **Advanced Setup** for an existing site such as the current
  `stayserve.com` DNS configuration, so the old host can remain online until
  Firebase has verified ownership and provisioned TLS.

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

### 3. Align all checked-in public URLs

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

### 4. Build and validate without cutting traffic over

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

Use a **Domain property** for the apex domain (for example,
`stayserve.com`), not a URL-prefix property. A Domain property covers the
apex, `www`, and both HTTP and HTTPS variants.

1. Open Google Search Console with the Google account that owns or manages
   the domain.
2. Add a **Domain** property using the apex hostname only; do not include
   `www`, a protocol, or a path.
3. Copy the Search Console-provided `google-site-verification` TXT value into
   the domain's DNS settings. Keep that record permanently. The existing
   public TXT record on `stayserve.com` may already satisfy verification, but
   ownership of the Search Console property must still be confirmed in the
   Search Console UI.
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
