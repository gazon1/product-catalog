import type { Metadata } from 'next';
import Link from 'next/link';
import { listTargets } from '@/lib/queries';
import { targetSlug } from '@/lib/slug';
import { EmptyState, ErrorState } from '@/components/EmptyState';
import { describe, plural } from '@/lib/format';

export const metadata: Metadata = {
  title: 'Каталог',
  description: 'Все каталоги, которые обходит краулер: техника, одежда, дом и другие категории.',
  alternates: { canonical: '/catalog' },
};

// The category list is a GROUP BY over scraped_items, so it is the one aggregate
// on this site that gets expensive as the table grows. 10 minutes is the
// compromise; see the note on `listTargets`.
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

export default async function CatalogPage() {
  let targets;
  try {
    targets = await listTargets();
  } catch (err) {
    console.error('[catalog] failed to load targets', err);
    return (
      <div className="container-page py-8">
        <h1 className="mb-4 text-2xl font-bold text-slate-900">Каталог</h1>
        <ErrorState message={describe(err)} />
      </div>
    );
  }

  if (targets.length === 0) {
    return (
      <div className="container-page py-8">
        <h1 className="mb-4 text-2xl font-bold text-slate-900">Каталог</h1>
        <EmptyState
          title="Каталоги не настроены"
          hint="В базе краулера нет ни одной записи в crawl_targets. Добавьте её — и категория появится здесь автоматически."
        />
      </div>
    );
  }

  const withData = targets.filter((t) => t.itemCount > 0);
  const withoutData = targets.filter((t) => t.itemCount === 0);

  return (
    <div className="container-page py-8">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">Каталог</h1>
      <p className="mt-1 text-sm text-slate-600">
        {targets.length} {plural(targets.length, 'каталог', 'каталога', 'каталогов')} настроено
      </p>

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {targets.map((t) => {
          const slug = targetSlug(t.name, t.id);
          return (
            <Link
              key={t.id}
              href={`/category/${slug}`}
              className="card flex flex-col gap-1 p-4 no-underline transition-shadow hover:shadow-md"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="font-medium text-slate-900">{t.name}</span>
                {!t.isActive && (
                  <span className="badge shrink-0 bg-slate-100 text-slate-600 ring-slate-200">
                    неактивен
                  </span>
                )}
              </div>
              <span className="text-sm text-slate-500">
                {t.itemCount > 0
                  ? `${t.itemCount.toLocaleString('ru-RU')} ${plural(t.itemCount, 'товар', 'товара', 'товаров')}`
                  : 'пока пусто'}
              </span>
            </Link>
          );
        })}
      </div>

      {withData.length === 0 && withoutData.length > 0 && (
        <p className="mt-6 text-sm text-slate-500">
          Каталоги настроены, но ни один обход ещё ничего не записал.
        </p>
      )}
    </div>
  );
}