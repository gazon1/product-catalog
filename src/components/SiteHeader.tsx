import Link from 'next/link';

const NAV = [
  { href: '/catalog', label: 'Каталоги' },
  { href: '/top-deals', label: 'Топ кэшбэка' },
  { href: '/search', label: 'Поиск' },
] as const;

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="container-page flex h-14 items-center gap-6">
        <Link href="/" className="shrink-0 text-base font-bold no-underline text-slate-900">
          Витрина<span className="text-brand-600"></span>
        </Link>

        <nav aria-label="Основная навигация" className="flex items-center gap-1">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 no-underline hover:bg-slate-100 hover:text-slate-900"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <form action="/search" className="ml-auto hidden max-w-sm flex-1 sm:block" role="search">
          <label htmlFor="header-search" className="sr-only">
            Поиск товаров
          </label>
          <input
            id="header-search"
            name="q"
            type="search"
            placeholder="Найти товар…"
            className="input py-1.5"
            maxLength={200}
          />
        </form>
      </div>
    </header>
  );
}