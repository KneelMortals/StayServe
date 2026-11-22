import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('web pages use one canonical public origin', () async {
    final robots = await File('web/robots.txt').readAsString();
    final sitemapMatch = RegExp(
      r'^Sitemap:\s+(\S+)\s*$',
      multiLine: true,
    ).firstMatch(robots);
    expect(sitemapMatch, isNotNull);

    final sitemapUrl = Uri.parse(sitemapMatch!.group(1)!);
    expect(sitemapUrl.scheme, 'https');
    expect(sitemapUrl.path, '/sitemap.xml');
    final origin = sitemapUrl.origin;

    final index = await File('web/index.html').readAsString();
    expect(index, contains('<html lang="en">'));
    expect(index, contains('<link rel="canonical" href="$origin/">'));
    expect(index, contains('<meta property="og:url" content="$origin/">'));
    expect(index, contains('name="robots" content="noindex, follow'));

    final landing = await File('web/home/index.html').readAsString();
    expect(landing, contains('<link rel="canonical" href="$origin/home/">'));
    expect(
      landing,
      contains('<meta property="og:url" content="$origin/home/">'),
    );
    expect(landing, contains('name="robots" content="index, follow'));
    expect(landing, contains('<h1>Find your next student room'));
    expect(landing, contains('href="/terms/"'));
    expect(landing, contains('href="/privacy-policy/"'));

    final landingStructuredDataMatch = RegExp(
      r'<script type="application/ld\+json">\s*([\s\S]*?)\s*</script>',
    ).firstMatch(landing);
    expect(landingStructuredDataMatch, isNotNull);
    final landingStructuredData =
        jsonDecode(landingStructuredDataMatch!.group(1)!)
            as Map<String, dynamic>;
    final graph = (landingStructuredData['@graph'] as List<dynamic>)
        .cast<Map<String, dynamic>>();
    expect(
      graph.map((entry) => entry['@type']),
      containsAll(['WebSite', 'Organization', 'WebPage']),
    );

    final structuredDataMatch = RegExp(
      r'<script type="application/ld\+json">\s*([\s\S]*?)\s*</script>',
    ).firstMatch(index);
    expect(structuredDataMatch, isNotNull);
    final structuredData =
        jsonDecode(structuredDataMatch!.group(1)!) as Map<String, dynamic>;
    expect(structuredData['@context'], 'https://schema.org');
    expect(structuredData['@type'], 'WebSite');
    expect(structuredData['url'], '$origin/');

    final terms = await File('web/terms/index.html').readAsString();
    expect(terms, contains('<link rel="canonical" href="$origin/terms/">'));
    expect(terms, contains('name="robots" content="index, follow"'));

    final privacy = await File('web/privacy-policy/index.html').readAsString();
    expect(
      privacy,
      contains('<link rel="canonical" href="$origin/privacy-policy/">'),
    );
    expect(privacy, contains('name="robots" content="index, follow"'));
  });

  test('the sitemap contains only public canonical URLs', () async {
    final robots = await File('web/robots.txt').readAsString();
    final sitemapUrl = RegExp(
      r'^Sitemap:\s+(\S+)\s*$',
      multiLine: true,
    ).firstMatch(robots)!.group(1)!;
    final origin = Uri.parse(sitemapUrl).origin;

    final sitemap = await File('web/sitemap.xml').readAsString();
    final locations = RegExp(
      r'<loc>([^<]+)</loc>',
    ).allMatches(sitemap).map((match) => Uri.parse(match.group(1)!)).toList();

    expect(locations, hasLength(3));
    expect(locations.map((uri) => uri.path).toSet(), {
      '/home/',
      '/terms/',
      '/privacy-policy/',
    });
    for (final location in locations) {
      expect(location.origin, origin);
      expect(location.fragment, isEmpty);
      expect(location.query, isEmpty);
      expect(
        location.path,
        isNot(startsWith('/student/')),
        reason: 'Authenticated student routes must not be advertised.',
      );
      expect(
        location.path,
        isNot(startsWith('/owner/')),
        reason: 'Authenticated owner routes must not be advertised.',
      );
      expect(
        location.path,
        isNot(startsWith('/admin/')),
        reason: 'Administrative routes must not be advertised.',
      );
    }
  });

  test('robots protects private application routes', () async {
    final robots = await File('web/robots.txt').readAsString();
    for (final path in [
      '/student/',
      '/owner/',
      '/admin/',
      '/room/',
      '/chat/',
      '/invoice/',
      '/notifications',
    ]) {
      expect(
        robots,
        contains('Disallow: $path'),
        reason: '$path must not be crawled.',
      );
    }
  });

  test('the canonical origin is allowed to load room photos', () async {
    final robots = await File('web/robots.txt').readAsString();
    final sitemapUrl = RegExp(
      r'^Sitemap:\s+(\S+)\s*$',
      multiLine: true,
    ).firstMatch(robots)!.group(1)!;
    final origin = Uri.parse(sitemapUrl).origin;

    final policy =
        jsonDecode(File('storage.cors.json').readAsStringSync())
            as List<dynamic>;
    final rule = policy.single as Map<String, dynamic>;
    final origins = (rule['origin'] as List<dynamic>).cast<String>();

    expect(origins, contains(origin));
  });
}
