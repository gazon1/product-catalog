/**
 * Документ контракта: как его прочитать, разобрать и превратить в валидатор.
 *
 * ## Зачем это отдельный файл
 *
 * Три вещи живут рядом по одной причине: они работают с одним и тем же
 * документом и должны видеть его одинаково. Разбор без валидатора и
 * валидатор без документа — это два места, где «документ контракта» вдруг
 * окажется разным.
 *
 * ## Документ — чужой
 *
 * Витрина не хранит копию документа намеренно: два документа, описывающих
 * одни и те же формы, — это два источника истины, и тот, который никто не
 * читает, тихо разрешает следующий разъезд. Собственный документ краулера
 * авторитетен, и он читается из его чекаута — или оттуда, куда указывает
 * `CONTRACT_OPENAPI_PATH`.
 *
 * Запущенный краулер отдаёт тот же документ по `GET
 * /api/catalog/v1/contract`, и контрактный тест проверяет живые ответы по
 * *той* копии. Эта функция — для тестов, которым документ нужен без
 * краулера.
 *
 * Где документ ищется, живёт в `scripts/contract-document.mjs`, а не здесь:
 * генератор, который пишет типы сайта, обязан читать тот же самый документ,
 * и два расходящихся разрешения позволили бы типам и тесту описывать два
 * разных контракта.
 */

import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import type { FieldDescriptor } from '@/lib/api/types';
import { loadContractDocument as readContractDocument } from '../../scripts/contract-document.mjs';

/** Документ контракта, прочитанный с диска. */
export function loadContractDocument(): string {
  return readContractDocument();
}

/** Документ контракта, разобранный. */
export function parseContractDocument(): unknown {
  return parse(loadContractDocument());
}

/**
 * Свойства, которые объявляет схема контракта, — как их зеркалит сайт.
 *
 * Разбор свойств нужен двум слоям проверки: полям ответа (карточка и деталь
 * должны нести ровно то, что объявляет документ) и схеме (ответ должен быть
 * валиден по документу целиком). Список пишется здесь один раз — иначе два
 * слоя поймут документ по-разному, а проверять будут одно и то же.
 */
export function contractFields(schema: unknown): FieldDescriptor[] {
  const properties = (schema as { properties?: Record<string, { type?: unknown }> }).properties ?? {};
  return Object.entries(properties).map(([name, property]) => {
    const declared = property.type;
    const types = Array.isArray(declared) ? declared : [declared];
    const nullable = types.includes('null');
    const base = types.find((t) => t !== 'null') ?? 'string';
    return { name, type: base, nullable } as FieldDescriptor;
  });
}

/** Переписать ссылки документа на компоненты в локальный блок `$defs`. */
function withLocalRefs(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.startsWith('#/components/schemas/')
      ? `#/$defs/${value.slice('#/components/schemas/'.length)}`
      : value;
  }
  if (Array.isArray(value)) return value.map(withLocalRefs);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = withLocalRefs(item);
    }
    return out;
  }
  return value;
}

/**
 * Валидатор одной схемы компонента документа контракта.
 *
 * Документ — это OpenAPI 3.1, то есть JSON Schema 2020-12 с несколькими
 * лишними разделами вокруг. Отвечать на вопросы о теле ответа умеет только
 * часть `components.schemas`, поэтому компилируется она — со ссылками на
 * компоненты, переписанными в локальный блок `$defs`, потому что у
 * валидатора нет документа, в котором разрешать `#/components/...`.
 */
export function buildValidator(document: unknown, name: string) {
  const schemas = (document as { components?: { schemas?: Record<string, unknown> } }).components?.schemas ?? {};
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  return ajv.compile({
    $defs: withLocalRefs(schemas) as Record<string, unknown>,
    $ref: `#/$defs/${name}`,
  });
}
