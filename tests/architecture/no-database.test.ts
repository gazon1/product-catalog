/**
 * Гейт «витрина не касается базы».
 *
 * ## Что здесь под тестом
 *
 * Одно правило: **у витрины нет доступа к базе данных**. Раньше витрина читала
 * PostgreSQL краулера напрямую, под ролью только для чтения, и с тремя уровнями
 * enforcement: роль, сессионная опция `default_transaction_read_only` и
 * проверка того, что в этом репозитории нет ни одного пишущего оператора.
 * Два из трёх жили в модуле, который с тех пор удалён, потому что у витрины
 * больше нет соединения, которое можно сделать только для чтения.
 *
 * Граница теперь одна, и она сильнее: **у витрины нет драйвера, нет строки
 * подключения и нет SQL.** Она читает каталог по HTTP API краулера. Сайт,
 * который не может открыть соединение, не может сломать схему краулера, не
 * может случайно в неё записать и не может продолжать «работать» со схемой,
 * которую переименовала миграция, — а это ровно тот класс отказов, ради
 * которого и существовали три старых уровня защиты.
 *
 * Осталось проверять *форму* этой границы: нет драйвера в дереве зависимостей,
 * нет строки подключения в окружении, нет имён таблиц и нет SQL в исходниках.
 *
 * ## Почему здесь же проверяется сам сканер
 *
 * Гейт, который ничего не находит, проходит. Сканер — часть гейта, и сканер,
 * который однажды перестанет вырезать комментарии, уведёт гейт с собой
 * молча: настоящие файлы он по-прежнему пропустит. Поэтому сканер проверяется
 * на заготовках, которых в репозитории нет, — доказать это ничего не стоит и
 * невозможно случайно.
 */

import { describe, expect, it } from 'vitest';
import { blankPlainLiterals, read, relative, sourceFiles, stripComments } from './source-scan';

describe('the comment stripper this gate depends on', () => {
  // Без них `stripComments` мог бы тихо перестать работать и увести гейт на
  // запись с собой: пустой вырезатель всё равно пропускает настоящие файлы.
  it('removes a JSDoc block', () => {
    expect(stripComments('/** INSERT INTO t */\nconst a = 1;')).not.toContain('INSERT');
  });

  it('removes a trailing line comment', () => {
    expect(stripComments('const a = 1; // DELETE FROM t')).not.toContain('DELETE');
  });

  it('keeps code after a line comment marker on an earlier line', () => {
    const source = '// a note\nconst sql = `TRUNCATE t`;';
    expect(stripComments(source)).toContain('TRUNCATE');
  });

  it('does not mistake the // in a URL for a comment', () => {
    const source = "const u = 'https://wb.ru/x'; const sql = `DROP TABLE t`;";
    expect(stripComments(source)).toContain('DROP TABLE');
  });

  it('strips block comments but keeps a SQL keyword that shares the file with them', () => {
    const source = '/** why GRANT appears here */\nconst sql = `GRANT SELECT ON t TO r`;';
    const stripped = stripComments(source);
    expect(stripped).not.toContain('GRANT appears');
    expect(stripped).toContain('GRANT SELECT');
  });
});

