import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizePgDump } from "../scripts/regenerate-canonical-baseline.mjs";

const queryFunction = `CREATE FUNCTION public.openbooks_refresh_query_catalog() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $_$
declare
  safe_relations constant text[] := array[
    'dunning_log', 'employee_roles',
    'party_subsidiaries', 'pay_application_lines', 'pay_applications',
    'transfer_order_lines', 'transfer_orders', 'vendor_pay_application_lines'
  ];
begin
  null;
end
$_$;`;

function syntheticDump(extra = "") {
  return `--
-- PostgreSQL database dump
--
-- Dumped from database version 16.9
-- Dumped by pg_dump version 16.9

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: openbooks_query; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA openbooks_query;


--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


${queryFunction}

CREATE TABLE public.orgs (id uuid);
CREATE TABLE public.pay_run_adjustments (id uuid);
CREATE TABLE public.pay_runs (id uuid);
CREATE TABLE public.auth_sessions (id uuid);
ALTER TABLE ONLY public.user_org_access FORCE ROW LEVEL SECURITY;
REVOKE ALL ON FUNCTION public.openbooks_refresh_query_catalog() FROM PUBLIC;
${extra}

--
-- PostgreSQL database dump complete
--

`;
}

test("canonical dump transformation is deterministic and restores reviewed payroll views", () => {
  const first = canonicalizePgDump(syntheticDump());
  const second = canonicalizePgDump(syntheticDump());
  assert.equal(first, second);
  assert.match(first, /^-- OpenBooks canonical PostgreSQL baseline\./);
  assert.match(first, /CREATE EXTENSION IF NOT EXISTS pg_trgm/);
  assert.match(first, /'employee_pay_components'/);
  assert.match(first, /'pay_run_adjustments'/);
  assert.match(first, /'payroll_opening_balances'/);
  assert.match(first, /'union_fringes'/);
  assert.match(first, /SELECT public\.openbooks_refresh_query_catalog\(\);/);
  assert.doesNotMatch(first, /\\restrict|\\unrestrict/);
  assert.doesNotMatch(first, /CREATE SCHEMA public/);
  assert.doesNotMatch(first, /SET row_security = off/);
  assert.ok(first.endsWith("\n"));
});

test("canonical dump requires the pinned deterministic pg_dump source", () => {
  assert.throws(
    () => canonicalizePgDump(syntheticDump().replaceAll("16.9", "16.14")),
    /pinned PostgreSQL 16\.9/,
  );
});

test("canonical dump rejects auth query exposure", () => {
  assert.throws(
    () => canonicalizePgDump(syntheticDump().replace("'dunning_log'", "'auth_sessions', 'dunning_log'")),
    /authentication tables/,
  );
});

test("canonical dump rejects a partial payroll query allowlist", () => {
  assert.throws(
    () => canonicalizePgDump(syntheticDump().replace("'dunning_log'", "'pay_runs', 'dunning_log'")),
    /partially reviewed/,
  );
});

test("canonical dump rejects environment-specific or data-bearing SQL", () => {
  for (const [sql, expected] of [
    ["GRANT SELECT ON public.orgs TO openbooks_app;", /runtime-role ACL/],
    ["ALTER TABLE public.orgs OWNER TO postgres;", /owner assignment/],
    ["CREATE TABLE public._applied_migrations (name text);", /migration ledger DDL/],
    ["INSERT INTO public.orgs VALUES ('00000000-0000-0000-0000-000000000000');", /data statement/],
  ] as const) {
    assert.throws(() => canonicalizePgDump(syntheticDump(sql)), expected);
  }
});
