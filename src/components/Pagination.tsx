import Link from 'next/link';
import type { Paged } from '@/lib/types';

/**
 * Pagination built by hand rather than with a component library.
 *
 * The previous solution's page numbers came from a MUI pagination whose total
 * count it trusted; with a large catalog that renders hundreds of buttons. Here
 * the window is a fixed seven slots around the current page, which is the only
 * part anyone navigates by.
 */
export function Pagination({ page, basePath, searchParams }: { page: Paged<unknown>; basePath: string; searchParams?: Record<string, string | undefined> }) {
  const { totalPages, page: current, hasNextPage, hasPrevPage } = page;
  if (totalPages <= 1) return null;

  const href = (target: number) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(searchParams ?? {})) {
      if (value !== undefined) params.set(key, value);
    }
    if (target <= 0) params.delete('page');
    else params.set('page', String(target));
    const qs = params.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };

  const slots: (number | 'gap')[] = [];
  const start = Math.max(0, Math.min(current - 3, totalPages - 7));
  const end = Math.min(totalPages, start + 7);
  for (let i = start; i < end; i += 1) {
    if (i > start + 1) slots.push('gap');
    slots.push(i);
  }

  return (
    <nav aria-label="Постраничная навигация" className="mt-8 flex items-center justify-center gap-1">
      {hasPrevPage ? (
        <Link href={href(current - 1)} className="btn-ghost" rel="prev">
          ← Назад
        </Link>
      ) : (
        <span className="btn-ghost cursor-not-allowed opacity-40">← Назад</span>
      )}

      {slots.map((slot, i) =>
        slot === 'gap' ? (
          <span key={`gap-${i}`} className="px-2 text-slate-400">
            …
          </span>
        ) : (
          <Link
            key={slot}
            href={href(slot)}
            aria-current={slot === current ? 'page' : undefined}
            className={slot === current ? 'btn-primary' : 'btn-ghost'}
          >
            {slot + 1}
          </Link>
        )
      )}

      {hasNextPage ? (
        <Link href={href(current + 1)} className="btn-ghost" rel="next">
          Вперёд →
        </Link>
      ) : (
        <span className="btn-ghost cursor-not-allowed opacity-40">Вперёд →</span>
      )}
    </nav>
  );
}