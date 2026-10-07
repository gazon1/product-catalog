import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getProduct } from '@/lib/queries';
import { targetSlug } from '@/lib/slug';
import { BreadcrumbBar } from '@/components/BreadcrumbBar';
import { ProductImage } from '@/components/ProductImage';
import { PriceHistory } from '@/components/PriceHistory';
import { OutboundLink, ProductJsonLd } from '@/components/OutboundLink';
import { cashbackBadgeClass, cashbackLabel, cashbackTier } from '@/lib/cashback';
import { discountPercent, effectivePriceKopecks, formatRubles, kopecksToRubles } from '@/lib/money';
import { describe } from '@/lib/format';
import { formatScrapedAt } from '@/components/ProductCard';

/**
 * Rendered per request, never prerendered at build time.
 *
 * ## Why not `revalidate = N`
 *
 * ISR prerenders the route during `next build`. The database is the crawler's,
 * reached over the network, and it does not exist at build time — CI has no
 * production credential, and a fresh dev database is a different database with
 * different rows. So a build-time render produces a *successful* page with
 * whatever the connection returned at that moment, and that output is then
 * served from the ISR cache for the whole window before anything re-renders.
 *
 * The first build here did exactly that: with no DATABASE_URL the queries threw,
 * the error paths caught them, and `/` and `/catalog` were baked as "no data"
 * pages. The build reported success and the deployed site would have shown an
 * empty catalogue while `BUILD SUCCESSFUL` was in the log.
 *
 * ## What is given up
 *
 * Route-level caching. A request re-runs its SQL. That is affordable here — the
 * pool is capped at 5 connections and every query is indexed by the crawler's own
 * V2 migration — and correctness of prices beats saving a round trip.
 */
/**
 * On-demand ISR, never prerendered at build.
 *
 * `dynamicParams = true` (the default, stated explicitly because it is load-
 * bearing here) means this route is rendered on first request and cached for the
 * revalidate window. No `generateStaticParams` is declared, so `next build`
 * never opens a database connection for it — which matters because the database
 * is the crawler's, lives elsewhere, and does not exist at build time.
 *
 * Contrast with `/` and `/catalog`: those are static-path routes, so a bare
 * `revalidate` would prerender them during the build and freeze whatever the
 * connection returned at that moment. The first build of this site did exactly
 * that and reported success.
 *
 * ## Known limitation: a missing item answers 200, not 404
 *
 * `notFound()` renders the correct 404 page here, but the HTTP status stays 200
 * for a dynamic segment once the response has begun streaming. Verified against
 * Next 15.4.11 both with and without `force-dynamic`, so it is not caused by the
 * render mode.
 *
 * The exposure is contained rather than eliminated, and each mitigation is
 * load-bearing:
 *   - `generateMetadata` returns `robots: { index: false }` for an unknown slug,
 *     so the page is not indexed;
 *   - `alternates.canonical` is emitted only when the target exists;
 *   - `sitemap.xml` lists only categories that exist and hold data.
 *
 * A 200 on a missing page is still a defect, and it is recorded here rather than
 * left for the next reader to rediscover from the symptom.
 */
export const revalidate = 60;
export const dynamicParams = true;

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  try {
    const product = await getProduct(id);
    if (!product) return { title: 'Товар не найден', robots: { index: false } };

    const price = kopecksToRubles(effectivePriceKopecks(product.priceKopecks, product.salePriceKopecks));
    const description = [
      product.title,
      price !== null ? `${formatRubles(price)}` : null,
      product.cashbackPercent !== null ? `кэшбэк ${cashbackLabel(product.cashbackPercent)}` : null,
      product.brand,
    ]
      .filter(Boolean)
      .join(' · ');

    return {
      title: product.title,
      description: description.slice(0, 300),
      alternates: { canonical: `/product/${product.id}` },
      robots: { index: true, follow: true },
      openGraph: {
        type: 'website',
        title: product.title,
        description: description.slice(0, 300),
        // OG images must be publicly reachable; the crawler's image host is
        // already public, so it is used directly here rather than through the
        // same-origin proxy (a crawler fetching the OG image cannot follow a
        // localhost URL).
        images: product.imageUrl ? [{ url: product.imageUrl, alt: product.title }] : undefined,
      },
    };
  } catch (err) {
    console.error('[product] metadata failed', err);
    return { title: 'Товар', robots: { index: false } };
  }
}

