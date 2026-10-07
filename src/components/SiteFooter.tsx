export function SiteFooter() {
  return (
    <footer className="mt-12 border-t border-slate-200 bg-white">
      <div className="container-page py-6 text-sm text-slate-500">
        <p>
          Витрина читает базу краулера в режиме&nbsp;только&nbsp;чтение и ничего в ней не изменяет.
          Цены и кэшбэк — на момент последнего обхода каталога.
        </p>
        <p className="mt-1 text-xs text-slate-400">
          Данные принадлежат их владельцам. Проект не связан с upstream.
        </p>
      </div>
    </footer>
  );
}