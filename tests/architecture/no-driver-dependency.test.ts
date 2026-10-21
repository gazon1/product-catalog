/**
 * Гейт «в дереве зависимостей нет драйвера базы».
 *
 * ## Что здесь под тестом
 *
 * Одно правило: **драйвера базы нет в дереве зависимостей вообще** — не «не
 * используется», а именно «нет». Драйвер в дереве — это драйвер, который
 * можно импортировать в следующий плохой день, а весь смысл границы в том, что
 * этот сайт не может открыть соединение.
 *
 * Проверка живёт здесь, а не в гейте про исходники, потому что это другое
 * правило: одно проверяет код, другое — то, что вообще можно импортировать.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', '..', 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

describe('the dependency tree has no database driver', () => {
  it('does not depend on a PostgreSQL driver', () => {
    // Не «не использует его» — не *имеет* его. Драйвер в дереве — это драйвер,
    // который можно импортировать в следующий плохой день, а весь смысл границы
    // в том, что этот сайт не может открыть соединение.
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain('pg');
  });

  it('does not depend on the driver’s types either', () => {
    expect(Object.keys(pkg.devDependencies ?? {})).not.toContain('@types/pg');
  });
});
