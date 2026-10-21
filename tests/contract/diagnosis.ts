/**
 * Диагностика неудачи: что сказать о контейнере, который не стал готов.
 *
 * ## Зачем это отдельный файл
 *
 * У неудачи есть несколько причин, и различать их — одно решение: читатель
 * должен знать, куда смотреть. Контейнер упал, контейнер жив, но не успел, и
 * образ отвечает, но не отдаёт каталог, — три разные беды с тремя разными
 * ответами. Разнести их по разным файлам значило бы оторвать причину от её
 * объяснения, поэтому все причины живут здесь.
 *
 * Здесь же — то, чем их читают: состояние контейнера от рантайма, код
 * возврата и хвост собственного лога краулера.
 *
 * ## Собственный лог краулера — это диагноз
 *
 * Flyway называет упавшую миграцию, сид — роль, которую он не смог создать,
 * база — то, что она отказала. Сообщение, в котором написано только «контейнер
 * не запустился», выбрасывает всё это, а читателю остаётся гадать.
 *
 * ## Пока контейнер жив, это таймаут, а не неверный образ
 *
 * Контейнер, который ещё работает и просто медленный, нельзя назвать
 * неверным образом: сообщение, которое говорит обратное, отправляет читателя
 * не туда. Поэтому бюджет, который закончился, называется таймаутом, и
 * говорится, что контейнер получил его целиком и не ответил в нём.
 */

import type { Readable } from 'node:stream';
import { getContainerRuntimeClient, type StartedTestContainer } from 'testcontainers';
import { READY_TIMEOUT_MS } from './environment';

/** Что рантайм говорит о контейнере прямо сейчас. */
export interface ContainerState {
  running: boolean;
  status: string;
  exitCode: number | null;
  error: string | null;
}

/**
 * Состояние контейнера — так, как его сообщает рантайм.
 *
 * Через клиент testcontainers, а не через команду `docker`: набор уже
 * зависит от этого клиента, а второй способ спросить тот же демон — это
 * второй способ ошибиться.
 */
export async function inspectContainer(container: StartedTestContainer): Promise<ContainerState | null> {
  try {
    const client = await getContainerRuntimeClient();
    const inspected = await client.container.inspect(client.container.getById(container.getId()));
    return {
      running: inspected.State.Running,
      status: inspected.State.Status,
      exitCode: inspected.State.ExitCode,
      error: inspected.State.Error ? inspected.State.Error : null,
    };
  } catch {
    // Контейнер, который не осматривается, — контейнер, которого нет. Что
    // это значит для прогона, решает вызывающий, а не эта функция.
    return null;
  }
}

/**
 * Последние строки лога контейнера.
 *
 * Поток следует за контейнером, поэтому у работающего контейнера он не
 * кончается никогда; его читают секунду и обрывают. Диагностика, которая
 * висит, — это не диагностика.
 */
export async function readLogTail(container: StartedTestContainer, lines: number): Promise<string> {
  let stream: Readable | undefined;
  try {
    const logs = await container.logs({ tail: lines });
    stream = logs;
    const chunks: string[] = [];
    await new Promise<void>((resolvePromise) => {
      const finish = () => {
        clearTimeout(timer);
        resolvePromise();
      };
      const timer = setTimeout(finish, 1_000);
      logs.on('data', (chunk: Buffer | string) => {
        chunks.push(chunk.toString());
      });
      logs.on('end', finish);
      logs.on('error', finish);
    });
    return chunks.join('').trim();
  } catch {
    return '';
  } finally {
    stream?.destroy();
  }
}

/**
 * Что говорит о себе вышедший контейнер.
 *
 * Код возврата и лог — это весь диагноз: между ними они говорят, отказался ли
 * краулер стартовать, отказала ли база или не накатилась миграция, — а это
 * и есть вопрос читателя.
 */
export async function describeExit(container: StartedTestContainer, state: ContainerState): Promise<string> {
  const logs = await readLogTail(container, 40);
  const exit = state.exitCode === null ? 'an unknown exit code' : `exit code ${state.exitCode}`;
  return (
    `the crawler container exited before it became ready (status "${state.status}", ${exit}` +
    (state.error !== null ? `, ${state.error}` : '') +
    '). The crawler says why in its own log:' +
    (logs.length > 0 ? `\n${logs}` : '\n(the log is empty)')
  );
}

/**
 * Что сказать о контейнере, который жив, но не успел.
 *
 * Бюджет потрачен, и сказать, что это таймаут: контейнер, который всё ещё
 * работает и просто медленный, — это не неверный образ, и сообщение, которое
 * говорит обратное, отправляет читателя не туда.
 */
export async function describeTimeout(
  container: StartedTestContainer,
  lastProblem: string,
): Promise<string> {
  const state = await inspectContainer(container);
  const logs = await readLogTail(container, 40);
  return (
    `the crawler container is ${state !== null && state.running ? 'still running' : 'no longer running'} ` +
    `and did not become ready within ${READY_TIMEOUT_MS / 1000} s: ${lastProblem}. ` +
    'This is a timeout, not a wrong image: the container was given the whole budget and ' +
    'did not answer in it.' +
    (logs.length > 0 ? `\nIts last log lines:\n${logs}` : '')
  );
}

/**
 * Что сказать о контейнере, который отверг ключ теста.
 *
 * Это не неверный образ и не таймаут: краулер и витрина должны быть
 * запущены с одним и тем же ключом, и сказать об этом — половина диагноза.
 */
export function describeRejectedKey(): string {
  return (
    'the crawler rejected the test key (401). The crawler and the storefront must be ' +
    'started with the same key.'
  );
}

/**
 * Что сказать об образе, который не отдаёт каталог.
 *
 * Контейнер жив и отвечает — но не тем, что нужно. Значит, в образе нет
 * каталогового API, и собирать нужно другой образ.
 */
export function describeMissingCatalogApi(): string {
  return (
    'the image does not serve /api/catalog/v1/ready — the catalog API is not ' +
    'implemented in this image. Build an image that contains it.'
  );
}
