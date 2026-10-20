-- V4__catalog_indexes.sql
--
-- The indexes the catalog's own queries need, at the volume the catalog actually runs at.
--
-- ## Why this migration exists
--
-- The catalog's queries were written against a thousand rows of demo data, where every
-- query is fast and every plan is a sequential scan. At the volume a real crawl produces
-- — hundreds of thousands of observations — three of them stop being fast, and they stop
-- being fast for reasons that are visible in the plan rather than in the code:
--
--   1. The free-text search is `ILIKE '%q%'` over the title, the brand and the seller. A
--      pattern with a leading wildcard cannot use a btree index at all: the index does not
--      know where the word starts. The fix is a trigram index, which indexes the
--      *substrings* — the thing the pattern actually asks for.
--   2. The default order is `scraped_at DESC, id`. The tie-breaker by id is not a detail:
--      without it two rows with the same timestamp have an arbitrary order, and a page
--      boundary could then repeat one row and drop another. An index that carries the
--      tie-breaker lets the database produce that order without sorting.
--   3. The same order, restricted to one target — the shape of a category page. The
--      composite index serves both the ordering and the filter.
--
-- ## Why the indexes are built CONCURRENTLY
--
-- The table is being written to while the crawler works. A plain `CREATE INDEX` takes a
-- lock that blocks those writes for the length of the build, and the crawler is the
-- component whose work would be lost while it waits. `CREATE INDEX CONCURRENTLY` builds
-- the index without that lock, at the cost of a second pass over the table.
--
-- A concurrently built index is only marked valid once the build finishes, and a build
-- that fails leaves an invalid index behind. Both are why the statement says `IF NOT
-- EXISTS`: a re-run after a failed build finds the invalid index and does nothing, so the
-- operator has to drop it explicitly. The migration is therefore a thing to look at after
-- it runs, not a thing to run and forget.
--
-- `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block. Flyway recognises
-- the statement and runs the migration outside one — and the test suite runs the
-- migration against a real PostgreSQL, so this is checked rather than assumed.

-- The trigram extension: the index type that can answer `ILIKE '%q%'`.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Free-text search over the title, the brand and the seller.
--
-- Three separate indexes, one per column: a multicolumn trigram index would answer "the
-- pattern is in all three columns at once", which is not the question — the question is
-- "the pattern is in any of them".
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_scraped_items_title_trgm
    ON scraped_items USING GIN (title gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_scraped_items_brand_trgm
    ON scraped_items USING GIN (brand gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_scraped_items_seller_trgm
    ON scraped_items USING GIN (seller gin_trgm_ops);

-- The default order of the catalog list: newest first, with the id as the tie-breaker.
--
-- The id is part of the index because the order is total: rows with the same timestamp
-- are ordered by id, and an index that does not carry the id forces the database to sort
-- the rows before it can drop the ones before the page.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_scraped_items_scraped_at_id
    ON scraped_items (scraped_at DESC, id);

-- The same order inside one target: the shape of a category page.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_scraped_items_target_scraped_at_id
    ON scraped_items (target_id, scraped_at DESC, id);
