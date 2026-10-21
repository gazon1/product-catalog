/**
 * The crawler's catalog contract, in the site's own vocabulary.
 *
 * ## Where the truth lives
 *
 * The contract is the crawler's OpenAPI document
 * (`contract/catalog-v1.openapi.yaml` in the crawler repository, served at
 * `GET /api/catalog/v1/contract`). This file used to *mirror* it by hand — a
 * second description of the same shapes, kept in step by a test. It does not
 * any more: the shapes are **generated** from that document
 * (`src/lib/api/types.generated.ts`, produced by `npm run contract-types`),
 * and everything below is derived from the generated file.
 *
 * The difference is the whole point. A hand-written mirror is a copy, and a
 * copy can drift: `tsc` is happy with an interface that no longer matches the
 * contract, and the drift shows up where a field is read — at runtime, in
 * production, on a page that renders an empty price. A derived type cannot
 * drift: when the contract changes, the generated file changes, the staleness
 * gate fails until it is regenerated, and the compiler does the rest.
 *
 * ## The units are part of the contract
 *
 * Prices are **kopecks** (`priceKopecks`, `salePriceKopecks`). `cashbackRubles` is
 * **rubles** — the crawler's writer already converts kopecks to rubles before
 * storing them, so the value passes through unchanged and dividing it by 100
 * here would be wrong. `cashbackPercent` is a percent. The `minPrice`/`maxPrice`
 * query parameters are **rubles**; the API converts them to kopecks exactly once,
 * on its side, when it builds the query.
 *
 * ## Why the field descriptors exist next to the interfaces
 *
 * A TypeScript interface is erased at runtime, so a test cannot compare it
 * with the OpenAPI document: `tsc` is happy with an interface that has drifted, and
 * the drift only shows up where a field is read — at runtime, in production, on
 * a page that renders an empty price.
 *
 * The `*_FIELDS` descriptors below are the runtime shadow of the interfaces:
 * one entry per property, with its type and its nullability. They are
 * generated too — they live in the generated file, and the contract test
 * compares them against the document field-for-field, so a renamed or retyped
 * field is a failing test rather than a silently `undefined` at runtime.
 */

import {
  ERROR_RESPONSE_FIELDS as GENERATED_ERROR_RESPONSE_FIELDS,
  PAGED_FIELDS as GENERATED_PAGED_FIELDS,
  PRICE_POINT_FIELDS as GENERATED_PRICE_POINT_FIELDS,
  PRODUCT_CARD_FIELDS as GENERATED_PRODUCT_CARD_FIELDS,
  PRODUCT_DETAIL_FIELDS as GENERATED_PRODUCT_DETAIL_FIELDS,
  SITE_STATS_FIELDS as GENERATED_SITE_STATS_FIELDS,
  TARGET_SUMMARY_FIELDS as GENERATED_TARGET_SUMMARY_FIELDS,
  type components,
} from './types.generated';

/** The JSON types the contract uses. `integer` and `number` are distinct on purpose. */
export type FieldType = 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object';

/** One property of a DTO, as the contract describes it. */
export interface FieldDescriptor {
  /** The property name, exactly as it appears in the JSON. */
  readonly name: string;
  /** The JSON type. */
  readonly type: FieldType;
  /** Whether the contract allows `null` for this property. */
  readonly nullable: boolean;
}

/**
 * The contract's schema, with every property present.
 *
 * The contract marks a nullable property as *optional* — "it may be null, and
 * it may be absent". The site has always treated such a property as *present
 * but null*: the mappers in `src/lib/catalog/mapping.ts` turn an absent field into an
 * explicit `null` before anything else sees it, and the components compare
 * against `null` rather than against absence. `Required` is what reconciles
 * the two vocabularies — the property is required here and nullable there,
 * and both are true at the same time.
 *
 * The recursion matters for the same reason: the price history inside a
 * product detail is a list of price points, and the price points have the
 * same optional-but-nullable properties as the card does.
 */
type Present<T> = T extends readonly (infer U)[]
  ? Present<U>[]
  : T extends object
    ? { [K in keyof Required<T>]: Present<Required<T>[K]> }
    : T;

/**
 * One crawled product.
 *
 * The field names are the storefront's own — the translation from the crawler's
 * column names happens in the API, once, and the storefront sees one vocabulary.
 */
export type ProductCard = Present<components['schemas']['ProductCard']>;

/** One crawl target with its item count. */
export type TargetSummary = Present<components['schemas']['TargetSummary']>;

/** One price observation of a product. */
export type PricePoint = Present<components['schemas']['PricePoint']>;

/** Aggregate counters for the whole catalog. */
export type SiteStats = Present<components['schemas']['SiteStats']>;

