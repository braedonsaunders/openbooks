/**
 * Penny-parity harness for project financials. Computes resolveProjectFinancials
 * per job and diffs each measure against ground-truth targets from the NetSuite
 * RESTlet (bit_projectCost_RL) / adminapp JobCostBilled. Run:
 *   NODE_OPTIONS="--conditions=react-server" npx tsx engine/src/sync/project-financials-verify.ts
 *   ... --targets targets.json   (map of nsId -> { measure: value })
 *   ... --job 6089               (show one job's measures)
 *
 * Ground truth for job 6089 (M23-BCC-1509) validated earlier this project:
 *   invoiced $6,206,001.04 · actual cost $6,320,076.85 · open-PO $24,316.85.
 */
import { readFileSync } from 'node:fs'
import { db } from '../db.ts'
import { sql } from 'drizzle-orm'
import { resolveProjectFinancials } from '../../../web/lib/project-financials.ts'
import { loadProjectType } from '../../../web/lib/project-type.ts'

const CENT = 0.005
const f = (v: number) => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Known RESTlet targets keyed by NetSuite job internal id. Extend / override
 *  with --targets <file.json>. */
const KNOWN_TARGETS: Record<string, Record<string, number>> = {
  '6089': { invoiced_to_date: 6206001.04, actual_cost: 6320076.85, committed_cost: 24316.85 },
}

async function measuresForNsId(nsId: string) {
  const p = (await db.execute(sql`select id, org_id, code, name from projects where custom->>'nsId' = ${nsId} limit 1`)) as unknown as { rows: { id: string; org_id: string; code: string; name: string }[] }
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
    for (const [k, v] of Object.entries(r.measures)) console.log(`  ${k.padEnd(18)} ${k === 'margin_pct' ? v.toFixed(2) + '%' : f(v)}`)
    process.exit(0)
  }

  let pass = 0, fail = 0
  for (const [nsId, want] of Object.entries(targets)) {
    const r = await measuresForNsId(nsId)
    if (!r) { console.log(`job ${nsId}: NOT FOUND`); fail++; continue }
    const diffs: string[] = []
    for (const [measure, target] of Object.entries(want)) {
      const got = r.measures[measure] ?? 0
      const d = Math.abs(got - target)
      if (d > CENT) diffs.push(`${measure}: got ${f(got)} want ${f(target)} (Δ ${f(got - target)})`)
    }
    if (diffs.length === 0) { console.log(`✓ job ${nsId} (${r.project.code}) — ${Object.keys(want).length} measures penny-exact`); pass++ }
    else { console.log(`✗ job ${nsId} (${r.project.code}):`); for (const d of diffs) console.log('    ' + d); fail++ }
  }
  console.log(`\n${pass} passed, ${fail} failed across ${Object.keys(targets).length} jobs`)
  process.exit(fail > 0 ? 1 : 0)
}

main()
