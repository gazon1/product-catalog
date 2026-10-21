/**
 * Схема: каждый живой ответ валиден по документу, который отдаёт образ.
 *
 * ## Что здесь под тестом
 *
 * Слои «поля» сверяют состав ответа с зеркалом сайта. Здесь ответ
 * проверяется **целиком** — по схеме документа, со всеми типами, форматами и
 * обязательностью, — тем валидатором, который построен из документа.
 *
 * ## Почему это отдельный слой
 *
 * Валидатор, который принимает всё, ничего не проверяет, и набор был бы
 * зелёным против сломанного ответа. Отдельный слой нужен ещё и потому, что
 * сам валидатор проверяется отдельно (`tests/contract-validator.test.ts`):
 * там — атака на валидатор ответами, которые он обязан отвергнуть, здесь —
 * живые ответы, которые он обязан принять.
 */

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { apiGetText } from '@/lib/api/client';
import { getProduct, getSiteStats, listItems, listTargets } from '@/lib/queries';
import { buildValidator } from './document';
import { useContractEnvironment } from './harness';

useContractEnvironment();

describe('живые ответы против схемы документа', () => {
  it('каждый ответ валиден по схеме, которую объявляет документ', async () => {
    const document = parse(await apiGetText('/contract'));

    const card = buildValidator(document, 'ProductCard');
    const paged = buildValidator(document, 'PagedProductCard');
    const detail = buildValidator(document, 'ProductDetail');
    const target = buildValidator(document, 'TargetSummary');
    const stats = buildValidator(document, 'SiteStats');

    const page = await listItems({ paging: { page: 0, pageSize: 10 } });
    expect(paged(page), JSON.stringify(paged.errors)).toBe(true);
    for (const item of page.items) {
      expect(card(item), JSON.stringify(card.errors)).toBe(true);
    }

    const product = await getProduct(page.items[0]!.id);
    expect(product).not.toBeNull();
    expect(detail(product), JSON.stringify(detail.errors)).toBe(true);

    const targets = await listTargets();
    for (const summary of targets) {
      expect(target(summary), JSON.stringify(target.errors)).toBe(true);
    }

    const counters = await getSiteStats();
    expect(stats(counters), JSON.stringify(stats.errors)).toBe(true);
  });
});
