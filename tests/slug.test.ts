import { describe, expect, it } from 'vitest';
import { slugify, targetSlug, resolveTarget } from '@/lib/slug';

describe('slugify', () => {
  it('transliterates Cyrillic', () => {
    expect(slugify('Ноутбуки')).toBe('noutbuki');
    expect(slugify('Кофеварки')).toBe('kofevarki');
    expect(slugify('Зимняя резина')).toBe('zimnyaya-rezina');
  });

  it('handles the letters that transliterate to nothing', () => {
    // ъ and ь are dropped rather than transliterated; leaving them would produce
    // double dashes.
    expect(slugify('Пылесос ъ')).toBe('pylesos');
  });

  it('collapses punctuation and trims separators', () => {
    expect(slugify('  Дом и сад!  ')).toBe('dom-i-sad');
    expect(slugify('Кофеварки / чайники')).toBe('kofevarki-chayniki');
    expect(slugify('---Мода---')).toBe('moda');
  });

  it('keeps digits', () => {
    expect(slugify('Ноутбуки 15.6"')).toBe('noutbuki-15-6');
  });

  it('returns an empty string when nothing survives', () => {
    expect(slugify('☃☃☃')).toBe('');
    expect(slugify('ъ ь')).toBe('');
  });

  it('caps length and never ends on a dash', () => {
    const long = slugify('а'.repeat(200));
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith('-')).toBe(false);
  });
});

describe('targetSlug', () => {
  it('uses the name when it transliterates', () => {
    expect(targetSlug('Кроссовки', '0135288f-0000-4000-a000-010000000000')).toBe('krossovki');
  });

  it('falls back to an id-derived slug so the URL is never empty', () => {
    // A category named only in symbols would otherwise produce /category/ and
    // silently become the home page.
    expect(targetSlug('☃', '0135288f-0000-4000-a000-010000000000')).toBe(
      'target-0135288f'
    );
  });

  it('is stable for the same input', () => {
    const a = targetSlug('Дом и сад', 'aaaa-1111');
    const b = targetSlug('Дом и сад', 'bbbb-2222');
    expect(a).toBe(b);
  });
});

describe('resolveTarget', () => {
  const targets = [
    { id: 'id-00000001', name: 'Ноутбуки' },
    { id: 'id-00000002', name: 'Кроссовки' },
    { id: 'id-00000003', name: 'Кофеварки' },
  ];

  it('finds a target by its slug', () => {
    expect(resolveTarget(targets, 'noutbuki')?.id).toBe('id-00000001');
    expect(resolveTarget(targets, 'krossovki')?.id).toBe('id-00000002');
  });

  it('is case-insensitive', () => {
    expect(resolveTarget(targets, 'Kofevarki')?.id).toBe('id-00000003');
  });

  it('returns null for an unknown slug', () => {
    expect(resolveTarget(targets, 'net-takogo')).toBeNull();
  });

  it('refuses to guess when two targets produce the same slug', () => {
    // "Кроссовки" and "Кроссовки " both slugify to `krossovki`. Rendering the
    // wrong category is worse than a 404, so this is a miss, not a coin flip.
    const ambiguous = [
      { id: 'id-00000001', name: 'Кроссовки' },
      { id: 'id-00000002', name: 'Кроссовки ' },
    ];
    expect(resolveTarget(ambiguous, 'krossovki')).toBeNull();
  });

  it('returns null for an empty catalogue', () => {
    expect(resolveTarget([], 'noutbuki')).toBeNull();
  });
});