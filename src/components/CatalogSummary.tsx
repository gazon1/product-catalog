import type { ReactNode } from 'react';
import { Moment } from './Moment';
import { countersAsOfMoment, dataAsOfMoment } from '@/lib/freshness';
import type { SiteStats } from '@/lib/types';

/**
 * Блок со счётчиками — и оба момента, которые к нему относятся.
 *
 * ## Два момента, два слова
 *
 * Счётчики и данные — разные вещи, и стареют они по-разному:
 *
 *   - `asOf` — момент, когда счётчики **посчитали** (агрегат кешируется на
 *     десять минут, поэтому он может быть старше данных);
 *   - `dataAsOf` — момент, когда витрину **обошли**: это момент самих данных.
 *
 * Поэтому подписи здесь не отличаются шрифтом, а отличаются словами:
 * «счётчики посчитаны в …» и «данные на …». Подписать `asOf` как «данные
 * на …» — значит соврать посетителю о свежести данных.
 *
 * ## Почему вместо «Обновлено»
 *
 * Прежняя карточка «Обновлено» показывала `newestScrapedAt` — тот же момент,
 * что и `dataAsOf` у счётчиков (новейшее наблюдение среди посчитанных
 * товаров), но подписью, которая не отвечала на вопрос: обновлено что — данные
 * или счётчики? Теперь на её месте «Данные на …», и это тот же момент, но
 * названный тем, чем он является.
 */
export function CatalogSummary({ stats }: { stats: SiteStats }) {
  const data = dataAsOfMoment(stats.dataAsOf);
  const counters = countersAsOfMoment(stats.asOf);

  return (
    <section aria-label="Сводка" className="mb-10">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Товаров" value={stats.totalProducts.toLocaleString('ru-RU')} />
        <Stat label="Каталогов" value={stats.totalTargets.toLocaleString('ru-RU')} />
        <Stat label="С кэшбэком" value={stats.productsWithCashback.toLocaleString('ru-RU')} />
        <Stat label={data.label} value={<Moment moment={data} />} small />
      </div>

      <p className="mt-3 text-xs text-slate-500">
        {counters.label} <Moment moment={counters} />
      </p>
    </section>
  );
}

/** Одна плитка счётчика. */
function Stat({ label, value, small }: { label: string; value: ReactNode; small?: boolean }) {
  return (
    <div className="card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p
        className={
          small
            ? 'mt-1 text-sm font-semibold text-slate-800'
            : 'mt-1 text-2xl font-bold text-slate-900'
        }
      >
        {value}
      </p>
    </div>
  );
}
