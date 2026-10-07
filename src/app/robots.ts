import type { MetadataRoute } from 'next';

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';

/**
 * `/api/health` is a deployment probe, not content — crawling it wastes budget
 * and the JSON it returns is not meant for an index.
 *
 * `/product-image` is disallowed because it is a proxy for third-party image
 * hosts: letting a crawler fetch arbitrary proxied images turns this site into a
 * free image-fetching service on someone else's bandwidth.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/api/', '/product-image', '/search'],
      },
    ],
    sitemap: `${siteUrl}/sitemap.xml`,
    host: siteUrl,
  };
}