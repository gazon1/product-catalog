/**
 * Подъём контейнера краулера: собрать, запустить, дождаться и остановить.
 *
 * ## Зачем это отдельный файл
 *
 * Это фасад прогона: здесь собирается контейнер, здесь он запускается и
 * здесь останавливается. Всё, что требует отдельного решения, вынесено
 * дальше:
 *
 *   - `tests/contract/readiness.ts` — как спрашивают краулера о готовности и
 *     сколько ждут ответа;
 *   - `tests/contract/diagnosis.ts` — что сказать, когда неудача наступила.
 *
 * Фасад знает только порядок: поднять, дождаться, передать результат.
 *
 * ## Отсутствие Docker — это провал, а не пропуск
 *
 * Если до демона не достучаться, здесь бросается исключение. Набор, который
 * отчитывается об успехе, ничего не выполнив, хуже, чем набора нет вовсе:
 * это зелёная сборка, не проверившая ничего, — ровно тот дефект, против
 * которого работает весь этот репозиторий.
 *
 * ## Контейнер никогда не ждёт порт
 *
 * Ожидание порта — это чужая стратегия с чужим сроком и чужим сообщением.
 * Порт не ждёт никто: готовность опрашивается сама, на нашем бюджете, и
 * неудача объясняется нашими словами, а не сообщением testcontainers.
 */

import { execFileSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';
import {
  ADMIN_API_KEY,
  API_KEY,
  CATALOG_ROLE_PASSWORD,
  CRAWLER_PORT,
  DEMO_SEED_PASSWORD,
  DEMO_SEED_ROLE,
  extraCrawlerEnvironment,
} from './environment';
import { waitForCrawler } from './readiness';

declare global {
  // eslint-disable-next-line no-var
  var __catalogCrawlerStarted: StartedTestContainer | undefined;
  // eslint-disable-next-line no-var
  var __catalogPostgresStarted: StartedTestContainer | undefined;
  // eslint-disable-next-line no-var
  var __catalogNetworkStarted: StartedNetwork | undefined;
}

/**
 * Стратегия ожидания, с которой запускается контейнер краулера: никакая.
 *
 * Пустой состав — это стратегия, которая не ждёт ничего, и именно в этом её
 * смысл. Стратегия testcontainers по умолчанию ждёт, пока порт контейнера
 * будет занят, и сдаётся через 60 секунд с собственным «Port 8080 not bound
 * after 60000ms» — сроком, который срабатывает раньше нашего, и ошибкой,
 * которая ничего не знает о краулере. Готовность опрашивается в
 * `tests/contract/readiness.ts`, на READY_TIMEOUT_MS, с кодом возврата и
 * логом краулера как диагнозом.
 */
const NO_PORT_WAIT = Wait.forAll([]);

/** Что вышло из попытки поднять краулера. */
export type CrawlerRun =
  | {
      outcome: 'ready';
      apiUrl: string;
      apiKey: string;
      containerId: string;
      postgresUri: string;
      error: null;
    }
  | {
      outcome: 'not-ready';
      apiUrl: string | null;
      apiKey: string;
      containerId: string;
      postgresUri: string;
      error: string;
    }
  | {
      outcome: 'not-started';
      apiUrl: null;
      apiKey: null;
      containerId: null;
      postgresUri: null;
      error: string;
    };

/**
 * Демон Docker должен быть на месте.
 *
 * Без него контракт каталога не проверить, а набор, который тихо продолжает
 * без него, отчитывается об успехе, ничего не проверив.
 */
export function assertDockerIsAvailable(): void {
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error(
      'Docker is not available, so the catalog contract cannot be tested. ' +
        'This is a failure and not a skip: a suite that reports success without ' +
        'executing is worse than no suite at all.',
    );
  }
}

/**
 * Поднять краулера и дождаться его готовности.
 *
 * Три исхода, и различать их важно: краулер ответил, краулер не ответил, но
 * контейнер жив, и контейнер даже не запустился. Разница между ними —
 * разница между «подождать ещё» и «смотреть в другом месте».
 */
