#!/usr/bin/env node
/**
 * generate-seed.mjs — deterministic synthetic data for the dev database.
 *
 * ## Why generated data at all
 *
 * The crawler's database is empty until it runs against the real upstream API, and the
 * storefront has to be developed, reviewed and demoed before that happens. A
 * seed that looks like production data exercises the parts that empty states do
 * not: pagination, sorting, price history, the image proxy, the JSON-LD, the
 * `match_id` top-deals path, and the "target exists but holds nothing" case.
 *
 * ## Determinism is the point
 *
 * A seeded PRNG means the same command produces byte-identical SQL every time.
 * That matters for three reasons:
 *   - `npm run seed` produces no diff, so a regenerated seed cannot silently
 *     become part of a commit;
 *   - screenshots and reviews refer to the same catalogue every time;
 *   - a bug that reproduces against dev data can be reproduced later.
 *
 * ## It is not production data
 *
 * Every file in dev/db/ is applied to the *dev* database only. The storefront has
 * no migration mechanism and no write path, so there is no code path by which a
 * generated row could reach the crawler's real database.
 *
 * USAGE
 *   node scripts/generate-seed.mjs [--out dev/db/seed.sql] [--items 120] [--seed 42]
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const OUT = resolve(ROOT, arg('out', 'dev/db/seed.sql'));
const ITEMS_PER_TARGET = Number(arg('items', '120'));
const SEED = Number(arg('seed', '20261007'));

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32)
//
// Math.random() would make the seed change on every run, which defeats the whole
// point — see the file header.
// ---------------------------------------------------------------------------

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(SEED);
const randInt = (min, max) => min + Math.floor(rand() * (max - min + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const chance = (p) => rand() < p;

/** Deterministic UUID-shaped id. NOT a real UUID — it just has the right shape. */
let uuidCounter = 0;
function uuid() {
  uuidCounter += 1;
  const hex = SEED.toString(16).padStart(8, '0') + uuidCounter.toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(12, 15)}-a${hex.slice(15, 18)}-${hex.slice(18, 30)}`.padEnd(36, '0').slice(0, 36);
}

// ---------------------------------------------------------------------------
// Catalogue definitions
// ---------------------------------------------------------------------------

const CATEGORIES = [
  {
    name: 'Ноутбуки',
    root: 'Электроника',
    brands: ['ASUS', 'Lenovo', 'Apple', 'HP', 'Acer', 'MSI', 'Dell'],
    nouns: ['ноутбук', 'ультрабук', 'ноутбук игровой', 'MacBook', 'трансформер'],
    adjectives: ['15.6" FHD', '16" 2.8K OLED', '14" IPS', '13.6" Retina', '17.3" 165Hz'],
    price: [28000, 220000],
    sellers: ['ТехноПарк', 'DNS', 'М.Видео', 'Ситилинк', 'Ozon'],
  },
  {
    name: 'Смартфоны',
    root: 'Электроника',
    brands: ['Apple', 'Samsung', 'Xiaomi', 'realme', 'Honor', 'OnePlus'],
    nouns: ['смартфон', 'телефон', 'iPhone', 'Galaxy', 'Poco'],
    adjectives: ['128 ГБ', '256 ГБ', '512 ГБ', '1 ТБ', '12/256 ГБ'],
    price: [9000, 180000],
    sellers: ['М.Видео', 'DNS', 'Эльдорадо', 'Связной', 'Яндекс Маркет'],
  },
  {
    name: 'Кофеварки',
    root: 'Дом и сад',
    brands: ['De’Longhi', 'Philips', 'Bosch', 'Nivona', 'Melitta', 'Smeg'],
    nouns: ['кофемашина', 'кофеварка', 'капусульная кофемашина', 'рожковая кофеварка'],
    adjectives: ['автомат', 'рожковая', 'капсульная', 'профессиональная', 'компактная'],
    price: [3500, 180000],
    sellers: ['ТехноПарк', 'ДНС', 'Ozon', 'ВкусВилл Маркет'],
  },
  {
    name: 'Кроссовки',
    root: 'Одежда',
    brands: ['Nike', 'Adidas', 'Puma', 'New Balance', 'Reebok', 'Asics'],
    nouns: ['кроссовки', 'беговые кроссовки', 'кеды', 'модели', 'лоферы'],
    adjectives: ['мужские', 'женские', 'унисекс', 'лёгкие', 'для бега'],
    price: [1800, 45000],
    sellers: ['Спортмастер', 'Ozon', 'Wild Sport', 'Спортмастер-Pro'],
  },
  {
    name: 'Пылесосы',
    root: 'Дом и сад',
    brands: ['Dyson', 'Samsung', 'LG', 'Philips', 'Tefal', 'Xiaomi'],
    nouns: ['пылесос', 'вертикальный пылесос', 'моющий пылесос', 'робот-пылесос'],
    adjectives: ['с аккумулятором', 'мощный', 'для владельцев животных', 'тихий', 'турбо'],
    price: [2500, 120000],
    sellers: ['М.Видео', 'ДНС', 'Ozon', 'ТехноПарк'],
  },
  {
    name: 'Книги',
    root: 'Книги',
    brands: ['Азбука', 'Большая книга', 'Эксмо', 'Манн, Иванов и Фербер', 'АСТ'],
    nouns: ['роман', 'сборник рассказов', 'учебник', 'фэнтези', 'детектив'],
    adjectives: ['в мягкой обложке', 'в твёрдом переплёте', 'карманный формат', 'иллюстрированное'],
    price: [180, 4500],
    sellers: ['Литрес', 'Читай-город', 'Бук24', 'Ozon'],
  },
  {
    name: 'Инструменты',
    root: 'Дом и сад',
    brands: ['Bosch', 'Makita', 'DeWalt', 'Metabo', 'Stanley'],
    nouns: ['шуруповёрт', 'перфоратор', 'циркулярная пила', 'набор инструментов', 'мультитул'],
    adjectives: ['аккумуляторный', 'сетевой', 'ударный', '18V', 'в кейсе'],
    price: [1200, 60000],
    sellers: ['ВсеИнструменты', 'Ozon', 'ТехноАвиа', 'Метрострой'],
  },
  {
    // Deliberately left empty: an empty category is a real state (a target that
    // is configured but has not been crawled yet) and the storefront has to
    // render it without pretending it has data.
    name: 'Зимняя резина',
    root: 'Автотовары',
    brands: [],
    nouns: [],
    adjectives: [],
    price: [0, 0],
    sellers: [],
    items: 0,
  },
];

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

const q = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
};

/**
 * content_hash must match what the crawler produces, because the unique index is
 * `(target_id, content_hash)` — a different format still works locally but would
 * hide a mismatch in the ON CONFLICT logic when the real crawler runs against
 * this same schema.
 */
function contentHash(targetId, productId, priceKopecks) {
  return `${targetId}:${productId}:${priceKopecks}`;
}

/** SHA-256, because `content_hash` is VARCHAR(64) — the column is named for a hash. */
async function sha256(text) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(text).digest('hex');
}

function makeTitle(cat, rand) {
  const brand = pick(cat.brands);
  const noun = pick(cat.nouns);
  const adj = pick(cat.adjectives);
  const model = String(randInt(1, 99)).padStart(2, '0');
  return `${brand} ${noun} ${adj} ${model}`;
}

/** Deterministic ISO timestamp inside a recent window, offset per observation. */
function observationTime(indexInProduct) {
  // Most recent scrape first, spaced by hours — so the "fresh items" list and
  // the price history both have realistic shapes.
  const hoursAgo = 1 + indexInProduct * randInt(6, 30);
  const d = new Date(Date.UTC(2026, 9, 7, 12, 0, 0) - hoursAgo * 3600_000);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

async function main() {
  const targets = [];
  const items = [];

  // Products are generated once and then placed into targets, so a handful of
  // them genuinely appear in more than one target — that is what makes the
  // top-deals DISTINCT ON (match_id) path return something.
  const sharedProducts = [
    { matchId: 990001, brand: 'Xiaomi', title: 'Xiaomi смартфон Redmi Note 14 8/256 ГБ', base: 18990 },
    { matchId: 990002, brand: 'Bosch', title: 'Bosch шуруповёрт аккумуляторный 18V', base: 12990 },
    { matchId: 990003, brand: 'De’Longhi', title: 'De’Longhi кофемашина автомат ECAM 22.110', base: 79990 },
    { matchId: 990004, brand: 'Nike', title: 'Nike кроссовки мужские Air беговые', base: 11490 },
  ];

  let matchIdSeq = 1_000_000;
  let productIdSeq = 5_000_000;

  for (const cat of CATEGORIES) {
    const targetId = uuid();
    targets.push({
      id: targetId,
      name: cat.name,
      root: cat.root,
      isActive: true,
    });

    const count = cat.items ?? ITEMS_PER_TARGET;
    if (count === 0) continue;

    for (let i = 0; i < count; i += 1) {
      const isShared = chance(0.04);
      const productId = productIdSeq++;
      const matchId = isShared ? pick(sharedProducts).matchId : matchIdSeq++;
      const brand = isShared ? pick(sharedProducts).brand : pick(cat.brands);
      const title = isShared ? pick(sharedProducts).title : makeTitle(cat, rand);
      const baseKopecks = Math.round((cat.price[0] + rand() * (cat.price[1] - cat.price[0])) * 100);

      // 2–5 observations per product: one current row plus history, which is what
      // the product page's chart needs.
      const observations = randInt(2, 5);
      for (let o = 0; o < observations; o += 1) {
        // Prices wander rather than random-walk independently, so the chart has
        // a shape a human would recognise instead of a saw.
        const drift = Math.round(baseKopecks * (1 + (rand() - 0.5) * 0.24) * (1 + o * 0.015));
        const priceKopecks = drift;

        // A sale price on some observations exercises the discount badge.
        const hasSale = chance(0.28);
        const salePriceKopecks = hasSale
          ? Math.round(priceKopecks * (0.55 + rand() * 0.25))
          : null;

        const cashbackPercent = chance(0.12) ? null : Math.round(rand() * 200) / 10;

        // `cashback` is RUPLES and `cashback_percent` is a PERCENT. The `/ 100`
        // below is the whole difference between them, and its absence produced
        // cashback amounts exactly 100× the product price — the same unit
        // confusion the crawler's ADR had to resolve by splitting the column in
        // two. Caught by reading the generated data back, not by the site.
        const payableKopecks = hasSale ? salePriceKopecks : priceKopecks;
        const cashbackRubles =
          cashbackPercent === null || payableKopecks === null
            ? null
            : Math.round(((payableKopecks / 100) * cashbackPercent) / 100 * 100) / 100;

        items.push({
          id: uuid(),
          targetId,
          productId,
          matchId,
          title,
          brand,
          seller: pick(cat.sellers),
          priceKopecks,
          salePriceKopecks,
          cashbackPercent,
          cashbackRubles,
          // ~15% have no image: the ProductImage fallback is a real state, and a
          // dev database where every card has a picture never exercises it.
          imageUrl: chance(0.15)
            ? null
            : `https://images.wbstatic.net/images/${randInt(1_000_000, 9_999_999)}.webp`,
          inStock: chance(0.86) ? true : false,
          productUrl: `https://www.wildberries.ru/catalog/${productId}/detail.aspx`,
          scrapedAt: observationTime(o),
        });
      }
    }
  }

  // Deterministic hash column. The ids are already generated deterministically,
  // so hashing the tuple keeps the file byte-identical between runs.
  for (const item of items) {
    item.contentHash = await sha256(
      contentHash(item.targetId, item.productId, item.priceKopecks)
    );
  }

  // -------------------------------------------------------------------------
  // Self-check — a generator that can emit nonsense must refuse to emit it
  // -------------------------------------------------------------------------
  //
  // This is here because a wrong number in a generated seed is invisible until
  // someone reads the rendered page carefully. It has already happened once:
  // cashback was computed as `price × percent` with the `/ 100` missing, so
  // every row carried a cashback 100× the price of its product. Nothing failed,
  // no query errored, and the site rendered it — as an ordinary-looking number.
  //
  // Failing at generation is the only point where the mistake is still cheap.
  const problems = [];

  for (const item of items) {
    const payable = item.salePriceKopecks ?? item.priceKopecks;

    if (item.cashbackRubles !== null && item.cashbackPercent !== null) {
      const expected = (payable / 100) * (item.cashbackPercent / 100);
      // A cent of tolerance: the generator rounds cashback to 2 decimals.
      if (item.cashbackRubles > expected + 0.01) {
        problems.push(
          `${item.title}: cashback ${item.cashbackRubles} ₽ exceeds ${expected.toFixed(2)} ₽ ` +
            `(${item.cashbackPercent}% of ${(payable / 100).toFixed(2)} ₽)`
        );
      }
    }

    if (item.salePriceKopecks !== null && item.salePriceKopecks >= item.priceKopecks) {
      problems.push(`${item.title}: sale price ${item.salePriceKopecks} is not below ${item.priceKopecks}`);
    }

    if (!Number.isInteger(item.priceKopecks)) {
      problems.push(`${item.title}: price_kopecks ${item.priceKopecks} is not an integer`);
    }
  }

  if (problems.length > 0) {
    console.error(`\n❌ generated data violates ${problems.length} invariant(s):`);
    for (const p of problems.slice(0, 10)) console.error(`   - ${p}`);
    console.error('\nThe seed was NOT written. Fix the generator, not the data.\n');
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // Emit
  // -------------------------------------------------------------------------

  const lines = [];
  lines.push('-- dev/db/seed.sql — SYNTHETIC data. Generated by scripts/generate-seed.mjs.');
  lines.push('--');
  lines.push('-- Do NOT read this as a description of real products, brands or prices. It is');
  lines.push('-- generated filler whose only purpose is to give the storefront realistic shapes');
  lines.push('-- to develop against. It is applied to the dev database only.');
  lines.push('');
  lines.push('BEGIN;');
  lines.push('');
  lines.push('TRUNCATE scraped_items, crawl_targets CASCADE;');
  lines.push('');

  lines.push('-- crawl_targets');
  for (const t of targets) {
    lines.push(
      `INSERT INTO crawl_targets (id, name, start_url, allowed_domains, max_depth, is_active, root_category_name)` +
        `\n  VALUES (${q(t.id)}, ${q(t.name)}, ${q(`https://www.wildberries.ru/catalog/0/search.aspx?cat=${t.id.slice(0, 8)}`)},` +
        ` ARRAY['www.wildberries.ru'], 1, ${t.isActive}, ${q(t.root)});`
    );
  }
  lines.push('');

  lines.push('-- scraped_items');
  for (const item of items) {
    lines.push(
      `INSERT INTO scraped_items (id, target_id, product_id, match_id, title, brand, seller,` +
        ` price_kopecks, sale_price_kopecks, cashback, cashback_percent, image_url, in_stock,` +
        ` product_url, content_hash, scraped_at)` +
        `\n  VALUES (${q(item.id)}, ${q(item.targetId)}, ${item.productId}, ${item.matchId}, ${q(item.title)},` +
        ` ${q(item.brand)}, ${q(item.seller)}, ${item.priceKopecks}, ${q(item.salePriceKopecks)},` +
        ` ${q(item.cashbackRubles)}, ${q(item.cashbackPercent)}, ${q(item.imageUrl)}, ${item.inStock},` +
        ` ${q(item.productUrl)}, ${q(item.contentHash)}, ${q(item.scrapedAt)});`
    );
  }
  lines.push('');
  lines.push('COMMIT;');
  lines.push('');

  const sql = lines.join('\n');
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, sql, 'utf8');

  const targetsWithData = targets.filter((t) => items.some((i) => i.targetId === t.id));
  console.log(`seed: ${targets.length} targets (${targetsWithData.length} with data), ${items.length} item observations`);
  console.log(`seed: written to ${OUT}`);
}

main().catch((err) => {
  console.error('seed generation failed', err);
  process.exit(1);
});