/**
 * Окружение прогона: константы, передача значений рабочим процессам и
 * переменные, которые получает контейнер краулера.
 *
 * ## Зачем это отдельный файл
 *
 * Здесь собрано всё, что отвечает на вопрос «какой идёт прогон»: порт и
 * ключи, роли и пароли сида, бюджет готовности, значения, которыми главный
 * процесс делится с рабочими, и то, что подмешивается в окружение
 * контейнера.
 *
 * Константы живут здесь, а не в файлах, которые их читают, по одной причине:
 * ключ, которым краулер запущен, и ключ, которым витрина читает каталог, —
 * это одно и то же значение. Если бы каждое решение держало своё, они
 * разошлись бы тихо, а контрактный тест падал бы с «401», не объясняя
 * почему.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Корень репозитория. */
export const ROOT = resolve(import.meta.dirname, '..', '..');

/** Порт, на котором краулер отдаёт каталоговый API. */
export const CRAWLER_PORT = 8080;

/** Ключ, которым краулер запущен и которым витрина читает каталог. */
export const API_KEY = 'contract-test-key';

/**
 * Ключ административного API.
 *
 * Другой секрет, нежели у каталога, — намеренно: краулер не стартует без
 * него, а каталог его не принимает. Тест, который взял бы одно значение на
 * оба случая, не заметил бы разницы — а разница и есть весь смысл в том,
 * чтобы их было два.
 */
export const ADMIN_API_KEY = 'contract-test-admin-key';

/** Роль, под которой подключается демонстрационный сид. */
export const DEMO_SEED_ROLE = 'wb_demo_seed';

/** Пароль роли демонстрационного сида. */
export const DEMO_SEED_PASSWORD = 'contract-demo-seed-password';

/** Пароль роли только для чтения, которой читает каталог. */
export const CATALOG_ROLE_PASSWORD = 'contract-catalog-role-password';

/** Сколько краулеру дано на миграции, сид и ответ. */
export const READY_TIMEOUT_MS = 120_000;

/** Что рабочим процессам известно о запущенном краулере. */
export interface ContractEnvironment {
  /** Базовый адрес каталогового API, с префиксом. */
  apiUrl: string | null;
  /** Ключ, который отправляется как `X-Api-Key`. */
  apiKey: string | null;
  /** Ссылка на образ, на который закреплён прогон. */
  image: string | null;
  /** Идентификатор, в который эта ссылка разрешается. */
  imageId: string | null;
  /** Идентификатор контейнера, который на самом деле запустился. */
  containerId: string | null;
  /** Строка подключения к собственной базе краулера — на память. */
  postgresUri: string | null;
  /** Почему краулера нет, когда его нет. */
  error: string | null;
}

/**
 * Каталог передачи и сам файл в нём.
 *
 * Каталог создаётся в момент запуска, а не в момент загрузки модуля: тестовый
 * файл может импортировать этот модуль ради его помощников, и рабочий
 * процесс, создавший свой собственный временный каталог, оставил бы его за
 * собой.
 */
let connectionDir: string | null = null;
let connectionFile: string | null = null;

/** Создать каталог передачи и записать в него значения. */
export function writeHandoff(values: ContractEnvironment): void {
  connectionDir = mkdtempSync(join(tmpdir(), 'product-catalog-contract-'));
  connectionFile = join(connectionDir, 'contract.json');
  writeFileSync(connectionFile, JSON.stringify(values), 'utf8');
}

/** Убрать каталог передачи. */
export function removeHandoff(): void {
  if (connectionDir) {
    rmSync(connectionDir, { recursive: true, force: true });
    connectionDir = null;
    connectionFile = null;
  }
}

/**
 * Файл передачи — так, как его знает главный процесс.
 *
 * Рабочие процессы им не пользуются: они находят файл сами, перебирая
 * временный каталог. Причина в старом файле настройки и она всё ещё в силе:
 * прерванный прогон оставляет свой каталог за собой, а выбранный устаревший
 * файл означает обращение к контейнеру, который уже остановили.
 */
export function contractEnvironmentPath(): string | null {
  return connectionFile;
}

/**
 * Дополнительное окружение контейнера краулера.
 *
 * `CONTRACT_CRAWLER_ENV` — объект JSON из пар `NAME=value`, подмешиваемый
 * поверх значений по умолчанию. Он нужен потому, что переключатель сида у
 * краулера такой, какой краулер сам решил: витрине не приходится правиться
 * из-за чужого имени, и в контрактном тесте не должно жить догадка о
 * настройке другого репозитория.
 */
export function extraCrawlerEnvironment(): Record<string, string> {
  const raw = (process.env.CONTRACT_CRAWLER_ENV ?? '').trim();
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`CONTRACT_CRAWLER_ENV is not valid JSON: ${raw}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('CONTRACT_CRAWLER_ENV must be a JSON object of NAME=value pairs');
  }

  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    out[name] = String(value);
  }
  return out;
}
