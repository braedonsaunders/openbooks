/**
 * Penny-parity harness for project financials. Computes resolveProjectFinancials
 * per project and diffs each measure against ground-truth targets exported from
 * whatever system is being migrated from. Run:
 *   NODE_OPTIONS="--conditions=react-server" npx tsx engine/src/sync/project-financials-verify.ts
 *   ... --targets targets.json   (map of source id -> { measure: value })
 *   ... --job <sourceId>         (show one project's measures)
 */
import { readFileSync } from 'node:fs'
import { db } from '../db.ts'
import { sql } from 'drizzle-orm'
import { resolveProjectFinancials } from '../project-financials.ts'
import { loadProjectType } from '../project-type.ts'
import { abs, add, cmp, formatMoney, neg } from '../money.ts'

const CENT = '0.0050'
const f = (v: string | number) => '$' + Number(formatMoney(v, 2)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Known RESTlet targets keyed by NetSuite job internal id. Extend / override
 *  with --targets <file.json>. */
const KNOWN_TARGETS: Record<string, Record<string, number>> = {
  '6089': { invoiced_to_date: 6206001.04, actual_cost: 6320076.85, committed_cost: 24316.85 },
}

async function measuresForNsId(nsId: string) {
  const p = (await db.execute<{ id: string; org_id: string; code: string; name: string }>(sql`select id, org_id, code, name from projects where custom->>'nsId' = ${nsId} limit 1`))
  if (!p.rows[0]) return null
  const { id, org_id } = p.rows[0]
  const type = await loadProjectType(org_id, id)
  const fin = await resolveProjectFinancials(org_id, id, type.financialProfile)
  return { project: p.rows[0], type: type.key, measures: fin.measures }
}

async function main() {
  const args = process.argv.slice(2)
  const jobArg = args[args.indexOf('--job') + 1]
  const targetsArg = args.includes('--targets') ? args[args.indexOf('--targets') + 1] : null
  const targets: Record<string, Record<string, number>> = targetsArg
    ? { ...KNOWN_TARGETS, ...JSON.parse(readFileSync(targetsArg, 'utf8')) }
    : KNOWN_TARGETS

  if (jobArg && !args.includes('--targets')) {
    const r = await measuresForNsId(jobArg)
    if (!r) { console.log('job', jobArg, 'not found'); process.exit(1) }
    console.log(`job ${jobArg} — ${r.project.code} (${r.type})`)
    for (const [k, v] of Object.entries(r.measures)) console.log(`  ${k.padEnd(18)} ${k === 'margin_pct' ? Number(v).toFixed(2) + '%' : f(v)}`)
    process.exit(0)
  }

  let pass = 0, fail = 0
  for (const [nsId, want] of Object.entries(targets)) {
    const r = await measuresForNsId(nsId)
    if (!r) { console.log(`job ${nsId}: NOT FOUND`); fail++; continue }
    const diffs: string[] = []
    for (const [measure, target] of Object.entries(want)) {
      const got = String(r.measures[measure] ?? '0')
      const difference = add(got, neg(String(target)))
      if (cmp(abs(difference), CENT) > 0) diffs.push(`${measure}: got ${f(got)} want ${f(target)} (Δ ${f(difference)})`)
    }
    if (diffs.length === 0) { console.log(`✓ job ${nsId} (${r.project.code}) — ${Object.keys(want).length} measures penny-exact`); pass++ }
    else { console.log(`✗ job ${nsId} (${r.project.code}):`); for (const d of diffs) console.log('    ' + d); fail++ }
  }
  console.log(`\n${pass} passed, ${fail} failed across ${Object.keys(targets).length} jobs`)
  process.exit(fail > 0 ? 1 : 0)
}

main()
