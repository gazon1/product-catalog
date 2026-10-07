import type { Metadata } from 'next';
import Link from 'next/link';
import { listItems, listTargets, getSiteStats, listTopDeals } from '@/lib/queries';
import { ProductGrid } from '@/components/ProductCard';
import { EmptyState, ErrorState } from '@/components/EmptyState';
import { targetSlug } from '@/lib/slug';
import { formatScrapedAt } from '@/components/ProductCard';
import { describe, plural } from '@/lib/format';

export const metadata: Metadata = {
  title: 'Витрина товаров',
};

// The crawler writes continuously, so the home page's job is to show what is
// recent. 60s is short enough to feel live and long enough that a page refresh
// during a crawl does not re-run the aggregate query every time.
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

export default async function HomePage() {
  try {
    const [stats, targets, fresh, deals] = await Promise.all([
      getSiteStats(),
      listTargets(),
      listItems({ paging: { page: 0, pageSize: 10 }, sort: 'DateDesc' }),
      listTopDeals({ paging: { page: 0, pageSize: 5 } }),
    ]);

    const isEmpty = stats.totalItems === 0;

    return (
      <div className="container-page py-8">
        <section className="mb-10">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            Каталог с ценами и кэшбэком
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-600">
            Витрина читает базу краулера напрямую и только на чтение. Каждая карточка — одно
            наблюдение товара на момент последнего обхода каталога.
          </p>
        </section>

        <section aria-label="Сводка" className="mb-10 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Товаров" value={stats.totalItems.toLocaleString('ru-RU')} />
          <Stat label="Каталогов" value={stats.totalTargets.toLocaleString('ru-RU')} />
          <Stat label="С кэшбэком" value={stats.withCashback.toLocaleString('ru-RU')} />
          <Stat
            label="Обновлено"
            value={stats.newestScrapedAt ? formatScrapedAt(stats.newestScrapedAt) : '—'}
            small
          />
        </section>

        {isEmpty && (
          <div className="mb-10">
            <EmptyState
              title="В базе пока нет товаров"
              hint="Каталоги настроены, но ни один обход ещё ничего не записал. Страница работает — данных просто нет."
              action={{ href: '/catalog', label: 'Посмотреть каталоги' }}
            />
          </div>
        )}

        {!isEmpty && (
          <>
            <section aria-labelledby="fresh" className="mb-12">
              <div className="mb-4 flex items-baseline justify-between">
                <h2 id="fresh" className="text-lg font-semibold text-slate-900">
                  Свежие товары
                </h2>
                <Link href="/catalog" className="text-sm text-brand-700">
                  Все каталоги →
                </Link>
              </div>
              {fresh.items.length === 0 ? (
                <EmptyState title="Ничего не найдено" />
              ) : (
                <ProductGrid items={fresh.items} />
              )}
            </section>

            <section aria-labelledby="deals" className="mb-12">
              <div className="mb-4 flex items-baseline justify-between">
                <h2 id="deals" className="text-lg font-semibold text-slate-900">
                  Высокий кэшбэк
                </h2>
                <Link href="/top-deals" className="text-sm text-brand-700">
                  Весь топ →
                </Link>
              </div>
              {deals.items.length === 0 ? (
                <EmptyState
                  title="Топ пуст"
                  hint="Краулер пока не записал идентификатор match_id, по которому один товар опознаётся во всех каталогах."
                />
              ) : (
                <ProductGrid items={deals.items} />
              )}
            </section>
          </>
        )}

        {targets.length > 0 && (
          <section aria-labelledby="targets">
            <h2 id="targets" className="mb-4 text-lg font-semibold text-slate-900">
              Каталоги
            </h2>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {targets.map((t) => (
                <li key={t.id}>
                  <Link
                    href={`/category/${targetSlug(t.name, t.id)}`}
                    className="card block p-4 no-underline transition-shadow hover:shadow-md"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-medium text-slate-900">{t.name}</span>
                      {!t.isActive && (
                        <span className="badge shrink-0 bg-slate-100 text-slate-600 ring-slate-200">
                          неактивен
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-sm text-slate-500">
                      {t.itemCount.toLocaleString('ru-RU')}{' '}
                      {plural(t.itemCount, 'товар', 'товара', 'товаров')}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    );
  } catch (err) {
    console.error('[home] render failed', err);
    return (
      <div className="container-page py-8">
        <h1 className="mb-4 text-2xl font-bold text-slate-900">Каталог с ценами и кэшбэком</h1>
        <ErrorState message={describe(err)} />
      </div>
    );
  }
}

function Stat({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return (
    <div className="card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={small ? 'mt-1 text-sm font-semibold text-slate-800' : 'mt-1 text-2xl font-bold text-slate-900'}>
        {value}
      </p>
    </div>
  );
}