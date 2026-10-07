import { shortId } from '@/lib/slug';

/**
 * Link out to the seller's own page.
 *
 * `rel="noopener noreferrer"` and `referrerPolicy="no-referrer"` are both
 * deliberate. `noopener` severs `window.opener` so the target cannot navigate
 * this tab; `noreferrer` suppresses the Referer header, which would otherwise
 * hand every outbound click — including a referrer URL that may contain a
 * search query — to a third party.
 */
export function OutboundLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      referrerPolicy="no-referrer"
      className="btn-primary"
    >
      {children}
      <span aria-hidden="true" className="ml-1">
        ↗
      </span>
    </a>
  );
}

/**
 * JSON-LD `Product` markup.
 *
 * ## One thing is deliberately *not* copied from the previous solution
 *
 * It hardcoded `availability: 'https://schema.org/InStock'` on every product.
 * The crawler records a real `in_stock` column, so a structured-data claim that
 * contradicts a known fact is a rich-result risk — Google can act on it, and it
 * is simply untrue for out-of-stock items. Here the value is derived, and a
 * product whose stock state the crawler never recorded gets
 * `availability: 'https://schema.org/Discontinued'`, which is the honest
 * "we don't know the state" answer rather than a false "in stock".
 */
export function ProductJsonLd({
  title,
  imageUrl,
  brand,
  description,
  priceRubles,
  inStock,
  productUrl,
  scrapedAt,
}: {
  title: string;
  imageUrl: string | null;
  brand: string | null;
  description: string | null;
  priceRubles: number | null;
  inStock: boolean | null;
  productUrl: string;
  scrapedAt: string;
}) {
  const availability =
    inStock === true
      ? 'https://schema.org/InStock'
      : inStock === false
        ? 'https://schema.org/OutOfStock'
        : 'https://schema.org/Discontinued';

  const jsonLd: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: title,
    ...(imageUrl ? { image: [imageUrl] } : {}),
    ...(description ? { description } : {}),
    ...(brand ? { brand: { '@type': 'Brand', name: brand } } : {}),
    ...(priceRubles !== null
      ? {
          offers: {
            '@type': 'Offer',
            price: priceRubles.toFixed(2),
            priceCurrency: 'RUB',
            availability,
            url: productUrl,
            // Price freshness is a real question on a catalog that updates
            // asynchronously; saying when the figure was observed is what makes
            // it interpretable.
            priceValidUntil: new Date(new Date(scrapedAt).getTime() + 30 * 86_400_000)
              .toISOString()
              .slice(0, 10),
          },
        }
      : {}),
  };

  return (
    <script
      type="application/ld+json"
      // JSON.stringify output is embedded in a <script> element: the only
      // injection vector would be a literal "</script>" inside a crawled title,
      // which the replace below closes.
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c'),
      }}
    />
  );
}

/** A stable, cache-friendly key for list keys and dev tooling. */
export function itemKey(id: string): string {
  return shortId(id);
}