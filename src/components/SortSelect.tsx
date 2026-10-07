import { SORT_ORDERS, type SortOrder } from '@/lib/types';

const LABELS: Record<SortOrder, string> = {
  DateDesc: 'Сначала новые',
  DateAsc: 'Сначала старые',
  PriceAsc: 'Цена: по возрастанию',
  PriceDesc: 'Цена: по убыванию',
  CashbackPercentDesc: 'Кэшбэк: по убыванию',
  CashbackPercentAsc: 'Кэшбэк: по возрастанию',
  TitleAsc: 'Название: А → Я',
  TitleDesc: 'Название: Я → А',
};

/**
 * Sort control. A plain GET form, not a client component with `router.push`:
 * the resulting URL *is* the state, so it survives a reload, can be shared, and
 * works with the browser's back button without any of that being implemented.
 *
 * ## There is no `onChange` here, deliberately
 *
 * This is a Server Component, and React refuses to serialise an event handler
 * into one — "Event handlers cannot be passed to Client Component props" is a
 * *render-time* error, so the whole page died and Next fell back to its error
 * shell. The symptom was a category page that streamed its content into the RSC
 * payload and still rendered nothing but a 404-shaped error document.
 *
 * Auto-submitting on change was the only reason the handler existed. Losing it
 * costs one extra click, and the alternative — making this a client component
 * and shipping `useSearchParams` — is a runtime dependency on JavaScript for a
 * control that a GET form already covers.
 */
export function SortSelect({
  sort,
  basePath,
  extraParams,
}: {
  sort: SortOrder;
  basePath: string;
  extraParams?: Record<string, string | undefined>;
}) {
  return (
    <form method="get" action={basePath} className="flex items-center gap-2">
      {Object.entries(extraParams ?? {}).map(([key, value]) =>
        value !== undefined ? <input key={key} type="hidden" name={key} value={value} /> : null
      )}
      <label htmlFor="sort" className="text-sm text-slate-600">
        Сортировка
      </label>
      <select id="sort" name="sort" defaultValue={sort} className="input w-auto py-1.5">
        {SORT_ORDERS.map((order) => (
          <option key={order} value={order}>
            {LABELS[order]}
          </option>
        ))}
      </select>
      <button type="submit" className="btn-ghost py-1.5">
        Применить
      </button>
    </form>
  );
}