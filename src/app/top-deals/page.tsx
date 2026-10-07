import type { Metadata } from 'next';
import { listTopDeals } from '@/lib/queries';
import { readNonNegativeNumber, readNumber, type SearchParams } from '@/lib/params';
import { ProductGrid } from '@/components/ProductCard';
import { Pagination } from '@/components/Pagination';
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

export const metadata: Metadata = {
  title: 'Топ по кэшбэку',
  description: 'Товары с наибольшим процентом кэшбэка на текущий момент.',
  alternates: { canonical: '/top-deals' },
};

type Props = { searchParams: Promise<SearchParams> };

export default async function TopDealsPage({ searchParams }: Props) {
  const sp = await searchParams;
  const page = readNumber(sp, 'page') ?? 0;
  const minCashback = readNonNegativeNumber(sp, 'minCashback');

  let data;
  try {
    data = await listTopDeals({ minCashbackPercent: minCashback, paging: { page, pageSize: 24 } });
  } catch (err) {
    console.error('[top-deals] failed', err);
    return (
      <div className="container-page py-6">
        <BreadcrumbBar crumbs={[{ label: 'Топ по кэшбэку' }]} />
        <ErrorState message={describe(err)} />
      </div>
    );
  }

  const linkParams: Record<string, string | undefined> = {
    minCashback: minCashback?.toString(),
  };

  return (
    <div className="container-page py-6">
      <BreadcrumbBar crumbs={[{ label: 'Топ по кэшбэку' }]} />

      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Топ по кэшбэку</h1>
        <p className="mt-1 text-sm text-slate-600">
          {data.totalCount.toLocaleString('ru-RU')}{' '}
          {plural(data.totalCount, 'товар', 'товара', 'товаров')}
          {minCashback !== undefined && ` с кэшбэком от ${minCashback}%`}
        </p>
      </header>

      <form method="get" action="/top-deals" className="mb-6 flex items-end gap-2">
        <div className="w-40">
          <label htmlFor="minCashback" className="mb-1 block text-xs font-medium text-slate-600">
            Кэшбэк от, %
          </label>
          <input
            id="minCashback"
            type="number"
            name="minCashback"
            defaultValue={minCashback ?? ''}
            min={0}
            max={100}
            step={1}
            className="input"
          />
        </div>
        <button type="submit" className="btn-primary">
          Применить
        </button>
        <a href="/top-deals" className="btn-ghost">
          Сбросить
        </a>
      </form>

      {data.items.length === 0 ? (
        <EmptyState
          title="Топ пуст"
          hint="Краулер ещё не записал идентификатор match_id, по которому один и тот же товар опознаётся во всех каталогах."
        />
      ) : (
        <>
          <ProductGrid items={data.items} />
          <Pagination page={data} basePath="/top-deals" searchParams={linkParams} />
        </>
      )}
    </div>
  );
}