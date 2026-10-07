import Link from 'next/link';
import { ProductImage } from './ProductImage';
import { cashbackBadgeClass, cashbackLabel, cashbackTier } from '@/lib/cashback';
import { discountPercent, effectivePriceKopecks, formatRubles, kopecksToRubles } from '@/lib/money';
import type { ProductCard as ProductCardModel } from '@/lib/types';

const DATE_FORMAT = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'UTC',
});

export function formatScrapedAt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : DATE_FORMAT.format(d);
}

export function ProductCard({ item }: { item: ProductCardModel }) {
  const effective = effectivePriceKopecks(item.priceKopecks, item.salePriceKopecks);
  const discount = discountPercent(item.priceKopecks, item.salePriceKopecks);
  const tier = cashbackTier(item.cashbackPercent);

  return (
    <article className="card group flex flex-col overflow-hidden transition-shadow hover:shadow-md">
      <Link href={`/product/${item.id}`} className="block p-3 no-underline">
        <ProductImage src={item.imageUrl} alt={item.title} brand={item.brand} />
      </Link>

      <div className="flex flex-1 flex-col gap-2 p-3 pt-0">
        <div className="flex flex-wrap items-center gap-1.5">
          {item.cashbackPercent !== null && (
            <span className={`badge ${cashbackBadgeClass(tier)}`}>
              Кэшбэк {cashbackLabel(item.cashbackPercent)}
            </span>
          )}
          {discount !== null && discount > 0 && (
            <span className="badge bg-rose-100 text-rose-800 ring-rose-200">−{discount}%</span>
          )}
          {item.inStock === false && (
            <span className="badge bg-slate-100 text-slate-600 ring-slate-200">Нет в наличии</span>
          )}
        </div>

        <h3 className="line-clamp-2 text-sm font-medium leading-snug text-slate-900">
          {/* The whole card is clickable, so this is a link to the same place as
              the image above. Wrapping the article in a single Link would nest
              interactive elements and break keyboard traversal. */}
          <Link href={`/product/${item.id}`} className="no-underline hover:text-brand-700">
            {item.title}
          </Link>
        </h3>

        {item.brand && <p className="truncate text-xs text-slate-500">{item.brand}</p>}

        <div className="mt-auto flex items-end justify-between gap-2 pt-1">
          <div>
            <p className="text-lg font-bold text-slate-900">
              {formatRubles(kopecksToRubles(effective))}
            </p>
            {item.cashbackRubles !== null && (
              <p className="text-xs text-slate-500">≈ {formatRubles(item.cashbackRubles)} кэшбэка</p>
            )}
          </div>
          <p className="shrink-0 text-xs text-slate-400">{formatScrapedAt(item.scrapedAt)}</p>
        </div>
      </div>
    </article>
  );
}

export function ProductGrid({ items }: { items: ProductCardModel[] }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {items.map((item) => (
        <ProductCard key={item.id} item={item} />
      ))}
    </div>
  );
}