/** The error body the API returns for every non-2xx answer. */
export type ErrorResponse = Present<components['schemas']['Error']>;

/**
 * One page of a list, with the counters the pages need to render a pager.
 *
 * The envelope comes from the contract's `PagedProductCard`; only the type of
 * the rows is the caller's, because a page of targets and a page of cards are
 * the same envelope with different rows.
 */
export type Paged<T> = Omit<Present<components['schemas']['PagedProductCard']>, 'items'> & {
  items: T[];
};

/** One page of product cards — the contract's `PagedProductCard`, in the site's vocabulary. */
export type PagedProductCard = Paged<ProductCard>;

/**
 * A product card plus the price history of the product inside its own target.
 *
 * The detail also says who answered and when the data it carries is about —
 * the same two fields every other answer of the catalog carries, so that a
 * page and a counter are read the same way.
 */
export type ProductDetail = ProductCard & {
  history: PricePoint[];
  instanceId: string;
  dataAsOf: string | null;
};

/**
 * The properties of `ProductCard`, as the contract describes them.
 *
 * The order is the contract's order, so a diff against the document reads as a
 * diff of the two, not of the two plus a reshuffle.
 */
export const PRODUCT_CARD_FIELDS = GENERATED_PRODUCT_CARD_FIELDS satisfies readonly FieldDescriptor[];

/** The properties of `PricePoint`. */
export const PRICE_POINT_FIELDS = GENERATED_PRICE_POINT_FIELDS satisfies readonly FieldDescriptor[];

/** The properties of `TargetSummary`. */
export const TARGET_SUMMARY_FIELDS = GENERATED_TARGET_SUMMARY_FIELDS satisfies readonly FieldDescriptor[];

/** The properties of the paged envelope (`PagedProductCard` in the contract). */
export const PAGED_FIELDS = GENERATED_PAGED_FIELDS satisfies readonly FieldDescriptor[];

/** The properties of `SiteStats`. */
export const SITE_STATS_FIELDS = GENERATED_SITE_STATS_FIELDS satisfies readonly FieldDescriptor[];

/** The properties of the error body. */
export const ERROR_RESPONSE_FIELDS = GENERATED_ERROR_RESPONSE_FIELDS satisfies readonly FieldDescriptor[];

/**
 * The properties of `ProductDetail`: the card's own, plus the history.
 *
 * The contract declares the detail as `allOf: [ProductCard, {history}]`, so the
 * detail's property set is the card's property set plus one — not a second,
 * hand-maintained copy of the same fourteen names.
 */
export const PRODUCT_DETAIL_FIELDS = GENERATED_PRODUCT_DETAIL_FIELDS satisfies readonly FieldDescriptor[];

/**
 * Whether two types are the same.
 *
 * The `Equal` trick compares the types by their internal identity rather than
 * by their structure, so `string` and `string | undefined` are *not* equal —
 * which is exactly the distinction these assertions are about.
 */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** A compile-time assertion: the type it is given must be `true`. */
type Expect<T extends true> = T;

/** The property names of a derived type, as the compiler sees them. */
type FieldNames<T> = Extract<keyof T, string>;

/**
 * The property lists and the types describe the same properties.
 *
 * Both come from the generated file, so this is a check on the generator
 * rather than on the contract: it fails the build if the runtime shadow and
 * the types ever stop agreeing about which properties a schema has. The
 * contract test then compares the shadow with the document itself.
 */
type _ProductCardFieldsMatchItsType = Expect<
  Equal<(typeof PRODUCT_CARD_FIELDS)[number]['name'], FieldNames<ProductCard>>
>;
type _ProductDetailFieldsMatchItsType = Expect<
  Equal<(typeof PRODUCT_DETAIL_FIELDS)[number]['name'], FieldNames<ProductDetail>>
>;
type _TargetSummaryFieldsMatchItsType = Expect<
  Equal<(typeof TARGET_SUMMARY_FIELDS)[number]['name'], FieldNames<TargetSummary>>
>;
type _PricePointFieldsMatchItsType = Expect<
  Equal<(typeof PRICE_POINT_FIELDS)[number]['name'], FieldNames<PricePoint>>
>;
type _SiteStatsFieldsMatchItsType = Expect<
  Equal<(typeof SITE_STATS_FIELDS)[number]['name'], FieldNames<SiteStats>>
>;
type _PagedFieldsMatchItsType = Expect<
  Equal<
    (typeof PAGED_FIELDS)[number]['name'],
    FieldNames<Present<components['schemas']['PagedProductCard']>>
  >
>;
type _ErrorResponseFieldsMatchItsType = Expect<
  Equal<(typeof ERROR_RESPONSE_FIELDS)[number]['name'], FieldNames<ErrorResponse>>
>;
