'use client';

import { useState } from 'react';

/**
 * Product image with a same-origin proxy and a guaranteed fallback.
 *
 * ## Why a proxy instead of `next/image`
 *
 * Two reasons, both about the data rather than about Next.js:
 *
 * 1. **The host is not known ahead of time.** `image_url` comes from whatever the
 *    crawler parsed. A `remotePatterns` allowlist in `next.config.mjs` would need
 *    editing every time a new CDN appears, and a missing pattern means a broken
 *    image on every card — which is a much more visible failure than a 404.
 * 2. **A plain `<img>` cannot silently 404.** `next/image` optimises and a
 *    missing upstream returns an error document; this component detects the
 *    failure and renders a deterministic placeholder instead.
 *
 * ## Why the URL is proxied
 *
 * The CSP in `next.config.mjs` allows `img-src 'self'` only. Serving images from
 * our own origin also stops the browser from leaking every page view to a third
 * party via `Referer`, and keeps the crawler's hosts out of the document.
 *
 * The proxy route enforces the host allowlist server-side — a client-supplied
 * `url` reaching an open proxy would be a textbook SSRF, so the allowlist is not
 * a performance measure, it is the security boundary.
 */
export function ProductImage({
  src,
  alt,
  brand,
}: {
  src: string | null;
  alt: string;
  brand?: string | null;
}) {
  const [failed, setFailed] = useState(false);

  const showFallback = !src || failed;

  return (
    <div className="relative aspect-square w-full overflow-hidden rounded-lg bg-slate-100">
      {showFallback ? (
        <Fallback brand={brand ?? null} />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- see the component docblock
        <img
          src={`/product-image?url=${encodeURIComponent(src)}`}
          alt={alt}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="h-full w-full object-contain p-2"
        />
      )}
    </div>
  );
}

function Fallback({ brand }: { brand: string | null }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-slate-100 to-slate-200">
      <span className="px-3 text-center text-xs font-medium uppercase tracking-wide text-slate-400">
        {brand && brand.length > 0 ? brand : 'Нет фото'}
      </span>
    </div>
  );
}