import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INLINE_BYPASS_GUC,
  INLINE_BYPASS_GUC_SUPERSEDED,
  RELEASE_SCAN_FILES,
  auditBypassPredicate,
  findInlineBypassTrust,
  hasInlineBypassTrust,
} from "./check-rls-bypass-predicate.mjs";

/**
 * The gate is the only thing stopping a migration from reintroducing raw
 * bypass-GUC trust, so a wrong decision here fails silently in the dangerous
 * direction. These tests pin both edges: every known spelling fails, while
 * comments, the predicate call and its own definition, and other GUCs pass.
 */

test("every spelling fails in policy and body position", () => {
  for (const spelling of [
    `USING ((current_setting('app.bypass_rls'::text, true) = 'on'::text)`,
    `USING ((current_setting('app.bypass_rls', true) = 'on')`,
    `USING ((current_setting('app.bypass_rls',true)='on')`,
    `and coalesce(current_setting('app.bypass_rls', true), 'off') = 'on'`,
    `  if current_setting('app.bypass_rls', true) = 'on' then`,
    `       OR current_setting('app.bypass_rls', true) = 'on' THEN`,
  ]) {
    assert.deepEqual(findInlineBypassTrust(spelling), [1]);
  }
  assert.ok(INLINE_BYPASS_GUC.test(`current_setting(\n  'app.bypass_rls', true)`));
  // A body that wraps the read across lines has no single offending line,
  // so the whole-content match must still catch it.
  const wrapped = `IF OLD.expires_at <= now()\n   OR current_setting(\n     'app.bypass_rls', true) = 'on' THEN`;
  assert.deepEqual(findInlineBypassTrust(wrapped), []);
  assert.equal(hasInlineBypassTrust(wrapped), true);
  assert.equal(hasInlineBypassTrust(`IF public.app_bypass_rls_active() THEN`), false);
});

test("comments, the predicate call, and other GUCs pass", () => {
  for (const clean of [
    `-- current_setting('app.bypass_rls', true) = 'on'`,
    `public.app_bypass_rls_active()`,
    `app_bypass_rls_active() OR ((org_id)::text = x)`,
    `org_id::text = current_setting('app.current_org', true)`,
    `select set_config('app.bypass_rls', 'on', false)`,
  ]) {
    assert.deepEqual(findInlineBypassTrust(clean), []);
  }
});

test("only the predicate definition itself may read the raw GUC", () => {
  const definition = [
    "CREATE FUNCTION public.app_bypass_rls_active() RETURNS boolean",
    "    LANGUAGE sql STABLE",
    "    SET search_path TO 'pg_catalog'",
    "    AS $$",
    "  SELECT current_setting('app.bypass_rls', true) = 'on'",
    "     AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = session_user AND rolbypassrls)",
    "$$;",
  ].join("\n");
  assert.deepEqual(findInlineBypassTrust(definition), []);
  assert.equal(
    hasInlineBypassTrust(definition.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION")),
    false,
  );
  // The exemption ends at the definition's closing quote: a raw read in a
  // following statement is still reported at its own line.
  const followed = `${definition}\nCREATE POLICY org_isolation ON public.t\n  USING (current_setting('app.bypass_rls', true) = 'on');\n`;
  assert.deepEqual(findInlineBypassTrust(followed), [9]);
  // A differently named function gets no exemption.
  assert.deepEqual(
    findInlineBypassTrust(definition.replace("app_bypass_rls_active", "app_bypass_rls_raw")),
    [5],
  );
});

test("the release schema is scanned and trusts only the predicate", () => {
  const baseline = RELEASE_SCAN_FILES.find((file) => file.includes("/baselines/"));
  assert.ok(baseline, "release baseline is not scanned");
  // The baseline defines the predicate, so its raw text does read the GUC;
  // the scan passing therefore proves the exemption, not an empty corpus.
  assert.match(readFileSync(baseline, "utf8"), INLINE_BYPASS_GUC);
  const { violations, scanned } = auditBypassPredicate();
  assert.equal(scanned, RELEASE_SCAN_FILES.length + 1);
  assert.deepEqual(violations, []);
});

test("a superseded raw read passes only when the named later migration drops the policy", () => {
  const dir = mkdtempSync(join(tmpdir(), "bypass-supersede-"));
  try {
    const legacy = join(dir, "0450_legacy_policy.sql");
    writeFileSync(
      legacy,
      `CREATE POLICY tenant_isolation ON public.t\n  USING (current_setting('app.bypass_rls', true) = 'on');\n`,
    );
    const later = join(dir, "0460_replace_policy.sql");
    const claim = { by: "0460_replace_policy.sql", policies: [["tenant_isolation", "t"]] };
    const audit = () =>
      auditBypassPredicate([legacy, later], new Map([["0450_legacy_policy.sql", claim]]));

    writeFileSync(later, `DROP POLICY IF EXISTS tenant_isolation ON public.t;\n`);
    assert.deepEqual(audit(), { violations: [], stale: [], unproven: [], scanned: 2 });

    // A later file that never drops the named policy proves nothing.
    writeFileSync(
      later,
      `-- DROP POLICY IF EXISTS tenant_isolation ON public.t;\nDROP POLICY IF EXISTS org_isolation ON public.t;\n`,
    );
    assert.deepEqual(audit().unproven, [
      "0450_legacy_policy.sql: 0460_replace_policy.sql does not drop tenant_isolation on t",
    ]);

    // Nor does a claim naming a migration that does not exist.
    const missing = auditBypassPredicate([legacy], new Map([["0450_legacy_policy.sql", claim]]));
    assert.deepEqual(missing.unproven, [
      "0450_legacy_policy.sql: superseding migration 0460_replace_policy.sql does not exist",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every repository supersession names a later migration that drops each policy", () => {
  assert.ok(INLINE_BYPASS_GUC_SUPERSEDED instanceof Map);
  const { unproven, stale } = auditBypassPredicate();
  assert.deepEqual(unproven, []);
  assert.deepEqual(stale, []);
});

test("a migration with line and wrapped reads fails with locations", () => {
  const dir = mkdtempSync(join(tmpdir(), "bypass-gate-"));
  try {
    const lined = join(dir, "0003_fake_new_policy.sql");
    writeFileSync(
      lined,
      `CREATE POLICY org_isolation ON public.t\n  USING ((current_setting('app.bypass_rls'::text, true) = 'on'::text));\n`,
    );
    const wrapped = join(dir, "0004_fake_new_guard.sql");
    writeFileSync(
      wrapped,
      `CREATE FUNCTION public.t_guard() RETURNS trigger LANGUAGE plpgsql AS $$\nBEGIN\n  IF current_setting(\n       'app.bypass_rls', true) = 'on' THEN\n    RETURN NEW;\n  END IF;\nEND;\n$$;\n`,
    );
    const clean = join(dir, "0005_fake_predicate_policy.sql");
    writeFileSync(
      clean,
      `CREATE POLICY org_isolation ON public.t\n  USING ((public.app_bypass_rls_active()));\n`,
    );
    const { violations } = auditBypassPredicate([lined, wrapped, clean]);
    assert.deepEqual(violations, [`${lined}:2`, `${wrapped}:multiline`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
