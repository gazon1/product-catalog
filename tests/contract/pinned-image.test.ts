/**
 * Образ, который тестируется, — тот самый, что назван пином.
 *
 * ## Зачем это отдельный слой
 *
 * Всё остальное в контрактной проверке спрашивает «правильно ли отвечает
 * краулер». Этот слой спрашивает «**тот ли** это краулер». Без него набор
 * мог быть зелёным против образа, который к пинну отношения не имеет, — и
 * доказательством совместимости служила бы пустая проверка.
 *
 * ## Как это проверяется
 *
 * Ссылка пина разрешается в идентификатор образа, и он сравнивается с тем,
 * из какого образа поднялся контейнер, который на самом деле отвечает. Два
 * независимых свидетельства: то, что закреплено, и то, что запущено.
 */

import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { contractEnvironment, useContractEnvironment } from './harness';

useContractEnvironment();

/** Идентификатор, в который разрешается закреплённая ссылка. */
function pinnedImageId(): string {
  const environment = contractEnvironment();
  return execFileSync('docker', ['image', 'inspect', environment.image!, '--format', '{{.Id}}'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Идентификатор образа, из которого поднялся работающий контейнер. */
function runningImageId(): string {
  const environment = contractEnvironment();
  return execFileSync('docker', ['inspect', environment.containerId!, '--format', '{{.Image}}'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

describe('образ, который тестируется, — закреплённый', () => {
  it('запущен тот образ, который называет пин', () => {
    // Без этой проверки весь набор мог быть зелёным против чужого образа.
    expect(runningImageId()).toBe(pinnedImageId());
  });

  it('запущен тот образ, который записал прогон', () => {
    // Второе свидетельство: прогон записывает, из чего он поднялся, и это
    // должно быть то же самое, что он на самом деле поднял.
    expect(runningImageId()).toBe(contractEnvironment().imageId);
  });
});
