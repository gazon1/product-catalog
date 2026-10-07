/**
 * Filter panel — a GET form, like `SortSelect`.
 *
 * Price bounds are entered in **rubles** and converted to kopecks on the way into
 * the query. The conversion happens in exactly one place (`buildWhere`); doing it
 * here as well would be a second rounding step that disagrees with the first.
 */
export function FilterBar({
  action,
  search,
  minPrice,
  maxPrice,
  minCashback,
  inStockOnly,
}: {
  action: string;
  search?: string | undefined;
  minPrice?: number | undefined;
  maxPrice?: number | undefined;
  minCashback?: number | undefined;
  inStockOnly?: boolean | undefined;
}) {
  return (
    <form method="get" action={action} className="card flex flex-col gap-3 p-4 sm:flex-row sm:flex-wrap sm:items-end">
      {search !== undefined && <input type="hidden" name="q" value={search} />}

      <div className="flex-1">
        <label htmlFor="q" className="mb-1 block text-xs font-medium text-slate-600">
          Поиск
        </label>
        <input
          id="q"
          type="search"
          name="q"
          defaultValue={search ?? ''}
          placeholder="название, бренд, продавец"
          maxLength={200}
          className="input"
        />
      </div>

      <div className="w-full sm:w-36">
        <label htmlFor="minPrice" className="mb-1 block text-xs font-medium text-slate-600">
          Цена от, ₽
        </label>
        <input
          id="minPrice"
          type="number"
          name="minPrice"
          defaultValue={minPrice ?? ''}
          min={0}
          step={1}
          inputMode="numeric"
          className="input"
        />
      </div>

      <div className="w-full sm:w-36">
        <label htmlFor="maxPrice" className="mb-1 block text-xs font-medium text-slate-600">
          Цена до, ₽
        </label>
        <input
          id="maxPrice"
          type="number"
          name="maxPrice"
          defaultValue={maxPrice ?? ''}
          min={0}
          step={1}
          inputMode="numeric"
          className="input"
        />
      </div>

      <div className="w-full sm:w-36">
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
          inputMode="numeric"
          className="input"
        />
      </div>

      <label className="flex items-center gap-2 pb-2 text-sm text-slate-700">
        <input
          type="checkbox"
          name="inStock"
          value="1"
          defaultChecked={inStockOnly ?? false}
          className="h-4 w-4 rounded border-slate-300 text-brand-600"
        />
        только в наличии
      </label>

      <div className="flex gap-2 pb-0.5">
        <button type="submit" className="btn-primary">
          Применить
        </button>
        <a href={action} className="btn-ghost">
          Сбросить
        </a>
      </div>
    </form>
  );
}