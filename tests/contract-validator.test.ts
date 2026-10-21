/**
 * Валидатор, на который опирается контрактный тест.
 *
 * ## Зачем он проверяется отдельно
 *
 * `tests/api-contract.test.ts` проверяет настоящие ответы краулера по
 * настоящему контракту. Этот тест стоит ровно столько, сколько стоит валидатор
 * под ним: валидатор, который принимает всё, пропустил бы сломанный ответ, а
 * набор остался бы зелёным. Поэтому ниже — атака на сам валидатор, ответами,
 * которые он обязан отвергнуть.
 *
 * Если валидатор перестанет их отвергать, контрактный тест перестанет что-либо
 * доказывать, и он должен упасть здесь первым.
 *
 * ## Где живёт контракт
 *
 * Витрина намеренно не хранит копию документа: два описания одних и тех же форм —
 * это два источника истины, и тот, который никто не читает, — это тот, который
 * тихо разрешает следующий дрейф. Документ краулера авторитетен, и он читается
 * из его чекаута — или оттуда, куда указывает `CONTRACT_OPENAPI_PATH`.
 */

import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { buildValidator, parseContractDocument } from './global-setup';

describe('the validator the contract test relies on', () => {
  it('accepts a card that matches the contract', () => {
    // Обратная сторона. Валидатор, который отвергал бы всё, делал бы контрактный
    // тест видимо строгим, не доказывая ничего.
    const document = parseContractDocument();
    const validate = buildValidator(document, 'ProductCard');

    const card = {
      id: '11111111-1111-4111-8111-111111111111',
      targetId: '22222222-2222-4222-8222-222222222222',
      targetName: 'Чайники',
      title: 'Чайник электрический',
      priceKopecks: 199990,
      salePriceKopecks: null,
      brand: 'Brand',
      seller: 'Seller',
      cashbackPercent: 12.5,
      cashbackRubles: 240,
      inStock: true,
      imageUrl: 'https://cdn.example.com/i.png',
      productUrl: 'https://www.wildberries.net/catalog/1/detail.aspx',
      scrapedAt: '2024-05-06T07:08:09Z',
    };

    expect(validate(card), JSON.stringify(validate.errors)).toBe(true);
  });

  it('rejects a price that is not a number', () => {
    const document = parseContractDocument();
    const validate = buildValidator(document, 'ProductCard');

    expect(validate({ priceKopecks: '199990' })).toBe(false);
  });

  it('rejects a card that is missing a required field', () => {
    const document = parseContractDocument();
    const validate = buildValidator(document, 'ProductCard');

    expect(validate({ id: '11111111-1111-4111-8111-111111111111' })).toBe(false);
  });

  it('rejects a timestamp that is not a date-time', () => {
    const document = parseContractDocument();
    const validate = buildValidator(document, 'ProductCard');

    expect(validate({ scrapedAt: 'the day before yesterday' })).toBe(false);
  });

  it('rejects a sort name outside the enum', () => {
    const document = parseContractDocument() as {
      paths: Record<string, { get: { parameters: Array<{ name: string; schema: unknown }> } }>;
    };
    const sortParameter = document.paths['/items']!.get.parameters.find((p) => p.name === 'sort');
    expect(sortParameter, 'the contract must document a sort parameter').toBeDefined();

    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(sortParameter!.schema as object);

    expect(validate('PriceDesc')).toBe(true);
    expect(validate('PriceDesc; DROP TABLE items')).toBe(false);
    expect(validate('scraped_at DESC')).toBe(false);
  });
});
