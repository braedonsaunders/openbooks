/**
 * Gantry cashflow-config importer — pulls the saved configuration out of the
 * com.flux.gantry SuiteApp's custom record (customrecord_gantry_config,
 * name='cashflow') over the org's NetSuite connection and writes it into
 * orgs.settings.analytics: the seven forecast categories (NetSuite account /
 * vendor / bank ids remapped through the migration's custom.nsId references,
 * vendor CATEGORIES statically expanded to their member vendors via SuiteQL)
 * plus the AP scheduling knobs (weeklyCap -> weeklyApCap, restrictToSafe).
 *
 * Dry-runs by default; pass --apply to write. Non-portable Gantry settings
 * (preservationMode, vendor-category AP filters, category groups, top-level
 * bankAccountIds) are reported, never silently dropped.
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx engine/src/sync/gantry-config-cli.ts <orgId> --apply
 */
import { db } from '../db.ts'
import { sql } from 'drizzle-orm'
import { suiteql, type NetSuiteCreds } from '../netsuite.ts'
import { unsealJson } from '../secrets.ts'

const APPLY = process.argv.includes('--apply')
const org = process.argv.find((a) => !a.startsWith('-') && /^[0-9a-f-]{36}$/.test(a))
if (!org) {
  console.error('Usage: npx tsx engine/src/sync/gantry-config-cli.ts <orgId> [--apply]')
  process.exit(1)
}

// ---- creds + fetch ----
const row: any = await db.execute(sql`
  select config, secrets from connections where org_id=${org} and source='netsuite'
  order by status='active' desc, created_at desc limit 1`)
const conn = row.rows[0]
const secret = unsealJson<Partial<NetSuiteCreds>>(conn.secrets)!
const creds: NetSuiteCreds = { account: String(conn.config.account), host: String(conn.config.host), consumerKey: secret.consumerKey!, consumerSecret: secret.consumerSecret!, tokenKey: secret.tokenKey!, tokenSecret: secret.tokenSecret! }
const recs = await suiteql<{ id: string; name: string; json: string }>(
  `SELECT id, name, custrecord_gantry_config_json AS json FROM customrecord_gantry_config`, creds)
const cfg = JSON.parse(recs.find((r) => r.name === 'cashflow')!.json)

// ---- id maps (migration stored NetSuite ids in custom.nsId) ----
const acctRows: any = await db.execute(sql`
  select id, number, name, custom->>'nsId' as ns from accounts where org_id=${org} and custom->>'nsId' is not null`)
const acctByNs = new Map<string, { id: string; label: string }>(
  acctRows.rows.map((a: any) => [String(a.ns), { id: a.id, label: `${a.number ?? ''} ${a.name}`.trim() }]))
const partyRows: any = await db.execute(sql`
  select id, display_name as name, custom->>'nsId' as ns from parties where org_id=${org} and custom->>'nsId' is not null`)
const partyByNs = new Map<string, { id: string; name: string }>(
  partyRows.rows.map((p: any) => [String(p.ns), { id: p.id, name: p.name }]))

// ---- expand NetSuite vendor categories → member vendor ids ----
const catIds = new Set<string>()
for (const c of cfg.categories ?? []) for (const v of c.vendorCategories ?? []) catIds.add(String(v))
const vendorsByCategory = new Map<string, string[]>()
if (catIds.size) {
  const vend = await suiteql<{ id: string; category: string }>(
    `SELECT id, category FROM vendor WHERE category IN (${[...catIds].join(',')})`, creds)
  for (const v of vend) {
    const k = String(v.category)
    vendorsByCategory.set(k, [...(vendorsByCategory.get(k) ?? []), String(v.id)])
  }
}

const unmapped: string[] = []
const mapAccts = (ids: unknown[], ctx: string): string[] => {
  const out: string[] = []
  for (const raw of ids ?? []) {
    const hit = acctByNs.get(String(raw))
    if (hit) out.push(hit.id)
    else unmapped.push(`${ctx}: NS account ${raw}`)
  }
  return out
}
const mapVendors = (ids: unknown[], ctx: string): string[] => {
  const out: string[] = []
  for (const raw of ids ?? []) {
    const hit = partyByNs.get(String(raw))
    if (hit) out.push(hit.id)
    else unmapped.push(`${ctx}: NS vendor ${raw}`)
  }
  return out
}
const numOrUndef = (v: unknown) => (v === null || v === undefined || v === '' ? undefined : Number(v))

