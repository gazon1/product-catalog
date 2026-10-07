import { describe, expect, it } from 'vitest';
import { plural, describe as describeError } from '@/lib/format';

describe('plural', () => {
  it('selects the one-form for numbers ending in 1', () => {
    expect(plural(1, 'товар', 'товара', 'товаров')).toBe('товар');
    expect(plural(21, 'товар', 'товара', 'товаров')).toBe('товар');
    expect(plural(101, 'товар', 'товара', 'товаров')).toBe('товар');
  });

  it('selects the few-form for 2–4', () => {
    expect(plural(2, 'товар', 'товара', 'товаров')).toBe('товара');
    expect(plural(3, 'товар', 'товара', 'товаров')).toBe('товара');
    expect(plural(24, 'товар', 'товара', 'товаров')).toBe('товара');
  });

  it('selects the many-form for 0, 5–9', () => {
    expect(plural(0, 'товар', 'товара', 'товаров')).toBe('товаров');
    expect(plural(5, 'товар', 'товара', 'товаров')).toBe('товаров');
    expect(plural(100, 'товар', 'товара', 'товаров')).toBe('товаров');
  });

  it('applies the 11–14 exception before the last-digit rule', () => {
    // 11, 12, 13, 14 end in 1–4 but are plural — this is the case a naive
    // last-digit check gets wrong, and it shows up on every catalog page.
    expect(plural(11, 'товар', 'товара', 'товаров')).toBe('товаров');
    expect(plural(12, 'товар', 'товара', 'товаров')).toBe('товаров');
    expect(plural(13, 'товар', 'товара', 'товаров')).toBe('товаров');
    expect(plural(14, 'товар', 'товара', 'товаров')).toBe('товаров');
    expect(plural(111, 'товар', 'товара', 'товаров')).toBe('товаров');
  });

  it('handles negative numbers by magnitude', () => {
    expect(plural(-1, 'товар', 'товара', 'товаров')).toBe('товар');
  });
});

describe('describe', () => {
  it('names a missing DATABASE_URL', () => {
    expect(describeError(new Error('DATABASE_URL is not set'))).toMatch(/DATABASE_URL/);
  });

  it('reports an unreachable database as such', () => {
    expect(describeError(new Error('connect ECONNREFUSED 127.0.0.1:5432'))).toMatch(
      /недоступна/
    );
    expect(describeError(new Error('timeout exceeded'))).toMatch(/недоступна/);
  });

  it('reports a rejected credential', () => {
    expect(
      describeError(new Error('password authentication failed for user "catalog"'))
    ).toMatch(/отклонила/);
  });

  it('does not leak driver detail into the page', () => {
    // The message goes to the visitor; the raw error stays in the server log.
    // A stack trace or connection string must never reach this string.
    const message = describeError(new Error('FATAL: some very internal detail'));
    expect(message).not.toContain('FATAL');
    expect(message).toBe('Подробности — в логах сервера.');
  });

  it('copes with a non-Error throw', () => {
    expect(describeError('plain string failure')).toBe('Подробности — в логах сервера.');
  });
});