export async function startCrawler(image: string): Promise<CrawlerRun> {
  try {
    // Краулер достаёт базу по этой сети, по алиасу ниже.
    // Витрина строку подключения не видит: база — краулера, и его учётные
    // данные — дело краулера.
    const network = await new Network().start();
    globalThis.__catalogNetworkStarted = network;

    const postgres = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('product_catalog_contract')
      .withUsername('catalog')
      .withPassword('catalog')
      .withNetwork(network)
      .withNetworkAliases('postgres')
      .start();
    globalThis.__catalogPostgresStarted = postgres;

    // Краулер читает базу по сети, по алиасу выше.
    const crawler = await new GenericContainer(image)
      .withNetwork(network)
      .withNetworkAliases('crawler')
      .withExposedPorts(CRAWLER_PORT)
      .withEnvironment({
        DB_HOST: 'postgres',
        DB_PORT: '5432',
        DB_NAME: 'product_catalog_contract',
        DB_USER: 'catalog',
        DB_PASSWORD: 'catalog',
        // Краулер накатывает миграции и сеет сам. Витрина больше не
        // применяет никакого своего SQL — в этом весь смысл изменения.
        SPRING_FLYWAY_ENABLED: 'true',
        // Ключ административного API. Краулер не стартует без него ни в одном
        // профиле, кроме `once`, — это отдельный секрет от каталогового, и
        // каталог его не принимает.
        ADMIN_API_KEY: ADMIN_API_KEY,
        // Демонстрационный профиль и демонстрационный сид.
        //
        // Сид и есть то, что наполняет базу: краулер несёт собственные
        // синтетические данные рядом со схемой, на которую они нацелены, и
        // именно он доказывает, что роль каталога существует и читает. Сид
        // защищён пятью барьерами — флагом, профилем, точной ролью, под
        // которой разрешается подключение сида, меткой в базе и пустотой
        // таблиц, — и свежая пустая тестовая база удовлетворяет всем пяти.
        SPRING_PROFILES_ACTIVE: 'demo',
        CATALOG_DEMO_SEED_ENABLED: 'true',
        CATALOG_DEMO_DB_USER: DEMO_SEED_ROLE,
        CATALOG_DEMO_DB_PASSWORD: DEMO_SEED_PASSWORD,
        CATALOG_DEMO_EXPECTED_ROLE: DEMO_SEED_ROLE,
        CATALOG_DEMO_DB_ID: 'product-catalog-contract',
        // Собственный пул каталога: та же база, другая роль. Эту роль
        // краулер заводит сам в рамках демонстрационной подготовки.
        CATALOG_DB_USER: 'wb_catalog_ro',
        CATALOG_DB_PASSWORD: CATALOG_ROLE_PASSWORD,
        // Никакого обхода во время теста: набор про каталоговый API, а
        // краулер, бродящий по Wildberries, двигал бы данные под
        // утверждениями.
        CRAWLER_WORKER_ENABLED: 'false',
        CATALOG_API_KEY: API_KEY,
        ...extraCrawlerEnvironment(),
      })
      .withWaitStrategy(NO_PORT_WAIT)
      .start();
    globalThis.__catalogCrawlerStarted = crawler;

    const startup = await waitForCrawler(crawler);

    if (startup.error !== null) {
      return {
        outcome: 'not-ready',
        apiUrl: startup.apiUrl,
        apiKey: API_KEY,
        containerId: crawler.getId(),
        postgresUri: postgres.getConnectionUri(),
        error: startup.error,
      };
    }

    return {
      outcome: 'ready',
      apiUrl: startup.apiUrl,
      apiKey: API_KEY,
      containerId: crawler.getId(),
      postgresUri: postgres.getConnectionUri(),
      error: null,
    };
  } catch (err) {
    // Контейнер так и не запустился, поэтому о краулере пока ничего не
    // известно: рантайм отказался его запускать, и диагноз — это его
    // собственные слова — отсутствующий образ, не отвечающий демон и
    // сеть, которую не удалось выделить, приходят сюда все, и ни одно из
    // них не говорит о том, что образ неверный.
    //
    // Контейнер, который запустился и упал, сюда НЕ попадает: этот случай
    // разбирается внутри ожидания, по собственному логу краулера.
    const detail = err instanceof Error ? err.message : String(err);
    return {
      outcome: 'not-started',
      apiUrl: null,
      apiKey: null,
      containerId: null,
      postgresUri: null,
      error:
        `the crawler container for "${image}" could not be started: ${detail}. ` +
        'The container never ran, so this is what the runtime said, not what the ' +
        'crawler said — read the runtime\'s answer before blaming the image.',
    };
  }
}

/** Остановить контейнеры прогона. */
export async function stopCrawler(): Promise<void> {
  const crawler = globalThis.__catalogCrawlerStarted;
  globalThis.__catalogCrawlerStarted = undefined;
  if (crawler) await crawler.stop();

  const postgres = globalThis.__catalogPostgresStarted;
  globalThis.__catalogPostgresStarted = undefined;
  if (postgres) await postgres.stop();

  const network = globalThis.__catalogNetworkStarted;
  globalThis.__catalogNetworkStarted = undefined;
  if (network) await network.stop();
}
