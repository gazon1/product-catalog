/**
 * Поля ответа: те, что объявляет контракт, и те, что приходят на самом деле.
 *
 * ## Что здесь под тестом
 *
 * Ответ — это не «объект с данными», а конкретные поля: у карточки есть
 * ровно тот набор, который объявляет контракт, и каждое поле приходит того
 * типа, который объявлен. Переименованное поле, поле не того типа и
 * пропавший `null` — всё это ловится здесь, а не в вёрстке страницы.
 *
 * ## Два источника одного вопроса
 *
 * Набор полей карточки известен сайту из сгенерированных типов, а контракт
 * объявляет свой набор сам. Сверяются оба: сайт проверяет ответ по своему
 * зеркалу (слой «поля»), и по документу, который отдаёт живой образ (слой
 * «контракт»). Расхождение между ними — это расхождение контракта с
 * витриной, и оно должно быть видно.
 *
 * ## Про null
 *
 * Поле, которому контракт разрешает быть `null`, обязано хоть где-нибудь быть
 * `null`: иначе «разрешено» — это только слова в документе, а на деле поле
 * всегда заполнено, и проверка nullability ничего не проверяет.
 */

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { apiGetText } from '@/lib/api/client';
import { PRODUCT_CARD_FIELDS } from '@/lib/api/types';
import { getProduct, listItems, listTargets } from '@/lib/queries';
import { contractFields } from './document';
import { useContractEnvironment } from './harness';

useContractEnvironment();

describe('карточка', () => {
  it('отвечает ровно теми полями, которые объявляет контракт', async () => {
    const page = await listItems({ paging: { page: 0, pageSize: 10 } });
    expect(page.items.length).toBeGreaterThan(0);

    for (const item of page.items) {
      const names = Object.keys(item).sort();
      expect(names).toEqual([...PRODUCT_CARD_FIELDS.map((f) => f.name)].sort());
    }
  });

  it('отвечает теми типами, которые объявляет контракт', async () => {
    const page = await listItems({ paging: { page: 0, pageSize: 25 } });

    for (const item of page.items) {
      for (const field of PRODUCT_CARD_FIELDS) {
        const value = (item as unknown as Record<string, unknown>)[field.name];
        if (value === null) {
          expect(field.nullable, `${field.name} is null but the contract does not allow it`).toBe(
            true,
          );
          continue;
        }
        if (field.type === 'string') expect(typeof value, field.name).toBe('string');
        if (field.type === 'boolean') expect(typeof value, field.name).toBe('boolean');
        if (field.type === 'number') expect(typeof value, field.name).toBe('number');
        if (field.type === 'integer') {
          expect(typeof value, field.name).toBe('number');
          expect(Number.isInteger(value), `${field.name} is not a whole number`).toBe(true);
        }
      }
    }
  });

  it('никогда не отвечает пустым заголовком', async () => {
    // Карточка без заголовка не рисуется ссылкой.
    const page = await listItems({ paging: { page: 0, pageSize: 30 } });
    for (const item of page.items) {
      expect(item.title.trim().length).toBeGreaterThan(0);
      expect(item.productUrl).toMatch(/^https?:\/\//);
      expect(item.scrapedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('держит цены в целых копейках', async () => {
    const page = await listItems({ paging: { page: 0, pageSize: 30 } });
    for (const item of page.items) {
      if (item.priceKopecks !== null) expect(Number.isInteger(item.priceKopecks)).toBe(true);
      if (item.salePriceKopecks !== null) expect(Number.isInteger(item.salePriceKopecks)).toBe(true);
    }
  });
});

describe('поля по документу, который отдаёт образ', () => {
  it('карточка несёт те поля, которые объявляет документ', async () => {
    // Контракт, который важен здесь, — тот, что отдаёт **работающий образ**:
    // ответы приходят из него, значит и схема, по которой они проверяются,
    // должна прийти из того же места.
    const document = parse(await apiGetText('/contract')) as {
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
    };
    const declared = contractFields(document.components.schemas.ProductCard);

    const page = await listItems({ paging: { page: 0, pageSize: 10 } });
    const card = page.items[0]!;
    for (const field of declared) {
      expect(card, `the answer carries no "${field.name}"`).toHaveProperty(field.name);
    }
  });

  it('деталь несёт те поля, которые объявляет документ', async () => {
    // Деталь — это карточка плюс то, что деталь добавляет, а добавляет она
    // ровно то, что написано в документе, а не список, выписанный здесь:
    // список, выписанный здесь, устаревает в тот же миг, когда контракт
    // растёт, и сайт продолжает отвечать без того, о чём его просили.
    const document = parse(await apiGetText('/contract')) as {
      components: {
        schemas: Record<
          string,
          { allOf?: Array<{ $ref?: string; properties?: Record<string, unknown> }> }
        >;
      };
    };
    const allOf = document.components.schemas.ProductDetail?.allOf ?? [];
    const own = allOf.flatMap((part) => Object.keys(part.properties ?? {}));
    expect(own).toContain('history');

    const page = await listItems({ paging: { page: 0, pageSize: 10 } });
    const product = await getProduct(page.items[0]!.id);
    expect(product).not.toBeNull();
    for (const name of own) {
      expect(product, `the answer carries no "${name}"`).toHaveProperty(name);
    }
  });
});

describe('поля, которым контракт разрешает быть null', () => {
  it('действительно приходят пустыми', async () => {
    const targets = await listTargets();
    const seenNull = new Set<string>();

    const nullable = PRODUCT_CARD_FIELDS.filter((field) => field.nullable).map((field) => field.name);
    for (const target of targets) {
      for (let page = 0; page < 5; page += 1) {
        const chunk = await listItems({ targetId: target.id, paging: { page, pageSize: 60 } });
        for (const item of chunk.items) {
          for (const field of nullable) {
            if ((item as unknown as Record<string, unknown>)[field] === null) seenNull.add(field);
          }
        }
        if (chunk.items.length < 60) break;
      }
    }

    for (const field of nullable) {
      expect(
        seenNull.has(field),
        `the contract allows "${field}" to be null, but no answer in the catalog ever returned one`,
      ).toBe(true);
    }
  });
});
