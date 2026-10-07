import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { listItems, listTargets } from '@/lib/queries';
import { resolveTarget, targetSlug } from '@/lib/slug';
import { isSortOrder, DEFAULT_SORT } from '@/lib/types';
import { readFlag, readNonNegativeNumber, readNumber, readString, type SearchParams } from '@/lib/params';
import { ProductGrid } from '@/components/ProductCard';
import { Pagination } from '@/components/Pagination';
import { FilterBar } from '@/components/FilterBar';
import { SortSelect } from '@/components/SortSelect';
import { BreadcrumbBar } from '@/components/BreadcrumbBar';
import { EmptyState, ErrorState } from '@/components/EmptyState';
import { describe, plural } from '@/lib/format';

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

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParams>;
};

/**
 * Resolve the slug to a target once, for both metadata and the page body.
 *
 * The previous solution fetched the category list twice — once in
 * `generateMetadata`, once in the component — and used a `?id=` query parameter
 * to carry the real id alongside the slug, so a category URL had two identifiers
 * in it and only one of them was load-bearing. Here the slug *is* the id.
 */
async function loadTarget(slug: string) {
  const targets = await listTargets();
  return resolveTarget(targets, slug);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  try {
    const target = await loadTarget(decodeURIComponent(slug));
    if (!target) return { title: 'Категория не найдена', robots: { index: false } };
    return {
      title: target.name,
      description: `Товары категории «${target.name}» с фильтрацией по цене, кэшбэку и дате обхода.`,
      alternates: { canonical: `/category/${targetSlug(target.name, target.id)}` },
      robots: { index: target.itemCount > 0, follow: true },
    };
  } catch (err) {
    console.error('[category] metadata failed', err);
    return { title: 'Категория', robots: { index: false } };
  }
}

export default async function CategoryPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const sp = await searchParams;

  let target;
  try {
    target = await loadTarget(decodeURIComponent(slug));
  } catch (err) {
    console.error('[category] failed to load targets', err);
    return (
      <div className="container-page py-8">
        <BreadcrumbBar crumbs={[{ label: 'Категория' }]} />
        <ErrorState message={describe(err)} />
      </div>
    );
  }

  if (!target) notFound();

  const page = readNumber(sp, 'page') ?? 0;
  const search = readString(sp, 'q');
  const sortRaw = readString(sp, 'sort', 32);
  const sort = isSortOrder(sortRaw) ? sortRaw : DEFAULT_SORT;
  const minPrice = readNonNegativeNumber(sp, 'minPrice');
  const maxPrice = readNonNegativeNumber(sp, 'maxPrice');
  const minCashback = readNonNegativeNumber(sp, 'minCashback');
  const inStockOnly = readFlag(sp, 'inStock');

  let data;
  try {
    data = await listItems({
      targetId: target.id,
      sort,
      paging: { page, pageSize: 24 },
      filter: { search, minPriceRubles: minPrice, maxPriceRubles: maxPrice, minCashbackPercent: minCashback, inStockOnly },
    });
  } catch (err) {
    console.error('[category] failed to load items', err);
    return (
      <div className="container-page py-8">
        <BreadcrumbBar crumbs={[{ label: target.name }]} />
        <ErrorState message={describe(err)} />
      </div>
    );
  }

  const basePath = `/category/${targetSlug(target.name, target.id)}`;
  const linkParams: Record<string, string | undefined> = {
    q: search,
    sort: sort !== DEFAULT_SORT ? sort : undefined,
    minPrice: minPrice?.toString(),
    maxPrice: maxPrice?.toString(),
    minCashback: minCashback?.toString(),
    inStock: inStockOnly ? '1' : undefined,
  };
  const hasActiveFilters = Object.values(linkParams).some((v) => v !== undefined);

  return (
    <div className="container-page py-6">
      <BreadcrumbBar
        crumbs={[
          ...(target.rootCategoryName ? [{ label: target.rootCategoryName, href: '/catalog' }] : []),
          { label: target.name },
        ]}
      />

      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">{target.name}</h1>
        <p className="mt-1 text-sm text-slate-600">
          {data.totalCount.toLocaleString('ru-RU')}{' '}
          {plural(data.totalCount, 'товар', 'товара', 'товаров')}
          {hasActiveFilters && ' (с учётом фильтров)'}
        </p>
      </header>

      <div className="mb-6 flex flex-col gap-4">
        <FilterBar
          action={basePath}
          search={search}
          minPrice={minPrice}
          maxPrice={maxPrice}
          minCashback={minCashback}
          inStockOnly={inStockOnly}
        />
        <SortSelect sort={sort} basePath={basePath} extraParams={linkParams} />
      </div>

      {data.items.length === 0 ? (
        <EmptyState
          title={hasActiveFilters ? 'Ничего не подошло под фильтры' : 'В этой категории пока нет товаров'}
          hint={
            hasActiveFilters
              ? 'Попробуйте ослабить условия или сбросить фильтры.'
              : 'Категория настроена в краулере, но ни один обход ещё ничего не записал.'
          }
          action={hasActiveFilters ? { href: basePath, label: 'Сбросить фильтры' } : undefined}
        />
      ) : (
        <>
          <ProductGrid items={data.items} />
          <Pagination page={data} basePath={basePath} searchParams={linkParams} />
        </>
      )}
    </div>
  );
}