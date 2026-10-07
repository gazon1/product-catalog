import { cashbackLabel } from '@/lib/cashback';
import { kopecksToRubles } from '@/lib/money';
import type { PricePoint } from '@/lib/types';

const SHORT_DATE = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
});

/**
 * Price history as an inline SVG sparkline plus a table.
 *
 * No charting library: this is one polyline and a scaled viewBox, and a library
 * would add a client-side runtime to a page that is otherwise server-rendered.
 * The table carries the same numbers as the chart because a chart alone is not
 * readable data — and on a site whose subject is money, exactness is the point.
 */
export function PriceHistory({ history }: { history: PricePoint[] }) {
  if (history.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        История цен недоступна: краулер записал этот товар один раз и без идентификатора
        <code className="mx-1 rounded bg-slate-100 px-1">product_id</code>.
      </p>
    );
  }

  // The query returns newest-first; a chart reads left-to-right in time order.
  const points = [...history].reverse();

  return (
    <div className="flex flex-col gap-4">
      <Sparkline points={points} />

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">История цены и кэшбэка</caption>
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th scope="col" className="py-2 pr-4 font-medium">
                Дата
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Цена
              </th>
              <th scope="col" className="py-2 font-medium">
                Кэшбэк
              </th>
            </tr>
          </thead>
          <tbody>
            {history.slice(0, 20).map((p) => (
              <tr key={p.scrapedAt} className="border-b border-slate-100 last:border-0">
                <td className="whitespace-nowrap py-1.5 pr-4 text-slate-600">
                  {SHORT_DATE.format(new Date(p.scrapedAt))}
                </td>
                <td className="py-1.5 pr-4 font-medium text-slate-900">
                  {kopecksToRubles(p.priceKopecks)?.toLocaleString('ru-RU') ?? '—'}
                </td>
                <td className="py-1.5 text-slate-600">{cashbackLabel(p.cashbackPercent)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {history.length > 20 && (
        <p className="text-xs text-slate-400">Показаны первые 20 из {history.length} наблюдений.</p>
      )}
    </div>
  );
}

function Sparkline({ points }: { points: PricePoint[] }) {
  const prices = points
    .map((p) => kopecksToRubles(p.priceKopecks))
    .filter((v): v is number => v !== null);

  // A single observation is a flat line; rendering it as a chart implies a trend
  // that does not exist, so the empty state below is the honest output.
  if (prices.length < 2) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
        Недостаточно наблюдений для графика
      </div>
    );
  }

  const width = 600;
  const height = 160;
  const pad = 8;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  // All prices identical would make the range 0 and divide by zero; a flat line
  // at mid-height is the right rendering of "never changed".
  const span = max - min || 1;

  const coords = points.map((p, i) => {
    const price = kopecksToRubles(p.priceKopecks);
    const y = price === null ? height / 2 : height - pad - ((price - min) / span) * (height - pad * 2);
    const x = pad + (i / (points.length - 1)) * (width - pad * 2);
    return [x, y] as const;
  });

  const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${pad},${height - pad} ${line} ${width - pad},${height - pad}`;

  return (
    <figure className="rounded-lg border border-slate-200 bg-white p-3">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-40 w-full"
        role="img"
        aria-label={`График цены: от ${Math.round(min)} до ${Math.round(max)} рублей за ${points.length} наблюдений`}
      >
        <polygon points={area} fill="#2f6fed" fillOpacity="0.08" />
        <polyline points={line} fill="none" stroke="#2f6fed" strokeWidth="2" strokeLinejoin="round" />
      </svg>
      <figcaption className="mt-1 flex justify-between text-xs text-slate-500">
        <span>{new Date(points[0]?.scrapedAt ?? '').toISOString().slice(0, 10)}</span>
        <span>
          мин. {Math.round(min).toLocaleString('ru-RU')} ₽ · макс.{' '}
          {Math.round(max).toLocaleString('ru-RU')} ₽
        </span>
        <span>{new Date(points[points.length - 1]?.scrapedAt ?? '').toISOString().slice(0, 10)}</span>
      </figcaption>
    </figure>
  );
}