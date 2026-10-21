/**
 * Моменты, которые страница показывает посетителю.
 *
 * ## Что здесь под тестом
 *
 * Одно решение: **как страница говорит о свежести данных**. Два момента
 * (`dataAsOf` и `asOf`), две подписи, местное время сервера и прочерк вместо
 * момента, которого нет.
 *
 * ## Почему это стоит проверять отдельно
 *
 * Ошибка здесь не роняет страницу: она тихо показывает «—» там, где должна
 * была показать дату, — или, что хуже, подписывает момент счётчиков как «данные
 * на …» и тем самым обещает посетителю свежесть, которой нет. Заметить это
 * можно только по тесту.
 */

import { describe, expect, it } from 'vitest';
import {
  COUNTERS_AS_OF_LABEL,
  DATA_AS_OF_LABEL,
  NO_MOMENT,
  countersAsOfMoment,
  dataAsOfMoment,
  formatMoment,
  momentDateTime,
  parseMoment,
} from '@/lib/freshness';

/** Момент, который краулер присылает в UTC. */
const MOMENT_UTC = '2026-10-21T08:52:00Z';

describe('the moment as the page reads it', () => {
  it('prints the date and the hour', () => {
    expect(formatMoment(MOMENT_UTC, 'UTC')).toBe('21.10.2026, 08:52');
  });

  it('moves the moment into the zone of the reader', () => {
    // Момент приходит в UTC, а читает его человек: в московской зоне тот же
    // момент — это 11:52.
    expect(formatMoment(MOMENT_UTC, 'Europe/Moscow')).toBe('21.10.2026, 11:52');
  });

  it('prints in the zone of the server when no zone is given', () => {
    // Витрина рендерится на сервере, поэтому «местное время пользователя» —
    // это часовой пояс сервера, и он не должен быть зашит в код.
    const serverZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    expect(formatMoment(MOMENT_UTC)).toBe(formatMoment(MOMENT_UTC, serverZone));
  });

  it('prints a dash when there is no moment at all', () => {
    // Краулер старше контракта не присылает момент, и пустой каталог отдаёт
    // `null`. Это отсутствие момента, а не «сейчас».
    expect(formatMoment(null)).toBe(NO_MOMENT);
    expect(formatMoment(undefined)).toBe(NO_MOMENT);
    expect(formatMoment('')).toBe(NO_MOMENT);
    expect(formatMoment('   ')).toBe(NO_MOMENT);
  });

  it('prints a dash when the moment is not a moment', () => {
    expect(formatMoment('вчера вечером')).toBe(NO_MOMENT);
    expect(formatMoment('2026-13-45')).toBe(NO_MOMENT);
  });
});

describe('the value the machine reads', () => {
  it('gives the moment in ISO, in UTC', () => {
    // Текст рядом — местный, а атрибут `datetime` — однозначный.
    expect(momentDateTime(MOMENT_UTC)).toBe('2026-10-21T08:52:00.000Z');
  });

  it('gives nothing when there is no moment', () => {
    // `<time>` без `datetime` не значит ничего, а выдуманное значение значит
    // больше, чем ничего.
    expect(momentDateTime(null)).toBeNull();
    expect(momentDateTime('')).toBeNull();
    expect(momentDateTime('вчера')).toBeNull();
  });
});

describe('the moment as it is parsed', () => {
  it('accepts a moment the crawler sent', () => {
    expect(parseMoment(MOMENT_UTC)?.toISOString()).toBe('2026-10-21T08:52:00.000Z');
  });

  it('refuses everything that is not a moment', () => {
    // `new Date(null)` — это 1970 год, а `new Date('')` — Invalid Date, и оба
    // выглядели бы как настоящее время.
    expect(parseMoment(null)).toBeNull();
    expect(parseMoment(undefined)).toBeNull();
    expect(parseMoment('')).toBeNull();
    expect(parseMoment('   ')).toBeNull();
    expect(parseMoment('вчера')).toBeNull();
  });
});

describe('the two moments are named differently', () => {
  it('calls the data moment "данные на"', () => {
    expect(dataAsOfMoment(MOMENT_UTC).label).toBe('Данные на');
    expect(DATA_AS_OF_LABEL).toBe('Данные на');
  });

  it('calls the counters moment "счётчики посчитаны в"', () => {
    expect(countersAsOfMoment(MOMENT_UTC).label).toBe('Счётчики посчитаны в');
    expect(COUNTERS_AS_OF_LABEL).toBe('Счётчики посчитаны в');
  });

  it('never lets one label stand for the other', () => {
    // Момент счётчиков — это момент чтения кэша, а не свежесть данных.
    // Подписи не должны быть взаимозаменяемыми ни в одну сторону.
    expect(countersAsOfMoment(MOMENT_UTC).label).not.toContain(DATA_AS_OF_LABEL);
    expect(dataAsOfMoment(MOMENT_UTC).label).not.toContain(COUNTERS_AS_OF_LABEL);
  });

  it('carries the moment and the label together', () => {
    const moment = dataAsOfMoment(MOMENT_UTC);

    expect(moment.text).toBe(formatMoment(MOMENT_UTC));
    expect(moment.dateTime).toBe('2026-10-21T08:52:00.000Z');
  });

  it('carries a dash and no date when the moment is absent', () => {
    const moment = dataAsOfMoment(null);

    expect(moment.text).toBe(NO_MOMENT);
    expect(moment.dateTime).toBeNull();
    expect(moment.label).toBe(DATA_AS_OF_LABEL);
  });
});
