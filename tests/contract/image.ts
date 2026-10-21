/**
 * Образ краулера: какой образ тестируется, как он проверяется и откуда
 * берётся.
 *
 * ## Зачем это отдельный файл
 *
 * Образ — это отдельное решение: он выбирается, проверяется и, бывает,
 * скачивается. Жизненный цикл прогона про него знает только одно — какой
 * образ взят и оказался ли он на этой машине. Всё остальное — здесь.
 *
 * ## Образ — это отдельный артефакт
 *
 * Образ краулера собирает другой репозиторий. Когда его нет, падает
 * *контрактный* тест — с сообщением, в котором сказано, какого образа не
 * хватает и как его получить, — а остальной набор всё равно идёт. Это не
 * пропуск: файл падает громко, и код возврата это говорит. Юнит-тесты,
 * архитектурный гейт и проверка типов краулера не требуют, и прятать их за
 * отсутствующим артефактом значило бы затруднить различение «контракт не
 * держится» и «окружение не готово».
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './environment';

/**
 * Образ, на который закреплён прогон.
 *
 * `CONTRACT_CRAWLER_IMAGE` побеждает, чтобы рецензент мог указать набору на
 * только что собранный образ, не правя файл; иначе берётся закрепление в
 * `contract/crawler-image.txt`. Закрепление — это *ссылка*, и контрактный
 * тест проверяет, что контейнер действительно запустил образ этой ссылки: —
 * тест, который молча отработал против какого-то другого локального тега, не
 * доказывает ничего.
 */
export function resolveCrawlerImage(): string {
  const fromEnv = (process.env.CONTRACT_CRAWLER_IMAGE ?? '').trim();
  if (fromEnv) return fromEnv;

  const fromFile = readFileSync(resolve(ROOT, 'contract', 'crawler-image.txt'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('#'));

  if (!fromFile) {
    throw new Error(
      'contract/crawler-image.txt names no image. Put the crawler image reference there, ' +
        'or set CONTRACT_CRAWLER_IMAGE.',
    );
  }
  return fromFile;
}

/** Идентификатор, в который разрешается ссылка на образ, или null. */
export function imageIdOf(reference: string): string | null {
  try {
    return execFileSync('docker', ['image', 'inspect', reference, '--format', '{{.Id}}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Скачать образ, если закрепление называет дайджест и его нет на этой машине.
 *
 * Закрепление с дайджестом называет образ в реестре, а образ из реестра не
 * лежит ни на чьей машине, пока его не скачали. Без этого набор падал бы с
 * «образ недоступен локально» на вполне корректном закреплении — и падение
 * выглядело бы как сломанное закрепление вместо недокачанного файла.
 *
 * Закрепление с локальным тегом не скачивается: его неоткуда качать, и тег
 * собирает сам разработчик через `just app::docker-build`.
 *
 * Скачивание идёт через тот скрипт, которым пользуется CI, чтобы обе
 * стороны падали одинаково: анонимное скачивание, упёршееся в лимит
 * реестра, говорит об этом само и называет секрет, который лимит снимает.
 * Объяснение возвращается вызывающему, который переносит его в сообщение о
 * неудаче.
 */
export function ensureImageIsPresent(reference: string): string | null {
  if (!reference.includes('@sha256:')) return null;
  if (imageIdOf(reference) !== null) return null;

  console.log(`\n  pulling ${reference}…\n`);
  const pull = pullCrawlerImage(reference);
  if (pull.status === 0) return null;
  return pull.output.length > 0 ? pull.output : null;
}

/**
 * Скачивание — так, как его делает CI.
 *
 * Собственные слова скрипта сохраняются: это тот, кто знает про лимит
 * реестра для анонимных клиентов и про секрет, который его снимает.
 */
function pullCrawlerImage(reference: string): { status: number; output: string } {
  try {
    const output = execFileSync(
      'bash',
      [resolve(ROOT, 'scripts', 'pull-crawler-image.sh'), reference],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return { status: 0, output: output.trim() };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim(),
    };
  }
}
