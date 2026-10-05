#!/usr/bin/env node
/**
 * RLS bypass-predicate gate (RELEASE BLOCKER RLS-GUC-ESCALATION, extended by
 * RLS-GUC-TRIGGERS/0402): tenant policies AND function/trigger bodies must
 * call public.app_bypass_rls_active() instead of trusting the raw
 * app.bypass_rls GUC inline. Any SET on the runtime pool used to escalate
 * across tenants; the predicate additionally requires a privileged login, so
 * the raw read is the hole.
 *
 * Migration 0399 rewrote every existing policy at apply time and 0402
 * rewrote every existing function/trigger body, so generated migrations at
 * or below the 0402 ordinal are frozen history and out of scope here. This
 * gate is forward-looking: every NEWER generated migration, plus the
 * environments.sql backstop (which re-applies the org_isolation template
 * on every bootstrap), must not introduce an executable
 * current_setting('app.bypass_rls', ...) read — in a policy expression or
 * in a function/trigger body. SQL comments are stripped before matching, so
 * prose naming the GUC does not count. Bodies wrap lines where policy
 * expressions did not, so matching runs over both individual lines (for
 * precise locations) and the whole file (for reads split across lines).
 *
 * A gated migration that still reads the raw GUC is accepted only when it is
 * SUPERSEDED: a named later migration drops each of its offending policies
 * (and any re-creation there goes through the predicate, which the scan of
 * that later file enforces). The gate reads the superseding file and refuses
 * when it is missing, is not later, or does not drop the policy — a
 * supersession claim is checked, never trusted. A stale entry (a path that no
 * longer reads the GUC) also fails, so the list can only shrink.
 *
 *   node scripts/check-rls-bypass-predicate.mjs
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { stripSqlComments } from './check-migration-headers.mjs'

const root = '.'

/**
 * Ordinal of the last rewriter migration (0402 bodies; 0399 policies):
 * generated files at or below are remediated at apply time by the chain, so
 * their inline reads are frozen history, not new trust.
 */
export const BYPASS_PREDICATE_CUTOFF_ORDINAL = 402

export function migrationOrdinal(basename) {
  const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(basename)
  return match ? Number(match[1]) : null
}

const SCAN_FILES = [
  join(root, 'schema', 'migrations', 'environments.sql'),
  ...readdirSync(join(root, 'schema', 'migrations', 'generated'))
    .filter((f) => f.endsWith('.sql'))
    .map((f) => join(root, 'schema', 'migrations', 'generated', f)),
]

/** An executable read of the raw bypass GUC (any spacing/cast spelling). */
export const INLINE_BYPASS_GUC = /current_setting\s*\(\s*'app\.bypass_rls'/

/**
 * Gated migrations whose raw reads live only in policies a later migration
 * replaced. Published migrations are immutable, so the fix for such a file is
 * a later migration, and this map names it together with every policy it must
 * drop: `policies` lists [policy, table] pairs.
 */
export const INLINE_BYPASS_GUC_SUPERSEDED = new Map([
  ['0489_pay_component_department_expenses.sql', {
    by: '0539_query_console_and_script_authority_hardening.sql',
    policies: [['tenant_isolation', 'pay_component_department_expenses']],
  }],
  ['0497_psp_automation.sql', {
    by: '0539_query_console_and_script_authority_hardening.sql',
    policies: [['org_isolation', 'payment_disputes']],
  }],
])

function dropsPolicy(content, policy, table) {
  return new RegExp(
    `drop\\s+policy\\s+(?:if\\s+exists\\s+)?"?${policy}"?\\s+on\\s+(?:only\\s+)?(?:"?public"?\\.)?"?${table}"?\\s*;`,
    'i',
  ).test(stripSqlComments(content))
}

/** Why a supersession claim does not hold, or null when the later migration proves it. */
export function supersessionFailure(basename, claim, files) {
  const superseder = files.find((file) => file.split('/').pop() === claim.by)
  if (!superseder) return `${basename}: superseding migration ${claim.by} does not exist`
  const ordinal = migrationOrdinal(basename)
  if (ordinal === null || (migrationOrdinal(claim.by) ?? -1) <= ordinal) {
    return `${basename}: ${claim.by} is not a later migration`
  }
  const content = readFileSync(superseder, 'utf8')
  const missing = claim.policies.filter(([policy, table]) => !dropsPolicy(content, policy, table))
  return missing.length
    ? `${basename}: ${claim.by} does not drop ${missing.map(([policy, table]) => `${policy} on ${table}`).join(', ')}`
    : null
}

/** Line numbers (1-based) of executable inline-GUC reads in comment-stripped SQL. */
export function findInlineBypassTrust(content) {
  const hits = []
  for (const [index, line] of stripSqlComments(content).split('\n').entries()) {
    if (INLINE_BYPASS_GUC.test(line)) hits.push(index + 1)
  }
  return hits
}

/**
 * Whole-content match for reads split across lines — function bodies wrap
 * where policy expressions did not. True when the comment-stripped content
 * holds an executable read anywhere, even if no single line does.
 */
export function hasInlineBypassTrust(content) {
  return INLINE_BYPASS_GUC.test(stripSqlComments(content))
}

/** Whether a scan file is post-predicate and therefore gated. */
export function isGatedFile(file) {
  const basename = file.split('/').pop()
  if (basename === 'environments.sql') return true
  const ordinal = migrationOrdinal(basename)
  return ordinal !== null && ordinal > BYPASS_PREDICATE_CUTOFF_ORDINAL
}

export function auditBypassPredicate(files = SCAN_FILES, superseded = INLINE_BYPASS_GUC_SUPERSEDED) {
  const violations = []
  const stale = []
  const unproven = []
  const seenAllowlisted = new Set()
  let gated = 0
  for (const file of files) {
    if (!isGatedFile(file)) continue
    gated += 1
    const basename = file.split('/').pop()
    const content = readFileSync(file, 'utf8')
    const hits = findInlineBypassTrust(content)
    if (hits.length === 0 && !hasInlineBypassTrust(content)) continue
    if (superseded.has(basename)) {
      seenAllowlisted.add(basename)
      const failure = supersessionFailure(basename, superseded.get(basename), files)
      if (failure) unproven.push(failure)
      continue
    }
    violations.push(hits.length > 0 ? `${file}:${hits.join(',')}` : `${file}:multiline`)
  }
  for (const basename of superseded.keys()) {
    if (!seenAllowlisted.has(basename)) stale.push(basename)
  }
  return { violations, stale, unproven, gated }
}

function main() {
  const { violations, stale, unproven, gated } = auditBypassPredicate()
  console.log(
    `checked RLS bypass predicate; gated-files=${gated} violations=${violations.length} stale-supersessions=${stale.length}`,
  )
  if (violations.length) {
    console.error(
      `new inline app.bypass_rls trust (call public.app_bypass_rls_active() instead): ${violations.join(' ')}`,
    )
    process.exitCode = 1
  }
  if (unproven.length) {
    console.error(`unproven bypass-predicate supersession (a later migration must drop the policy): ${unproven.join('; ')}`)
    process.exitCode = 1
  }
  if (stale.length) {
    console.error(`stale bypass-predicate supersession (remove the entry): ${stale.join(', ')}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
