import Link from 'next/link';

export interface Crumb {
  label: string;
  href?: string;
}

/**
 * Ported from the previous solution's `BreadcrumbBar`, which is worth keeping:
 * it renders the last crumb as plain text rather than a link to itself, which is
 * both correct for screen readers and one less link to tab through.
 */
export function BreadcrumbBar({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav aria-label="Хлебные крошки" className="py-2 text-sm text-slate-500">
      <ol className="flex flex-wrap items-center gap-1">
        <li>
          <Link href="/" className="text-slate-500 no-underline hover:text-slate-800">
            Главная
          </Link>
        </li>
        {crumbs.map((c, i) => (
          <li key={`${c.label}-${i}`} className="flex items-center gap-1">
            <span aria-hidden="true">/</span>
            {c.href && i < crumbs.length - 1 ? (
              <Link href={c.href} className="text-slate-500 no-underline hover:text-slate-800">
                {c.label}
              </Link>
            ) : (
              <span className="text-slate-800" aria-current="page">
                {c.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}