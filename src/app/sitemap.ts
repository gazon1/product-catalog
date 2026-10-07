import type { MetadataRoute } from 'next';
import { listTargets } from '@/lib/queries';
import { targetSlug } from '@/lib/slug';

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';

/**
 * Generated per request, never at build time.
 *
 * A build-time sitemap would enumerate the categories that existed on the build
 * machine's database — at CI that is none, so the deployed sitemap.xml would list
 * four static pages and no categories at all, and report success doing it.
 */
export const dynamic = 'force-dynamic';

/**
 * Next.js refuses to write a sitemap with more than 50 000 URLs and throws at
 * build/render time. A crawler with hundreds of targets would trip that, so the
 * category list is capped and the overflow is logged rather than silently
 * dropped — a sitemap that quietly covers 40 of 400 categories looks healthy.
 */
const MAX_CATEGORY_URLS = 45_000;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base: MetadataRoute.Sitemap = [
    { url: `${siteUrl}/`, changeFrequency: 'hourly', priority: 1.0 },
    { url: `${siteUrl}/catalog`, changeFrequency: 'hourly', priority: 0.9 },
    // Top-deals is the most volatile page on the site and the one a crawler is
    // actually worth visiting, hence hourly.
    { url: `${siteUrl}/top-deals`, changeFrequency: 'hourly', priority: 0.8 },
  ];

  // `/search` is deliberately absent: its result pages are query-dependent and
  // were marked `noindex` in the previous solution too. Listing them would invite
  // a crawl of every permutation of every search string.

  try {
    const targets = await listTargets();

    // Only categories that actually hold data get a URL. An empty category is a
    // page a crawler fetches to find nothing, and it earns a worse ranking for
    // the ones that do have content.
    const withData = targets.filter((t) => t.itemCount > 0);

    if (withData.length > MAX_CATEGORY_URLS) {
      console.error(
        `[sitemap] ${withData.length} categories exceeds the ${MAX_CATEGORY_URLS} URL limit; ` +
          `${withData.length - MAX_CATEGORY_URLS} will be missing from sitemap.xml`
      );
    }

    const categoryEntries: MetadataRoute.Sitemap = withData
      .slice(0, MAX_CATEGORY_URLS)
      .map((t) => ({
        url: `${siteUrl}/category/${targetSlug(t.name, t.id)}`,
        changeFrequency: 'daily' as const,
        priority: 0.6,
      }));

    return [...base, ...categoryEntries];
  } catch (err) {
    // A sitemap that throws takes the whole route with it and Next renders a
    // build error. The static pages are still worth advertising.
    console.error('[sitemap] failed to load categories', err);
    return base;
  }
}