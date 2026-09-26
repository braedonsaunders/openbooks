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
 * Frozen history and team-owned legacies above the cutoff are allowlisted
 * by basename with the reason each may keep its read; the list may only
 * shrink. A stale entry (a path that no longer reads the GUC) fails the
 * gate, so a rework that removes the read must also remove the entry.
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
 * Basename allowlist: gated files (above the cutoff) that may still read the
 * raw GUC, and why. Empty today: 0399 (the rewriter, whose regex and
 * assertion name the pattern) and 0316 (the legacy authority conjunct) are
 * at/below the cutoff and therefore unscanned. 0401 (arch-ledger) must add
 * its basename here if it keeps any raw read alongside the predicate call.
 */
export const INLINE_BYPASS_GUC_ALLOWLIST = new Map([])

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

export function auditBypassPredicate(files = SCAN_FILES) {
  const violations = []
  const stale = []
  const seenAllowlisted = new Set()
  let gated = 0
  for (const file of files) {
    if (!isGatedFile(file)) continue
    gated += 1
    const basename = file.split('/').pop()
    const content = readFileSync(file, 'utf8')
    const hits = findInlineBypassTrust(content)
    if (hits.length === 0 && !hasInlineBypassTrust(content)) continue
    if (INLINE_BYPASS_GUC_ALLOWLIST.has(basename)) {
      seenAllowlisted.add(basename)
      continue
    }
    violations.push(hits.length > 0 ? `${file}:${hits.join(',')}` : `${file}:multiline`)
  }
  for (const basename of INLINE_BYPASS_GUC_ALLOWLIST.keys()) {
    if (!seenAllowlisted.has(basename)) stale.push(basename)
  }
  return { violations, stale, gated }
}

function main() {
  const { violations, stale, gated } = auditBypassPredicate()
  console.log(
    `checked RLS bypass predicate; gated-files=${gated} violations=${violations.length} stale-allowlist=${stale.length}`,
  )
  if (violations.length) {
    console.error(
      `new inline app.bypass_rls trust (call public.app_bypass_rls_active() instead): ${violations.join(' ')}`,
    )
    process.exitCode = 1
  }
  if (stale.length) {
    console.error(`stale bypass-predicate allowlist (remove the entry): ${stale.join(', ')}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