describe('the storefront never touches a database', () => {
  /**
   * Токены соединения, искомые с литералами на месте.
   *
   * Строка подключения, импорт драйвера или пул — это соединение, как бы оно
   * ни было написано, и ни одно из этих слов не появляется в прозе случайно:
   * `postgres://` — схема URL, а `pg.Pool` — имя класса.
   */
  const CONNECTION_TOKENS = [
    /from ['"]pg['"]/,
    /require\(\s*['"]pg['"]\s*\)/,
    /\bpg\.Pool\b/,
    /postgres:\/\//,
    /postgresql:\/\//,
  ];

  /**
   * Имена схемы и названия переменных с доступом.
   *
   * Это слова, которые *предложение* вправе содержать — подсказка посетителю о
   * том, в какую таблицу смотреть, сообщение об ошибке, называющее незаданную
   * переменную. Это словарь краулера, и сайт вправе о нём говорить. Запрещено
   * не то, что сайт о нём *говорит*, а то, что сайт его *использует*, и именно
   * это показывает источник с погашенными литералами.
   */
  const SCHEMA_TOKENS = [
    /\bDATABASE_URL\b/,
    /\bscraped_items\b/,
    /\bcrawl_targets\b/,
    /\bpg\b/,
  ];

  /**
   * Пишущие операторы.
   *
   * Проверка регистрозависимая, и это намеренно. SQL в этом репозитории
   * написан прописными буквами, а единственное строчное слово, на котором
   * сработала бы проверка, — `truncate`, утилита Tailwind, которую использует
   * каждая карточка этого сайта. Гейт, который срабатывает на CSS-классе, —
   * гейт, который люди учатся выключать.
   */
  const WRITE_STATEMENTS =
    /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+(TABLE|INDEX|SCHEMA)|ALTER\s+TABLE|CREATE\s+(TABLE|INDEX|UNIQUE|SCHEMA)|TRUNCATE|GRANT|REVOKE|COPY)\b/;

  it('finds the source files to scan', () => {
    // Гейт, который не сканирует ничего, проходит. Это утверждение о том, что
    // сам скан не пуст.
    expect(sourceFiles().length).toBeGreaterThan(10);
  });

  it('contains no database connection', () => {
    const violations: string[] = [];
    for (const file of sourceFiles()) {
      const source = stripComments(read(file));
      for (const token of CONNECTION_TOKENS) {
        const match = source.match(token);
        if (match) violations.push(`${relative(file)}: "${match[0]}"`);
      }
    }

    expect(
      violations,
      violations.join('\n') +
        '\n\nThe storefront reads the catalog over the crawler\'s HTTP API. It has no ' +
        'credentials, no driver and no connection string, and a site that cannot open a ' +
        'connection cannot break the crawler\'s schema.',
    ).toEqual([]);
  });

  it('uses no schema name in code', () => {
    const violations: string[] = [];
    for (const file of sourceFiles()) {
      const source = blankPlainLiterals(stripComments(read(file)));
      for (const token of SCHEMA_TOKENS) {
        const match = source.match(token);
        if (match) violations.push(`${relative(file)}: "${match[0]}"`);
      }
    }

    expect(
      violations,
      violations.join('\n') +
        '\n\nThe crawler owns the schema; the storefront owns the vocabulary of its own ' +
        'API, and those are two different things. A table name in a sentence a visitor ' +
        'reads is fine — a table name in code is not.',
    ).toEqual([]);
  });

  it('contains no write statement', () => {
    const violations: string[] = [];
    for (const file of sourceFiles()) {
      const source = blankPlainLiterals(stripComments(read(file)));
      const match = source.match(WRITE_STATEMENTS);
      if (match) violations.push(`${relative(file)}: "${match[0]}"`);
    }

    expect(
      violations,
      violations.join('\n') +
        '\n\nThe storefront does not write to the catalog — it cannot, and it must not.',
    ).toEqual([]);
  });

  // Обратная сторона проверок выше: гейты должны остаться вооружёнными.
  // Проверено на заготовках, которые не касаются настоящего дерева исходников,
  // поэтому доказательство ничего не стоит и не может само по себе сойтись.
  it('still fires on a write that is not in a comment', () => {
    const planted = 'const sql = `UPDATE scraped_items SET title = $1 WHERE id = $2`;';
    expect(blankPlainLiterals(stripComments(planted))).toMatch(WRITE_STATEMENTS);
  });

  it('does not fire on a write keyword that only appears in a comment', () => {
    const planted = '/** never INSERT INTO scraped_items here */\nconst sql = `SELECT 1`;';
    expect(blankPlainLiterals(stripComments(planted))).not.toMatch(WRITE_STATEMENTS);
  });

  it('fires on a schema name used in code', () => {
    const planted = 'const sql = `SELECT * FROM scraped_items`;';
    expect(blankPlainLiterals(stripComments(planted))).toMatch(/\bscraped_items\b/);
  });

  it('does not fire on a schema name mentioned in a sentence', () => {
    // Собственная подсказка сайта называет таблицу краулера, и это разрешено:
    // это проза для посетителя, а не запрос к базе.
    const planted = 'const hint = "В базе краулера нет ни одной записи в crawl_targets.";';
    expect(blankPlainLiterals(stripComments(planted))).not.toMatch(/\bcrawl_targets\b/);
  });

  it('does not fire on a Tailwind class that is called truncate', () => {
    const planted = 'const className = "truncate text-xs text-slate-500";';
    expect(blankPlainLiterals(stripComments(planted))).not.toMatch(WRITE_STATEMENTS);
  });
});
