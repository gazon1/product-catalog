'use client';

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="container-page py-20 text-center">
      <p className="text-5xl font-bold text-rose-200">500</p>
      <h1 className="mt-3 text-xl font-semibold text-slate-900">Что-то пошло не так</h1>
      <p className="mx-auto mt-2 max-w-md text-sm text-slate-600">
        Страница не отрисовалась. Это ошибка сервера — данные при этом не пострадали: витрина ничего
        не пишет в базу краулера.
      </p>
      <div className="mt-6 flex justify-center gap-3">
        <button onClick={reset} className="btn-primary">
          Попробовать снова
        </button>
        <a href="/" className="btn-ghost">
          На главную
        </a>
      </div>
    </div>
  );
}