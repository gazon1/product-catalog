/**
 * types.generated.ts — GENERATED FILE. Do not edit it.
 *
 * ## What this file is
 *
 * The crawler's contract, in TypeScript. It is generated from the crawler's
 * own OpenAPI document (`contract/catalog-v1.openapi.yaml` in the crawler
 * repository) by `npm run contract-types`, and it is committed so that the
 * compiler has the shapes without everybody having to run the generator.
 *
 * ## Why it is committed
 *
 * A generated file that is not committed cannot be checked.
 * `npm run contract-types:check` regenerates it and fails when the result
 * differs from what is committed — that is the gate that catches "the
 * contract changed and nobody regenerated the types", which otherwise shows
 * up much later, as an `undefined` on a page.
 *
 * ## What is in here
 *
 *   - the types themselves, as `openapi-typescript` writes them;
 *   - the runtime shadow of the schemas: the property lists with their types
 *     and their nullability, which the contract test compares against the
 *     document, because an interface is erased at runtime and cannot be
 *     compared with anything.
 *
 * The site's own vocabulary — `src/lib/api/types.ts` — derives its
 * interfaces from the types above, so there is nothing here to keep in sync
 * by hand.
 *
 * ## The fingerprint
 *
 * The document's SHA-256 is part of the file. It is the hash of the
 * document's *bytes*, not of its meaning: a comment that changes the
 * contract's wording is still a change to the contract, and the gate has to
 * notice it. It is also what makes the generation deterministic — the same
 * document always produces this file, byte for byte.
 *
 * The document this file was generated from has the fingerprint
 * `bca08996ea763d2db65ab5be653dfe875b23244e3f54804c3e8dd165c6e05b51`.
 */
