#!/usr/bin/env node
/**
 * Every tenant (org-owned) table a migration creates must be classified in
 * engine/src/sandbox/tenant-table-policies.ts. Sandbox clone, refresh, promote
 * and backup build their catalog from that map and refuse to run when a
 * tenant table is unclassified: an omission there broke every sandbox test
 * three times on 2026-09-24 (0355, 0359, 0362), and it was only found by the
 * database partition in CI. This check reads the migrations statically,
 * with no database, so it runs in every landing gate.
 *
 *   node scripts/check-tenant-table-policies.mjs
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const root = '.'
const dirs = ['schema/migrations', 'schema/migrations/generated']
const files = dirs.flatMap((d) => { try { return readdirSync(join(root, d)).filter((f) => f.endsWith('.sql')).map((f) => join(root, d, f)) } catch { return [] } }).sort((a, b) => a.split('/').pop().localeCompare(b.split('/').pop()))
const tables = new Map()
for (const f of files) {
  const sql = readFileSync(f, 'utf8')
  for (const m of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?"?([a-z0-9_]+)"?\s*\(([\s\S]*?)\n\);/gi)) tables.set(m[1], /\borg_id\b/.test(m[2]))
  for (const m of sql.matchAll(/ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(?:public\.)?"?([a-z0-9_]+)"? RENAME TO "?([a-z0-9_]+)"?/gi)) { if (tables.has(m[1])) { tables.set(m[2], tables.get(m[1])); tables.delete(m[1]) } }
  for (const m of sql.matchAll(/ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(?:public\.)?"?([a-z0-9_]+)"? ADD COLUMN (?:IF NOT EXISTS )?org_id\b/gi)) if (tables.has(m[1])) tables.set(m[1], true)
  for (const m of sql.matchAll(/DROP TABLE (?:IF EXISTS )?(?:public\.)?"?([a-z0-9_]+)"?/gi)) tables.delete(m[1])
}
const policy = new Set([...readFileSync(join(root, 'engine/src/sandbox/tenant-table-policies.ts'), 'utf8').matchAll(/^\s+"([a-z0-9_]+)":\s*"/gm)].map((m) => m[1]))
const missing = [...tables].filter(([t, org]) => org && !policy.has(t)).map(([t]) => t).sort()
// catalog.ts keeps two hand lists the policies must agree with, and the clone
// refuses at runtime when they drift (storage_cleanup_outbox, 2026-09-25, found
// only by CI's restore drill): every skip:no-copy table is in EXCLUDE, and every
// clone:parent-filter table has a PARENT_FILTER entry. Compare them here too.
const policies = new Map([...readFileSync(join(root, 'engine/src/sandbox/tenant-table-policies.ts'), 'utf8').matchAll(/^\s+"([a-z0-9_]+)":\s*"([^"]+)"/gm)].map((m) => [m[1], m[2]]))
const catalog = readFileSync(join(root, 'engine/src/sandbox/catalog.ts'), 'utf8').replace(/^\s*\/\/.*$/gm, '')
const block = (start, end) => { const a = catalog.indexOf(start); return a < 0 ? '' : catalog.slice(a + start.length, catalog.indexOf(end, a)) }
const exclude = new Set([...block('export const EXCLUDE = new Set([', ']);').matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]))
const parentFilter = new Set([...block('export const PARENT_FILTER', '\n};').matchAll(/^\s+"?([a-z0-9_]+)"?:/gm)].map((m) => m[1]))
const drift = [...policies].flatMap(([t, p]) => [
  ...((p === 'skip:no-copy') !== exclude.has(t) ? [`${t} (${p}${exclude.has(t) ? ', in EXCLUDE' : ', missing from EXCLUDE in engine/src/sandbox/catalog.ts'})`] : []),
  ...((p === 'clone:parent-filter') !== parentFilter.has(t) ? [`${t} (${p}${parentFilter.has(t) ? ', has a PARENT_FILTER entry' : ', missing from PARENT_FILTER'})`] : []),
])
console.log(`checked tenant table policies; tables=${tables.size} org-owned=${[...tables.values()].filter(Boolean).length} policies=${policy.size} missing=${missing.length} catalog-drift=${drift.length}`)
if (missing.length) { console.error(`unclassified tenant tables (add to engine/src/sandbox/tenant-table-policies.ts): ${missing.join(', ')}`); process.exitCode = 1 }
if (drift.length) { console.error(`tenant table policies disagree with the sandbox catalog: ${drift.join('; ')}`); process.exitCode = 1 }