export default async function ProductPage({ params }: Props) {
  const { id } = await params;

  let product;
  try {
    product = await getProduct(id);
  } catch (err) {
    console.error('[product] failed to load', err);
    return (
      <div className="container-page py-8">
        <BreadcrumbBar crumbs={[{ label: 'Товар' }]} />
        <div className="card border-rose-200 bg-rose-50 p-6">
          <p className="font-medium text-rose-900">Не удалось загрузить товар</p>
          <p className="mt-1 text-sm text-rose-800">{describe(err)}</p>
        </div>
      </div>
    );
  }

  if (!product) notFound();

  const effective = effectivePriceKopecks(product.priceKopecks, product.salePriceKopecks);
  const priceRubles = kopecksToRubles(effective);
  const discount = discountPercent(product.priceKopecks, product.salePriceKopecks);
  const tier = cashbackTier(product.cashbackPercent);

  return (
    <div className="container-page py-6">
      <ProductJsonLd
        title={product.title}
        imageUrl={product.imageUrl}
        brand={product.brand}
        description={product.seller ?? product.brand}
        priceRubles={priceRubles}
        inStock={product.inStock}
        productUrl={product.productUrl}
        scrapedAt={product.scrapedAt}
      />

      <BreadcrumbBar
        crumbs={[
          { label: product.targetName, href: `/category/${targetSlug(product.targetName, product.targetId)}` },
          { label: product.title },
        ]}
      />

      <div className="grid gap-8 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <div className="card p-4">
            <ProductImage src={product.imageUrl} alt={product.title} brand={product.brand} />
          </div>
        </div>

        <div className="flex flex-col gap-4 lg:col-span-3">
          <div>
            <div className="mb-2 flex flex-wrap gap-2">
              {product.cashbackPercent !== null && (
                <span className={`badge ${cashbackBadgeClass(tier)}`}>
                  Кэшбэк {cashbackLabel(product.cashbackPercent)}
                </span>
              )}
              {discount !== null && discount > 0 && (
                <span className="badge bg-rose-100 text-rose-800 ring-rose-200">−{discount}%</span>
              )}
              {product.inStock === false && (
                <span className="badge bg-slate-100 text-slate-600 ring-slate-200">Нет в наличии</span>
              )}
            </div>

            <h1 className="text-xl font-semibold leading-snug text-slate-900 sm:text-2xl">
              {product.title}
            </h1>

            {(product.brand || product.seller) && (
              <p className="mt-1 text-sm text-slate-500">
                {[product.brand, product.seller].filter(Boolean).join(' · ')}
              </p>
            )}
          </div>

          <div className="card p-5">
            <p className="text-3xl font-bold text-slate-900">{formatRubles(priceRubles)}</p>
            {product.cashbackRubles !== null && (
              <p className="mt-1 text-sm text-slate-600">
                Возврат ≈ {formatRubles(product.cashbackRubles, { precise: true })} при{' '}
                {cashbackLabel(product.cashbackPercent)}
              </p>
            )}
            <p className="mt-2 text-xs text-slate-400">
              Цена на момент обхода {formatScrapedAt(product.scrapedAt)}
            </p>
            <div className="mt-4">
              <OutboundLink href={product.productUrl}>Открыть у продавца</OutboundLink>
            </div>
          </div>

          <section aria-labelledby="history" className="card p-5">
            <h2 id="history" className="mb-3 text-base font-semibold text-slate-900">
              История цены
            </h2>
            <PriceHistory history={product.history} />
          </section>
        </div>
      </div>
    </div>
  );
}