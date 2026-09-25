import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BYPASS_PREDICATE_CUTOFF_ORDINAL,
  INLINE_BYPASS_GUC,
  INLINE_BYPASS_GUC_ALLOWLIST,
  auditBypassPredicate,
  findInlineBypassTrust,
  hasInlineBypassTrust,
  isGatedFile,
} from './check-rls-bypass-predicate.mjs'

/**
 * The gate is the only thing stopping a new migration from reintroducing the
 * hole 0399/0402 closed, so a wrong decision here fails silently in the
 * dangerous direction. These tests pin both edges: every known spelling
 * fails, while comments, the predicate call, other GUCs, and pre-cutoff
 * history pass.
 */

test('every spelling fails in policy and body position', () => {
  for (const spelling of [
    `USING ((current_setting('app.bypass_rls'::text, true) = 'on'::text)`,
    `USING ((current_setting('app.bypass_rls', true) = 'on')`,
    `USING ((current_setting('app.bypass_rls',true)='on')`,
    `and coalesce(current_setting('app.bypass_rls', true), 'off') = 'on'`,
    `  if current_setting('app.bypass_rls', true) = 'on' then`,
    `       OR current_setting('app.bypass_rls', true) = 'on' THEN`,
  ]) {
    assert.deepEqual(findInlineBypassTrust(spelling), [1])
  }
  assert.ok(INLINE_BYPASS_GUC.test(`current_setting(\n  'app.bypass_rls', true)`))
  // A body that wraps the read across lines has no single offending line,
  // so the whole-content match must still catch it.
  const wrapped = `IF OLD.expires_at <= now()\n   OR current_setting(\n     'app.bypass_rls', true) = 'on' THEN`
  assert.deepEqual(findInlineBypassTrust(wrapped), [])
  assert.equal(hasInlineBypassTrust(wrapped), true)
  assert.equal(hasInlineBypassTrust(`IF public.app_bypass_rls_active() THEN`), false)
})

test('comments, the predicate call, and other GUCs pass', () => {
  for (const clean of [
    `-- current_setting('app.bypass_rls', true) = 'on'`,
    `public.app_bypass_rls_active()`,
    `app_bypass_rls_active() OR ((org_id)::text = x)`,
    `org_id::text = current_setting('app.current_org', true)`,
    `select set_config('app.bypass_rls', 'on', false)`,
  ]) {
    assert.deepEqual(findInlineBypassTrust(clean), [])
  }
})

test('only post-cutoff migrations and the backstop are gated; the allowlist starts empty', () => {
  assert.equal(BYPASS_PREDICATE_CUTOFF_ORDINAL, 402)
  assert.equal(isGatedFile('schema/migrations/environments.sql'), true)
  assert.equal(isGatedFile('schema/migrations/generated/0403_next_policy.sql'), true)
  for (const history of [
    'schema/migrations/generated/0399_rls_bypass_role_predicate.sql',
    'schema/migrations/generated/0402_rls_bypass_trigger_bodies.sql',
    'schema/migrations/generated/0351_sandbox_org_owner_rls.sql',
    'schema/migrations/generated/0316_clone_closed_period_authority.sql',
  ]) {
    assert.equal(isGatedFile(history), false)
  }
  // Pre-cutoff legacies are unscanned, not exempt: gating them would make
  // the entries permanently stale.
  assert.deepEqual([...INLINE_BYPASS_GUC_ALLOWLIST.keys()], [])
})

test('a post-cutoff file with line and wrapped reads fails with locations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bypass-gate-'))
  try {
    const lined = join(dir, '0403_fake_new_policy.sql')
    writeFileSync(
      lined,
      `CREATE POLICY org_isolation ON public.t\n  USING ((current_setting('app.bypass_rls'::text, true) = 'on'::text));\n`,
    )
    const wrapped = join(dir, '0403_fake_new_guard.sql')
    writeFileSync(
      wrapped,
      `CREATE FUNCTION public.t_guard() RETURNS trigger LANGUAGE plpgsql AS $$\nBEGIN\n  IF current_setting(\n       'app.bypass_rls', true) = 'on' THEN\n    RETURN NEW;\n  END IF;\nEND;\n$$;\n`,
    )
    const clean = join(dir, '0404_fake_predicate_policy.sql')
    writeFileSync(clean, `CREATE POLICY org_isolation ON public.t\n  USING ((public.app_bypass_rls_active()));\n`)
    const history = join(dir, '0351_sandbox_org_owner_rls.sql')
    writeFileSync(history, `USING ((current_setting('app.bypass_rls', true) = 'on')\n`)
    const { violations } = auditBypassPredicate([lined, wrapped, clean, history])
    assert.deepEqual(violations, [`${lined}:2`, `${wrapped}:multiline`])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
