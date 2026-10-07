import type { Metadata } from 'next';
import { listItems } from '@/lib/queries';
import { readNumber, readString, type SearchParams } from '@/lib/params';
import { ProductGrid } from '@/components/ProductCard';
import { Pagination } from '@/components/Pagination';
import { FilterBar } from '@/components/FilterBar';
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
export const dynamic = 'force-dynamic';

type Props = { searchParams: Promise<SearchParams> };

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const sp = await searchParams;
  const q = readString(sp, 'q');
  // Result pages are noindex — every permutation of every search string is
  // otherwise crawlable, and none of them is a page anyone links to.
  if (!q) return { title: 'Поиск', robots: { index: false, follow: true } };
  return { title: `Поиск: ${q}`, robots: { index: false, follow: true } };
}

export default async function SearchPage({ searchParams }: Props) {
  const sp = await searchParams;
  const q = readString(sp, 'q');
  const page = readNumber(sp, 'page') ?? 0;
  const minPrice = readNumber(sp, 'minPrice');
  const maxPrice = readNumber(sp, 'maxPrice');
  const minCashback = readNumber(sp, 'minCashback');

  return (
    <div className="container-page py-6">
      <BreadcrumbBar crumbs={[{ label: q ? `Поиск: ${q}` : 'Поиск' }]} />

      <h1 className="mb-1 text-2xl font-bold tracking-tight text-slate-900">
        {q ? `Результаты: ${q}` : 'Поиск'}
      </h1>
      <p className="mb-6 text-sm text-slate-600">
        Поиск идёт по названию, бренду и продавцу во всех каталогах.
      </p>

      <FilterBar action="/search" search={q} minPrice={minPrice} maxPrice={maxPrice} minCashback={minCashback} />

      <div className="mt-6">
        {q ? (
          <SearchResults
            q={q}
            page={page}
            minPrice={minPrice}
            maxPrice={maxPrice}
            minCashback={minCashback}
          />
        ) : (
          <EmptyState title="Введите поисковый запрос" hint="Например: «кофемашина» или «Nike»." />
        )}
      </div>
    </div>
  );
}

async function SearchResults({
  q,
  page,
  minPrice,
  maxPrice,
  minCashback,
}: {
  q: string;
  page: number;
  minPrice?: number | undefined;
  maxPrice?: number | undefined;
  minCashback?: number | undefined;
}) {
  let data;
  try {
    data = await listItems({
      sort: 'CashbackPercentDesc',
      paging: { page, pageSize: 24 },
      filter: {
        search: q,
        minPriceRubles: minPrice !== undefined && minPrice >= 0 ? minPrice : undefined,
        maxPriceRubles: maxPrice !== undefined && maxPrice >= 0 ? maxPrice : undefined,
        minCashbackPercent: minCashback !== undefined && minCashback >= 0 ? minCashback : undefined,
      },
    });
  } catch (err) {
    console.error('[search] failed', err);
    return <ErrorState message={describe(err)} />;
  }

  const linkParams: Record<string, string | undefined> = {
    q,
    minPrice: minPrice?.toString(),
    maxPrice: maxPrice?.toString(),
    minCashback: minCashback?.toString(),
  };

  if (data.items.length === 0) {
    return (
      <EmptyState
        title="Ничего не найдено"
        hint={`По запросу «${q}» ничего нет. База заполняется по мере обхода каталогов краулером.`}
      />
    );
  }

  return (
    <>
      <p className="mb-4 text-sm text-slate-600">
        Найдено {data.totalCount.toLocaleString('ru-RU')}{' '}
        {plural(data.totalCount, 'товар', 'товара', 'товаров')}
      </p>
      <ProductGrid items={data.items} />
      <Pagination page={data} basePath="/search" searchParams={linkParams} />
    </>
  );
}