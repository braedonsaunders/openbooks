#!/usr/bin/env node
/**
 * RLS bypass-predicate gate (RELEASE BLOCKER RLS-GUC-ESCALATION): tenant
 * policies must call public.app_bypass_rls_active() instead of trusting the
 * raw app.bypass_rls GUC inline. Any SET on the runtime pool used to escalate
 * across tenants; the predicate additionally requires a privileged login, so
 * the raw read is the hole.
 *
 * Migration 0399 rewrote every existing policy at apply time, so generated
 * migrations at or below its ordinal are frozen history and out of scope
 * here. This gate is forward-looking: every NEWER generated migration, plus
 * the environments.sql backstop (which re-applies the org_isolation template
 * on every bootstrap), must not introduce an executable
 * current_setting('app.bypass_rls', ...) read. SQL comments are stripped
 * before matching, so prose naming the GUC does not count.
 *
 * Frozen history and shard-owned legacies above the cutoff are allowlisted
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

/** Ordinal of the predicate migration: generated files at or below are pre-predicate history. */
export const BYPASS_PREDICATE_CUTOFF_ORDINAL = 399

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
    const hits = findInlineBypassTrust(readFileSync(file, 'utf8'))
    if (hits.length === 0) continue
    if (INLINE_BYPASS_GUC_ALLOWLIST.has(basename)) {
      seenAllowlisted.add(basename)
      continue
    }
    violations.push(`${file}:${hits.join(',')}`)
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
