import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="container-page py-20 text-center">
      <p className="text-5xl font-bold text-slate-200">404</p>
      <h1 className="mt-3 text-xl font-semibold text-slate-900">Страница не найдена</h1>
      <p className="mx-auto mt-2 max-w-md text-sm text-slate-600">
        Возможно, каталог переименован или был удалён из настроек краулера. Ссылки на категории
        строятся из названия, поэтому переименование меняет адрес.
      </p>
      <div className="mt-6 flex justify-center gap-3">
        <Link href="/" className="btn-primary">
          На главную
        </Link>
        <Link href="/catalog" className="btn-ghost">
          Каталоги
        </Link>
      </div>
    </div>
  );
}