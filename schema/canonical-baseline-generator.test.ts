import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizePgDump,
  extractHandwrittenAnnotations,
} from "../scripts/regenerate-canonical-baseline.mjs";

/**
 * Every relation that can hold a secret is rebuilt from an explicit column
 * list, so the fixture has to carry those curated views: the generator refuses
 * a dump where a curated name is missing, widened to `select *`, or moved into
 * the generic allowlist. `employee_payroll_profiles` is the one that actually
 * regressed — it holds `sin_encrypted`.
 */
const curatedViews = `  create view openbooks_query.parties with (security_barrier=true) as
    select id, org_id, display_name
      from public.parties
     where org_id = public.openbooks_query_org_id();
  create view openbooks_query.party_bank_accounts with (security_barrier=true) as
    select id, org_id, bank_name, account_last_four
      from public.party_bank_accounts
     where org_id = public.openbooks_query_org_id();
  create view openbooks_query.vendor_roles with (security_barrier=true) as
    select id, org_id, party_id, tin_last4
      from public.vendor_roles
     where org_id = public.openbooks_query_org_id();
  create view openbooks_query.employee_payroll_profiles with (security_barrier=true) as
    select id, org_id, employee_party_id, sin_last3
      from public.employee_payroll_profiles
     where org_id = public.openbooks_query_org_id();
  create view openbooks_query.employee_roles with (security_barrier=true) as
    select id, org_id, party_id, employee_number
      from public.employee_roles
     where org_id = public.openbooks_query_org_id();`;

const queryFunction = `CREATE FUNCTION public.openbooks_refresh_query_catalog() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $_$
declare
  safe_relations constant text[] := array[
    'dunning_log', 'party_subsidiaries', 'pay_application_lines',
    'pay_applications', 'transfer_order_lines', 'transfer_orders',
    'vendor_pay_application_lines'
  ];
begin
${curatedViews}
end
$_$;`;

function syntheticDump(extra = "", fn = queryFunction) {
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


${fn}

--
-- Name: orgs; Type: TABLE; Schema: public; Owner: -
--

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
  assert.match(first, /'payroll_filing_accounts'/);
  assert.match(first, /'payroll_holidays'/);
  assert.match(first, /'payroll_opening_balances'/);
  assert.match(first, /'union_fringes'/);
  assert.match(first, /SELECT public\.openbooks_refresh_query_catalog\(\);/);
  assert.doesNotMatch(first, /\\restrict|\\unrestrict/);
  assert.doesNotMatch(first, /CREATE SCHEMA public/);
  assert.doesNotMatch(first, /SET row_security = off/);
  assert.ok(first.endsWith("\n"));
});

test("restoring payroll relations never adds a curated relation to the generic allowlist", () => {
  // employee_payroll_profiles holds sin_encrypted. The restore path used to
  // list it alongside the generic payroll relations, which would have put the
  // sealed SIN back on the `select *` path the curation removed it from.
  const allowlist = canonicalizePgDump(syntheticDump()).match(
    /safe_relations constant text\[\] := array\[([\s\S]*?)\n  \];/,
  )?.[1];
  assert.ok(allowlist);
  assert.doesNotMatch(allowlist, /'employee_payroll_profiles'/);
  assert.match(allowlist, /'employee_pay_components'/);
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

test("canonical dump rejects a curated relation on the generic allowlist", () => {
  assert.throws(
    () => canonicalizePgDump(
      syntheticDump().replace("'dunning_log'", "'dunning_log', 'employee_payroll_profiles'"),
    ),
    /curated query relation must not take the generic select \* path: employee_payroll_profiles/,
  );
});

test("canonical dump rejects a curated view widened back to select *", () => {
  const widened = queryFunction.replace(
    "    select id, org_id, employee_party_id, sin_last3\n      from public.employee_payroll_profiles",
    "    select *\n      from public.employee_payroll_profiles",
  );
  assert.throws(
    () => canonicalizePgDump(syntheticDump("", widened)),
    /rebuilt with select \*: employee_payroll_profiles/,
  );
});

test("canonical dump rejects a curated view that names a secret column", () => {
  const leaking = queryFunction.replace(
    "select id, org_id, employee_party_id, sin_last3",
    "select id, org_id, employee_party_id, sin_last3, sin_encrypted",
  );
  assert.throws(
    () => canonicalizePgDump(syntheticDump("", leaking)),
    /exposes a secret column: employee_payroll_profiles\.sin_encrypted/,
  );
});

test("canonical dump rejects a curated relation with no explicit view at all", () => {
  const dropped = queryFunction.replace(
    /  create view openbooks_query\.employee_payroll_profiles[\s\S]*?;\n/,
    "",
  );
  assert.throws(
    () => canonicalizePgDump(syntheticDump("", dropped)),
    /no explicit view: employee_payroll_profiles/,
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

test("hand-written prose survives a regeneration", () => {
  // pg_dump cannot emit the design-rationale blocks the baseline carries, so
  // they are lifted off the previous file and re-anchored on the same headers.
  // Without this the round trip silently deletes documentation.
  const previous = canonicalizePgDump(syntheticDump()).replace(
    "--\n-- Name: orgs; Type: TABLE; Schema: public; Owner: -\n--\n\n",
    "--\n-- Name: orgs; Type: TABLE; Schema: public; Owner: -\n--\n-- The tenant root.\n--\n\n",
  );

  const annotations = extractHandwrittenAnnotations(previous);
  assert.deepEqual(
    [...annotations.keys()],
    ["orgs; Type: TABLE; Schema: public; Owner: -"],
  );

  const regenerated = canonicalizePgDump(syntheticDump(), { annotations });
  assert.equal(regenerated, previous);
  assert.equal(canonicalizePgDump(syntheticDump(), { annotations }), regenerated);
});

test("hand-written prose is never silently dropped when its object disappears", () => {
  const annotations = new Map([
    ["retired_table; Type: TABLE; Schema: public; Owner: -", "-- Gone.\n"],
  ]);
  assert.throws(
    () => canonicalizePgDump(syntheticDump(), { annotations }),
    /no object in this dump[\s\S]*retired_table/,
  );
});

test("prose is restored after the content guards, so it cannot satisfy one", () => {
  // A required marker written only in a comment must not pass the check.
  const annotations = new Map([
    [
      "orgs; Type: TABLE; Schema: public; Owner: -",
      "-- Mentions TABLESPACE and GRANT SELECT ... TO openbooks_app in prose.\n",
    ],
  ]);
  const regenerated = canonicalizePgDump(syntheticDump(), { annotations });
  assert.match(regenerated, /-- Mentions TABLESPACE and GRANT SELECT/);
});
