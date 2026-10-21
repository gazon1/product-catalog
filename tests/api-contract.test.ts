/**
 * Контракт, который отдаёт API: сам документ и словарь, который он объявляет.
 *
 * ## Что здесь под тестом
 *
 * Краулер отдаёт свой документ контракта по `GET /api/catalog/v1/contract`, и
 * этот документ — то, против чего проверяются живые ответы. Поэтому он
 * проверяется сам по себе, до всяких ответов: если документ не тот или в нём
 * нет путей, то все слои ниже будут проверять не то.
 *
 * ## Почему живой документ, а не файл из репозитория
 *
 * Ответы приходят из запущенного образа, и схема, по которой они проверяются,
 * должна прийти из того же места. Документ из соседнего checkout'а краулера —
 * это документ *другого* коммита, и он расходится с живым ровно тогда, когда
 * образ и коммит разошлись.
 *
 * ## Словарь сортировки — здесь, а не в архитектурном гейте
 *
 * Закрытый набор имён сортировки проверяется ещё и архитектурным гейтом
 * (`tests/architecture/sort-vocabulary.test.ts`) — по документу из репозитория,
 * без краулера. Здесь проверяется то же самое, но по документу, который
 * отдаёт живой образ: два источника правды о словаре должны говорить одно и
 * то же, иначе сайт отправит имя, которое живой API не примет.
 */

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { apiGetText } from '@/lib/api/client';
import { SORT_ORDERS } from '@/lib/api/sort';
import { useContractEnvironment } from './contract/harness';

useContractEnvironment();

describe('контракт, который отдаёт API', () => {
  it('отдаётся запущенным краулером', async () => {
    const text = await apiGetText('/contract');
    const document = parse(text) as { openapi?: string; paths?: Record<string, unknown> };
    expect(document.openapi).toBe('3.1.0');
    expect(document.paths).toBeDefined();
  });

  it('объявляет ровно те имена сортировки, которые шлёт сайт', async () => {
    const document = parse(await apiGetText('/contract')) as {
      paths: Record<string, { get: { parameters: Array<{ name: string; schema: { enum?: string[] } }> } }>;
    };
    const parameter = document.paths['/items']!.get.parameters.find((p) => p.name === 'sort');
    expect(parameter?.schema.enum?.slice().sort()).toEqual([...SORT_ORDERS].sort());
  });
});
