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
  isGatedFile,
} from './check-rls-bypass-predicate.mjs'

/**
 * The bypass-predicate gate is the only thing stopping a new migration from
 * reintroducing the exact hole 0399 closed, so a wrong decision here fails
 * silently in the dangerous direction: too loose and inline GUC trust lands
 * with a green gate; too strict and every migration author learns to work
 * around it.
 *
 * These tests pin both edges: every known spelling of the trust read fails
 * the audit on a post-cutoff file, while comments, the predicate call
 * itself, tenant-GUC reads, and pre-predicate history pass.
 */

test('every spelling of the inline trust read is detected', () => {
  assert.deepEqual(findInlineBypassTrust(`USING ((current_setting('app.bypass_rls'::text, true) = 'on'::text)`), [1])
  assert.deepEqual(findInlineBypassTrust(`USING ((current_setting('app.bypass_rls', true) = 'on')`), [1])
  assert.deepEqual(findInlineBypassTrust(`USING ((current_setting('app.bypass_rls',true)='on')`), [1])
  assert.deepEqual(
    findInlineBypassTrust(`and coalesce(current_setting('app.bypass_rls', true), 'off') = 'on'`),
    [1],
  )
  assert.ok(INLINE_BYPASS_GUC.test(`current_setting(\n  'app.bypass_rls', true)`))
})

test('comments, the predicate call, and other GUCs pass', () => {
  assert.deepEqual(findInlineBypassTrust(`-- current_setting('app.bypass_rls', true) = 'on'`), [])
  assert.deepEqual(findInlineBypassTrust(`public.app_bypass_rls_active()`), [])
  assert.deepEqual(findInlineBypassTrust(`app_bypass_rls_active() OR ((org_id)::text = x)`), [])
  assert.deepEqual(
    findInlineBypassTrust(`org_id::text = current_setting('app.current_org', true)`),
    [],
  )
  assert.deepEqual(findInlineBypassTrust(`select set_config('app.bypass_rls', 'on', false)`), [])
})

test('only post-cutoff migrations and the backstop are gated', () => {
  assert.equal(BYPASS_PREDICATE_CUTOFF_ORDINAL, 399)
  assert.equal(isGatedFile('schema/migrations/environments.sql'), true)
  assert.equal(isGatedFile('schema/migrations/generated/0399_rls_bypass_role_predicate.sql'), false)
  assert.equal(isGatedFile('schema/migrations/generated/0351_sandbox_org_owner_rls.sql'), false)
  assert.equal(isGatedFile('schema/migrations/generated/0401_clone_authority_roles.sql'), true)
})

test('a post-cutoff file with inline trust fails the audit at its line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bypass-gate-'))
  try {
    const offender = join(dir, '0400_fake_new_policy.sql')
    writeFileSync(
      offender,
      `CREATE POLICY org_isolation ON public.t\n  USING ((current_setting('app.bypass_rls'::text, true) = 'on'::text));\n`,
    )
    const clean = join(dir, '0401_fake_predicate_policy.sql')
    writeFileSync(clean, `CREATE POLICY org_isolation ON public.t\n  USING ((public.app_bypass_rls_active()));\n`)
    const history = join(dir, '0351_sandbox_org_owner_rls.sql')
    writeFileSync(history, `USING ((current_setting('app.bypass_rls', true) = 'on')\n`)
    const { violations } = auditBypassPredicate([offender, clean, history])
    assert.deepEqual(violations, [`${offender}:2`])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the allowlist starts empty: pre-cutoff legacies are unscanned, not exempt', () => {
  assert.deepEqual([...INLINE_BYPASS_GUC_ALLOWLIST.keys()], [])
  // 0399 and 0316 keep raw reads but sit at/below the cutoff, so they never
  // reach the allowlist; gating them would make the entries permanently stale.
  assert.equal(isGatedFile('schema/migrations/generated/0399_rls_bypass_role_predicate.sql'), false)
  assert.equal(isGatedFile('schema/migrations/generated/0316_clone_closed_period_authority.sql'), false)
})
