/**
 * Общий харнесс контрактных тестов: как файл узнаёт, какой краулер запущен,
 * и какие значения он должен подставить в окружение.
 *
 * ## Зачем это отдельный файл
 *
 * Контрактная проверка разложена по слоям, и почти каждый слой начинается с
 * одного и того же: прочитать файл передачи, убедиться, что краулер жив, и
 * подставить его адрес и ключ в окружение. Этот кусок не должен расходиться
 * между файлами — два файла, которые подставляют разное, проверяют разное, а
 * читатель думает, что проверяют одно.
 *
 * ## Почему окружение готовится на каждый тест, а не один раз
 *
 * `beforeAll`, который бросает, оставляет тесты файла *пропущенными*, а
 * пропущенный тест — это тест, который ничего не проверил: набор, который
 * отчитывается об успехе, ничего не выполнив, хуже, чем набора нет вовсе.
 * `beforeEach`, который бросает, делает красными все тесты файла — и сообщение
 * говорит, чего именно не хватает.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach } from 'vitest';
import type { ContractEnvironment } from './environment';

/** Окружение текущего теста — то, что передал главный процесс. */
let environment: ContractEnvironment | null = null;

/**
 * Найти файл передачи.
 *
 * По времени изменения, а не по имени: прерванный прогон оставляет свой
 * каталог позади, и выбор устаревшего файла означает обращение к контейнеру,
 * который уже остановили — то есть набор падает против краулера, который
 * минуту назад работал perfectly well.
 */
function findContractFile(): string | null {
  const dirs = readdirSync(tmpdir()).filter((n) => n.startsWith('product-catalog-contract-'));
  const withFiles = dirs
    .map((dir) => join(tmpdir(), dir, 'contract.json'))
    .filter((candidate) => existsSync(candidate))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return withFiles[0] ?? null;
}

/**
 * Окружение прогона, как его знает текущий тест.
 *
 * @throws когда окружение не было подготовлено — то есть тест позвал
 *   помощника до того, как `useContractEnvironment()` отработал.
 */
export function contractEnvironment(): ContractEnvironment {
  if (environment === null) {
    throw new Error(
      'the contract environment was not prepared — call useContractEnvironment() in the test file',
    );
  }
  return environment;
}

/**
 * Подготовить окружение прогона к каждому тесту файла.
 *
 * Вызывается один раз на файл, на верхнем уровне: хук, зарегистрированный
 * здесь, действует на все тесты этого файла.
 */
export function useContractEnvironment(): void {
  beforeEach(() => {
    const file = findContractFile();
    if (file === null) {
      throw new Error(
        'no contract environment file. The global setup either did not run or failed before ' +
          'it could hand over the crawler — failing here rather than letting the suite run ' +
          'without a crawler.',
      );
    }

    const values = JSON.parse(readFileSync(file, 'utf8')) as ContractEnvironment;

    if (values.error) {
      throw new Error(values.error);
    }
    if (!values.apiUrl || !values.apiKey) {
      throw new Error('the contract environment file carries no usable base URL or key.');
    }

    // Клиент читает окружение в момент вызова, и это то, что позволяет
    // тесту направить *производственные* функции на контейнер.
    process.env.CRAWLER_API_URL = values.apiUrl;
    process.env.CRAWLER_API_KEY = values.apiKey;

    environment = values;
  });
}

/**
 * Цена, по которой карточка показывается: цена со скидкой, если она есть.
 *
 * Фильтры по цене сравнивают с этой величиной, а не с `priceKopecks`: карточка
 * со скидкой показывается по скидочной цене, и фильтр «от ста рублей» не
 * должен отсекать товар, который на самом деле стоит больше.
 */
export function effectivePriceKopecks(item: {
  priceKopecks: number | null;
  salePriceKopecks: number | null;
}): number | null {
  if (item.salePriceKopecks !== null && item.salePriceKopecks > 0) return item.salePriceKopecks;
  return item.priceKopecks;
}

/**
 * Всё, по чему ищет поиск.
 *
 * Поиск краулера ищет по названию, бренду и продавцу — и проверка ищет по
 * тому же, иначе она проверяла бы не то, что ищет поиск.
 */
export function searchHaystack(item: {
  title: string;
  brand: string | null;
  seller: string | null;
}): string {
  return `${item.title} ${item.brand ?? ''} ${item.seller ?? ''}`.toLowerCase();
}