// ---- transform categories (Gantry keys → openbooks ForecastCategory) ----
const out: Record<string, unknown>[] = []
const notes: string[] = []
for (const c of cfg.categories ?? []) {
  const base: Record<string, unknown> = {
    id: c.id,
    name: c.name,
    direction: c.type === 'inflow' ? 'inflow' : 'outflow',
    method: c.method,
  }
  const day = numOrUndef(c.expectedDay)
  if (day !== undefined && Number.isInteger(day) && day >= 0 && day <= 6) base.expectedDay = day
  const wk = numOrUndef(c.expectedWeek)
  if (wk !== undefined && Number.isInteger(wk) && wk >= 1 && wk <= 4) base.expectedWeek = wk
  const adj = Number(c.adjustmentPercent ?? 0)
  if (adj) base.adjustmentPct = adj

  if (c.method === 'gl_history_average') {
    base.accountIds = mapAccts(c.accounts ?? c.accountIds ?? [], c.name)
    base.historyWeeks = numOrUndef(c.historyWeeks) ?? 12
    if (c.useNetAmt === true) base.useNetAmt = true
  } else if (c.method === 'vendor_payment_history' || c.method === 'vendor_recurring_average') {
    let nsVendors: string[] = (c.vendorIds ?? (c.vendorId ? [c.vendorId] : [])).map(String)
    for (const vc of c.vendorCategories ?? []) {
      const members = vendorsByCategory.get(String(vc)) ?? []
      if (!members.length) notes.push(`${c.name}: NS vendor category ${vc} has no members`)
      nsVendors = [...new Set([...nsVendors, ...members])]
    }
    const partyIds = mapVendors(nsVendors, c.name)
    base.partyIds = partyIds
    base.partyId = partyIds[0]
    base.partyName = partyRows.rows.find((p: any) => p.id === partyIds[0])?.name
    base.historyMonths = numOrUndef(c.historyMonths) ?? (c.method === 'vendor_recurring_average' ? 3 : 12)
  } else if (c.method === 'credit_card_cycle') {
    base.cardAccountIds = mapAccts(c.accountIds ?? c.accounts ?? [], c.name)
    base.historyMonths = numOrUndef(c.historyMonths) ?? 6
    const thr = numOrUndef(c.significantPaymentThreshold)
    if (thr) base.significantPaymentThreshold = thr
  } else if (c.method === 'manual_recurring') {
    base.amount = Number(c.amount ?? 0)
    base.frequency = c.frequency ?? 'monthly'
  } else if (c.method === 'formula_expression') {
    base.formula = String(c.formula ?? '')
  } else if (c.method === 'bank_register_history') {
    base.bankAccountIds = mapAccts(c.bankAccountIds ?? [], c.name)
    base.historyWeeks = numOrUndef(c.historyWeeks) ?? 12
    if (Array.isArray(c.memoKeywords) && c.memoKeywords.length) base.memoKeywords = c.memoKeywords
    if (c.includeTransfers === false) base.includeTransfers = false
    if (c.includeChecks === false) base.includeChecks = false
    if (c.includeJournals === true) base.includeJournals = true
  }
  out.push(base)
}

// ---- AP scheduling knobs ----
const ap = cfg.apFilters ?? {}
const cashflowCfg = { weeklyApCap: Number(ap.weeklyCap ?? 0), restrictToSafe: ap.restrictToSafe ? 1 : 0 }
if (ap.preservationMode) notes.push('apFilters.preservationMode=true has no openbooks equivalent (not imported)')
if (ap.deferIfNegative) notes.push('apFilters.deferIfNegative=true has no openbooks equivalent (not imported)')
if ((ap.excludeVendorCategories ?? []).length) notes.push(`apFilters.excludeVendorCategories=${JSON.stringify(ap.excludeVendorCategories)} not portable (no vendor categories in openbooks)`)
if ((ap.priorityVendorCategories ?? []).length) notes.push(`apFilters.priorityVendorCategories=${JSON.stringify(ap.priorityVendorCategories)} not portable`)
if ((cfg.groups ?? []).length) notes.push(`groups=${JSON.stringify((cfg.groups ?? []).map((g: any) => g.name))} not imported (no category groups)`)
if ((cfg.bankAccountIds ?? []).length) notes.push(`top-level bankAccountIds=${JSON.stringify(cfg.bankAccountIds)} — openbooks uses all asset_bank accounts for starting cash`)

console.log('=== MAPPED CATEGORIES ===')
for (const c of out) console.log(JSON.stringify(c))
console.log('=== CASHFLOW CONFIG ===', JSON.stringify(cashflowCfg))
console.log('=== UNMAPPED ===', unmapped.length ? JSON.stringify(unmapped) : 'none')
console.log('=== NOTES ===')
for (const n of notes) console.log('-', n)

if (APPLY) {
  await db.execute(sql`
    update orgs set settings = jsonb_set(
      jsonb_set(settings, '{analytics}', coalesce(settings -> 'analytics', '{}'::jsonb), true),
      '{analytics,cashflowCategories}', ${JSON.stringify(out)}::jsonb, true)
    where id = ${org}`)
  await db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{analytics,cashflow}', ${JSON.stringify(cashflowCfg)}::jsonb, true)
    where id = ${org}`)
  console.log('=== APPLIED ===')
} else {
  console.log('=== DRY RUN (pass --apply to write) ===')
}
process.exit(0)
