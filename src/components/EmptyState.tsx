import Link from 'next/link';

/**
 * Shown when a query succeeded but matched nothing.
 *
 * The distinction from an error matters: this site renders an empty result
 * honestly instead of implying the database is empty, and the message names the
 * reason it knows — there is data, it just does not match.
 */
export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: { href: string; label: string } }) {
  return (
    <div className="card flex flex-col items-center gap-2 px-6 py-16 text-center">
      <p className="text-base font-medium text-slate-800">{title}</p>
      {hint && <p className="max-w-md text-sm text-slate-500">{hint}</p>}
      {action && (
        <Link href={action.href} className="btn-primary mt-2">
          {action.label}
        </Link>
      )}
    </div>
  );
}

/** Shown when the database itself is unreachable — a different problem, stated differently. */
export function ErrorState({ message }: { message: string }) {
  return (
    <div className="card flex flex-col items-center gap-2 border-rose-200 bg-rose-50 px-6 py-16 text-center">
      <p className="text-base font-medium text-rose-900">Не удалось загрузить данные</p>
      <p className="max-w-md text-sm text-rose-800">{message}</p>
      <p className="mt-2 text-xs text-rose-700">
        Витрина не изменяет базу краулера и не переключается на кэш: пустая страница здесь была бы
        неправдой.
      </p>
    </div>
  );
}