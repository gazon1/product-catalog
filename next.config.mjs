/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,

  // The storefront talks to the crawler's catalog API server-side, from the
  // Node runtime, over the internal network — the browser never sees it and
  // the site never proxies to it. So there is nothing to rewrite: the
  // previous solution's `/api/*` dev rewrite existed only to reach its
  // ASP.NET backend, and adding one now would expose the crawler's API (and
  // its key) to the public internet.
  async rewrites() {
    return [];
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              // Product images come from arbitrary hosts recorded in the crawled
              // data (the crawler's image CDN today, anything tomorrow). They are rendered
              // through a same-origin proxy route, so 'self' is enough here.
              "img-src 'self' data: blob:",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "font-src 'self' data:",
              "connect-src 'self'",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
        ],
      },
      {
        source: '/_next/static/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
      {
        source: '/product-image',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=86400, stale-while-revalidate=604800' }],
      },
    ];
  },
};

export default nextConfig;