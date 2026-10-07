-- provision-readonly-role.sql — give the storefront a SELECT-only login.
--
-- WHY THIS IS A FILE AND NOT A STEP IN deploy.yml
--
-- The storefront owns no schema. This script is run ONCE by whoever administers
-- the crawler's database, and it is committed precisely so that what was granted
-- can be reviewed. Deploying it from the storefront would mean the storefront
-- had the rights to create roles in a database it does not own — which is the
-- privilege this whole arrangement exists to withhold.
--
-- Read-only is guaranteed at three levels (see README). This file is level one,
-- and the only one that lives outside this repository. Levels two
-- (`default_transaction_read_only=on` per session) and three (a gate that fails
-- the build on INSERT/UPDATE/DDL in `src/lib`) are here and cannot be disabled
-- by anyone outside the database. Removing this one leaves two, which is
-- survivable; that is the design.
--
-- HOW TO RUN
--
--   psql -v ON_ERROR_STOP=1 \
--        -v catalog_password="$CATALOG_READONLY_PASSWORD" \
--        -h "$DB_HOST" -U "$DB_ADMIN" -d "$DB_NAME" \
--        -f deploy/provision-readonly-role.sql
--
--   CATALOG_READONLY_PASSWORD is read from the environment and never appears in
--   this file. `\gexec` executes the strings this builds, and psql's `:'var'`
--   quotes the value as a SQL literal, so no quoting is done by hand.
--
-- IDEMPOTENT: re-running changes the password and re-applies the grants. It
-- never drops anything and never revokes access the crawler needs.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. The login itself
-- ---------------------------------------------------------------------------

-- `\gexec` exists because a dollar-quoted DO block cannot see a psql variable:
-- psql does not substitute inside dollar quotes, so the password would arrive
-- as the literal text 'catalog_password'. `\gexec` sidesteps that by building
-- the statement outside any quoting context.
SELECT format('CREATE ROLE catalog_readonly LOGIN PASSWORD %L', :'catalog_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'catalog_readonly')
\gexec

-- Separate from the CREATE so that rotating the password is the same command
-- as first provisioning it.
SELECT format('ALTER ROLE catalog_readonly PASSWORD %L', :'catalog_password')
\gexec

-- ---------------------------------------------------------------------------
-- 2. The grants — SELECT and nothing else
-- ---------------------------------------------------------------------------

GRANT CONNECT ON DATABASE :"dbname" TO catalog_readonly;

-- USAGE lets the role resolve names in `public`; without it even a granted
-- table is unreachable. It grants no access to the table itself.
GRANT USAGE ON SCHEMA public TO catalog_readonly;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO catalog_readonly;

-- ---------------------------------------------------------------------------
-- 3. Tables created AFTER this script ran
-- ---------------------------------------------------------------------------

-- THIS LINE HAS TO BE RUN BY THE CRAWLER, NOT BY THE OPERATOR.
--
-- `ALTER DEFAULT PRIVILEGES` applies only to objects created by the role that
-- executes it. Run as the crawler, it covers every table the crawler's
-- migrations add from now on. Run as an admin, it covers only tables that admin
-- goes on to create — which is none of them, because the crawler creates them.
--
-- So this file can complete successfully while leaving the storefront unable to
-- read the next migration's table. It is recorded here as a requirement rather
-- than executed here, and README says so in the same words.
--
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     GRANT SELECT ON TABLES TO catalog_readonly;

-- ---------------------------------------------------------------------------
-- 4. Verification
-- ---------------------------------------------------------------------------

-- Run this after provisioning and after any crawler migration. It should list
-- `catalog_readonly` with privileges `r` (SELECT) and nothing containing w
-- (write), D (DELETE), U (UPDATE), or C (CREATE).
--
--   SELECT table_name, privilege_type
--     FROM information_schema.role_table_grants
--    WHERE grantee = 'catalog_readonly'
--    ORDER BY table_name, privilege_type;
--
-- The negative control matters more than the positive one: a role that appears
-- in the list proves something was granted, and only the absence of write
-- privileges proves the boundary is intact.