export interface paths {
    "/targets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Every crawl target with its item count.
         * @description A full pass over the read model — the current observation of each product —
         *     grouped per target. It is the one aggregate that does not scale for free, so
         *     the API caches it for ten minutes rather than recomputing it per request,
         *     and the answer says when it was computed.
         */
        get: operations["listTargets"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/items": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * A filtered, sorted, paginated page of product cards.
         * @description The list is a list of **products**: the crawler stores one row per
         *     (target, product, price) — a price change writes a new row and keeps the old
         *     one, because the price history is made of those rows — and this endpoint
         *     answers with the current observation of each product. A product that changed
         *     price is one card, with the price it has now, not two cards with two prices.
         *
         *     The price filters read that current price: a product that was cheap last week
         *     and is expensive today is not found by "up to N".
         *
         *     `totalCount` counts the products that match, not the price observations
         *     behind them.
         */
        get: operations["listItems"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/items/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** One product card plus its price history. */
        get: operations["getItem"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/top-deals": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The highest cashback across all targets, one row per matched product.
         * @description Products that appear in several targets are collapsed to their best
         *     observation. Rows without a match id are excluded: without a stable
         *     grouping key the "best deal" list would deduplicate arbitrarily and show
         *     the same product twice.
         */
        get: operations["listTopDeals"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/stats": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Aggregate counters for the whole catalog.
         * @description The counters come in two pairs, because the crawler stores price *observations*
         *     and the storefront shows *products*. `totalItems` and `withCashback` count the
         *     observations; `totalProducts` and `productsWithCashback` count the products.
         *
         *     The aggregate is cached for ten minutes, so the answer carries `asOf` — the
         *     moment the counters were computed.
         */
        get: operations["getStats"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/contract": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * This document.
         * @description Served so that a consumer can validate the responses it receives
         *     against the same contract the provider was built from, instead of
         *     against a copy that nobody keeps in sync.
         */
        get: operations["getContract"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Liveness — the process is up.
         * @description Deliberately does not touch the database. A liveness probe that fails on
         *     a database blip would restart a crawler that is working fine and would
         *     interrupt a crawl in progress.
         */
        get: operations["getHealth"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/ready": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Readiness — the catalog can be served.
         * @description Checks that the catalog's own database pool can execute a statement and
         *     that the columns the catalog reads are present.
         *
         *     The schema check is what turns "the database is reachable" into "the
         *     catalog can be served": a missing column is not a null result, it is a
         *     failed query, and a readiness probe that only asks the first question
         *     reports a healthy service that cannot answer anything.
         *
         *     It stays cheap on purpose — no counts over the scraped items, no full
         *     catalog query — because the deploy gate, the container health check and
         *     the storefront all call it.
         */
        get: operations["getReady"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        Error: {
            /** @description A short, human-readable reason. Never contains a secret. */
            error: string;
        };
        /**
         * @description One crawled product. The field names are the storefront's own — the
         *     translation from the crawler's column names happens here, once, and the
         *     storefront sees one vocabulary.
         */
        ProductCard: {
            /**
             * Format: uuid
             * @description The id of this scraped observation.
             */
            id: string;
            /** Format: uuid */
            targetId: string;
            targetName: string;
            /**
             * @description Never empty. A crawled item may have no title, and a card without
             *     one cannot be rendered as a link, so the API substitutes a
             *     placeholder built from the id.
             */
            title: string;
            /** @description Price in kopecks. Null when the crawler could not parse one. */
            priceKopecks?: number | null;
            /** @description Discounted price in kopecks. Null when there is no discount. */
            salePriceKopecks?: number | null;
            brand?: string | null;
            seller?: string | null;
            /** @description Cashback in percent. */
            cashbackPercent?: number | null;
            /**
             * @description Cashback in **rubles**. The crawler stores it in rubles already —
             *     it converts kopecks to rubles before writing — so the value passes
             *     through unchanged. Dividing it by 100 again would be wrong.
             */
            cashbackRubles?: number | null;
            inStock?: boolean | null;
            /** Format: uri */
            imageUrl?: string | null;
            /** Format: uri */
            productUrl: string;
            /**
             * Format: date-time
             * @description When this observation was made. UTC, with a `Z` suffix.
             */
            scrapedAt: string;
        };
        /** @description A product card plus the price history of the product. */
        ProductDetail: components["schemas"]["ProductCard"] & {
            /**
             * @description The observations of this product inside its own target, newest
             *     first. Observations of other targets are not mixed in: a history
             *     that crosses targets is not the history of a product.
             */
            history: components["schemas"]["PricePoint"][];
        };
        PricePoint: {
            /** Format: date-time */
            scrapedAt: string;
            priceKopecks?: number | null;
            cashbackPercent?: number | null;
            cashbackRubles?: number | null;
        };
        TargetSummary: {
            /** Format: uuid */
            id: string;
            name: string;
            rootCategoryName?: string | null;
            isActive: boolean;
            /** @description How many products this target holds right now — the current observation of each product in it. Zero for a configured but empty target. It is not the number of price observations the target has produced: a product that changed price twice is one product and two observations. */
            itemCount: number;
            /** Format: date-time */
            newestScrapedAt?: string | null;
        };
        PagedProductCard: {
            items: components["schemas"]["ProductCard"][];
            /** @description The number of matching rows, ignoring paging. */
            totalCount: number;
            /** @description The zero-based index of the returned page. */
            page: number;
            pageSize: number;
            totalPages: number;
            hasNextPage: boolean;
            hasPrevPage: boolean;
        };
        SiteStats: {
            /** @description How many price observations the catalog holds. The crawler stores one row per (target, product, price) — a price change writes a new row and keeps the old one, because the price history is made of those rows. This is the number of those rows, not the number of products. */
            totalItems: number;
            /** @description How many products the catalog holds — the number a visitor means by "how many products are there". It is the number of distinct products, each counted once, with the price it has now. */
            totalProducts: number;
            totalTargets: number;
            /** Format: date-time */
            newestScrapedAt?: string | null;
            /** @description How many observations carry a cashback percentage. */
            withCashback: number;
            /** @description How many products carry a cashback percentage now. */
            productsWithCashback: number;
            /**
             * Format: date-time
             * @description The moment the counters were computed. The aggregate is cached for ten minutes, so a counter without a moment is a counter of unknown age.
             */
            asOf: string;
        };
    };
    responses: {
        /** @description The key is missing or does not match. */
        Unauthorized: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /**
         * @description A parameter cannot be interpreted: an id that is not a UUID, a sort order
         *     that is not in the list, a number that is not a number. A paging value
         *     outside its range is not one of these — it is clamped, not rejected.
         */
        BadRequest: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description No such product. */
        NotFound: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description The catalog cannot be served right now. */
        Unavailable: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /**
         * @description The caller made more requests in the window than the limit allows. The
         *     limit is counted per key and is a second line of defence behind the key:
         *     the key says who may read, this says how much.
         */
        TooManyRequests: {
            headers: {
                /** @description The seconds to wait before the next request. */
                "Retry-After"?: number;
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
    };
    parameters: never;
    requestBodies: never;
    headers: {
        /**
         * @description The identifier of the request. A caller may send one in the same header;
         *     the API answers with the one it used, and every log line the request
         *     produces carries it. A value that cannot be trusted is replaced with a
         *     generated identifier rather than refused.
         */
        "X-Request-Id": string;
    };
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    listTargets: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The targets. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["X-Request-Id"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["TargetSummary"][];
                        /**
                         * Format: date-time
                         * @description The moment the counts were computed. The aggregate is cached for ten minutes, so a count without a moment is a count of unknown age.
                         */
                        asOf: string;
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    listItems: {
        parameters: {
            query?: {
                /** @description Restrict to one crawl target. */
                targetId?: string;
                /**
                 * @description Literal substring search over title, brand and seller. `%` and `_`
                 *     are literal characters, not wildcards.
                 */
                q?: string;
                /** @description Minimum price **in rubles**. Converted to kopecks exactly once, by the API. */
                minPrice?: number;
                /** @description Maximum price **in rubles**. Converted to kopecks exactly once, by the API. */
                maxPrice?: number;
                /** @description Minimum cashback **in percent**. */
                minCashback?: number;
                /** @description Only items currently in stock. */
                inStock?: boolean;
                /**
                 * @description Sort order. Every order is total: rows with equal sort keys are
                 *     ordered by their id, so a page boundary never repeats or drops a row.
                 */
                sort?: "DateDesc" | "DateAsc" | "PriceAsc" | "PriceDesc" | "CashbackPercentDesc" | "CashbackPercentAsc" | "TitleAsc" | "TitleDesc";
                /**
                 * @description Zero-based page index. A value outside the range is clamped into it
                 *     rather than rejected: a hostile page number is a mistake in a URL, and
                 *     the first page is a better answer than an error.
                 *
                 *     The bound is on the *offset* — `page x pageSize` — and not on the page
                 *     index, because the offset is what the database pays for: it walks every
                 *     row before the page. The offset never exceeds 1 000 000 rows, so the
                 *     largest page depends on the page size (1 000 000 with the default page
                 *     size of 24, 16 666 with the largest one of 60). A request beyond that
                 *     is answered with the last page that fits, not with an error.
                 */
                page?: number;
                /**
                 * @description Rows per page. A value outside the range is clamped into it rather
                 *     than rejected.
                 */
                pageSize?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page of product cards. */
            200: {
                headers: {
                    /** @description The total number of matching rows, ignoring paging. */
                    "X-Total-Count"?: number;
                    /** @description The number of pages the result set is split into. */
                    "X-Page-Count"?: number;
                    "X-Request-Id": components["headers"]["X-Request-Id"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PagedProductCard"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    getItem: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The id of a single scraped item. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The product and its history. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["X-Request-Id"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProductDetail"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    listTopDeals: {
        parameters: {
            query?: {
                /** @description Minimum cashback **in percent**. */
                minCashback?: number;
                /**
                 * @description Zero-based page index. A value outside the range is clamped into it
                 *     rather than rejected: a hostile page number is a mistake in a URL, and
                 *     the first page is a better answer than an error.
                 *
                 *     The bound is on the *offset* — `page x pageSize` — and not on the page
                 *     index, because the offset is what the database pays for: it walks every
                 *     row before the page. The offset never exceeds 1 000 000 rows, so the
                 *     largest page depends on the page size (1 000 000 with the default page
                 *     size of 24, 16 666 with the largest one of 60). A request beyond that
                 *     is answered with the last page that fits, not with an error.
                 */
                page?: number;
                /**
                 * @description Rows per page. A value outside the range is clamped into it rather
                 *     than rejected.
                 */
                pageSize?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page of product cards. */
            200: {
                headers: {
                    /** @description The total number of deduplicated rows, ignoring paging. */
                    "X-Total-Count"?: number;
                    /** @description The number of pages the result set is split into. */
                    "X-Page-Count"?: number;
                    "X-Request-Id": components["headers"]["X-Request-Id"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PagedProductCard"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    getStats: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The counters. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["X-Request-Id"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SiteStats"];
                };
            };
            401: components["responses"]["Unauthorized"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    getContract: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The OpenAPI document. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["X-Request-Id"];
                    [name: string]: unknown;
                };
                content: {
                    "application/yaml": string;
                };
            };
            401: components["responses"]["Unauthorized"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    getHealth: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The process is alive. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["X-Request-Id"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {string} */
                        status: "UP";
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    getReady: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The catalog can be served. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["X-Request-Id"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {string} */
                        status: "UP";
                        checks?: {
                            [key: string]: string;
                        };
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            429: components["responses"]["TooManyRequests"];
            503: components["responses"]["Unavailable"];
        };
    };
}
/* ---------------------------------------------------------------------------
 * The runtime shadow of the schemas above.
 *
 * A TypeScript interface is erased at runtime, so a test cannot compare it
 * with the contract document: `tsc` is happy with an interface that has
 * drifted, and the drift only shows up where a field is read — at runtime,
 * in production, on a page that renders an empty price. The property lists
 * below are that shadow: one entry per property, with its type and its
 * nullability, so the contract test can compare them with the document
 * field for field.
 * ------------------------------------------------------------------------- */

/**
 * The SHA-256 of the contract document this file was generated from.
 *
 * The hash is of the document's bytes, so that the staleness gate notices
 * every change to it — a retyped field, a renamed property, and a comment
 * that changes what the contract says.
 */
export const CONTRACT_DOCUMENT_SHA256 = 'bca08996ea763d2db65ab5be653dfe875b23244e3f54804c3e8dd165c6e05b51';

/** The properties of `ProductCard`, as the contract describes them. */
export const PRODUCT_CARD_FIELDS = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'targetId', type: 'string', nullable: false },
  { name: 'targetName', type: 'string', nullable: false },
  { name: 'title', type: 'string', nullable: false },
  { name: 'priceKopecks', type: 'integer', nullable: true },
  { name: 'salePriceKopecks', type: 'integer', nullable: true },
  { name: 'brand', type: 'string', nullable: true },
  { name: 'seller', type: 'string', nullable: true },
  { name: 'cashbackPercent', type: 'number', nullable: true },
  { name: 'cashbackRubles', type: 'number', nullable: true },
  { name: 'inStock', type: 'boolean', nullable: true },
  { name: 'imageUrl', type: 'string', nullable: true },
  { name: 'productUrl', type: 'string', nullable: false },
  { name: 'scrapedAt', type: 'string', nullable: false },
] as const;

/** The properties of `PricePoint`, as the contract describes them. */
export const PRICE_POINT_FIELDS = [
  { name: 'scrapedAt', type: 'string', nullable: false },
  { name: 'priceKopecks', type: 'integer', nullable: true },
  { name: 'cashbackPercent', type: 'number', nullable: true },
  { name: 'cashbackRubles', type: 'number', nullable: true },
] as const;

/** The properties of `TargetSummary`, as the contract describes them. */
export const TARGET_SUMMARY_FIELDS = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'name', type: 'string', nullable: false },
  { name: 'rootCategoryName', type: 'string', nullable: true },
  { name: 'isActive', type: 'boolean', nullable: false },
  { name: 'itemCount', type: 'integer', nullable: false },
  { name: 'newestScrapedAt', type: 'string', nullable: true },
] as const;

/** The properties of `PagedProductCard`, as the contract describes them. */
export const PAGED_FIELDS = [
  { name: 'items', type: 'array', nullable: false },
  { name: 'totalCount', type: 'integer', nullable: false },
  { name: 'page', type: 'integer', nullable: false },
  { name: 'pageSize', type: 'integer', nullable: false },
  { name: 'totalPages', type: 'integer', nullable: false },
  { name: 'hasNextPage', type: 'boolean', nullable: false },
  { name: 'hasPrevPage', type: 'boolean', nullable: false },
] as const;

/** The properties of `SiteStats`, as the contract describes them. */
export const SITE_STATS_FIELDS = [
  { name: 'totalItems', type: 'integer', nullable: false },
  { name: 'totalProducts', type: 'integer', nullable: false },
  { name: 'totalTargets', type: 'integer', nullable: false },
  { name: 'newestScrapedAt', type: 'string', nullable: true },
  { name: 'withCashback', type: 'integer', nullable: false },
  { name: 'productsWithCashback', type: 'integer', nullable: false },
  { name: 'asOf', type: 'string', nullable: false },
] as const;

/** The properties of `Error`, as the contract describes them. */
export const ERROR_RESPONSE_FIELDS = [
  { name: 'error', type: 'string', nullable: false },
] as const;

/** The properties of `ProductDetail`: the card's own, plus the history. */
export const PRODUCT_DETAIL_FIELDS = [
  ...PRODUCT_CARD_FIELDS,
  { name: 'history', type: 'array', nullable: false },
] as const;
