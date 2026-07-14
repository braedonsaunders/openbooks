import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import { db, pool, schema } from './db.ts'
import { fromUnits, toUnits } from './money.ts'

/**
 * Replay NetSuite payment applications (nexttransactionlinelink, linktype
 * 'Payment') into openbooks `applications` rows, so AR/AP aging shows correct
 * open balances instead of everything fully open.
 *
 * Each link ties a payment transaction to a bill/invoice it settled. We map
 * both to their replayed journal entry's OPEN control line (one AP line per
 * bill/payment, one AR line per invoice/receipt) and insert one application
 * per (payment, applied) pair: from = payment's open line, to = the settled
 * open line. The kernel's app_check_open trigger validates caps; genuine
 * NetSuite over-applications (rounding) are caught and reported, not forced.
 */

const dumpDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'extraction', 'gl-dump')

interface Link {
  payment_tid: string
  applied_tid: string
  amount: string
}

async function main() {
  const links = JSON.parse(readFileSync(join(dumpDir, 'applications.json'), 'utf8')) as Link[]

  // aggregate by (payment, applied) — openbooks has one control line per entry,
  // so many NetSuite line-links collapse to one application per txn pair
  const byPair = new Map<string, bigint>()
  for (const l of links) {
    const key = `${l.payment_tid}|${l.applied_tid}`
    byPair.set(key, (byPair.get(key) ?? 0n) + toUnits(l.amount))
  }
  console.log(`links: ${links.length}, aggregated pairs: ${byPair.size}`)

  // tid -> the entry's open control line (AP/AR). Build once.
  const rows = (await db.execute(sql`
    select (regexp_match(e.entry_number, '-([0-9]+)$'))[1] as tid,
           l.id as open_line_id, e.posting_date, a.type as ctl_type
      from journal_entries e
      join journal_lines l on l.entry_id = e.id and l.is_open_item
      join accounts a on a.id = l.account_id
     where e.origin = 'migration'
       and a.type in ('liability_payable', 'asset_receivable')
  `)) as unknown as { rows: { tid: string; open_line_id: string; posting_date: string; ctl_type: string }[] }

  // tid -> its open control lines (usually one, sometimes several) with the
  // remaining capacity we track ourselves — so multi-line transactions
  // allocate correctly and over-applications are capped, not trigger-rejected.
  interface OpenLine { lineId: string; remaining: bigint; date: string }
  const linesByTid = new Map<string, OpenLine[]>()
  const lineOrder = new Map<string, number>()
  for (const r of rows.rows) {
    const arr = linesByTid.get(r.tid) ?? []
    arr.push({ lineId: r.open_line_id, remaining: 0n, date: r.posting_date })
    linesByTid.set(r.tid, arr)
  }
  // fill each open line's amount (its capacity)
  const amts = (await db.execute(sql`
    select l.id, abs(l.amount) as amt, l.line_number
      from journal_lines l join accounts a on a.id = l.account_id
     where l.is_open_item and a.type in ('liability_payable', 'asset_receivable')
  `)) as unknown as { rows: { id: string; amt: string; line_number: number }[] }
  const capById = new Map(amts.rows.map((r) => [r.id, toUnits(r.amt)]))
  for (const r of amts.rows) lineOrder.set(r.id, r.line_number)
  for (const arr of linesByTid.values()) {
    for (const ol of arr) ol.remaining = capById.get(ol.lineId) ?? 0n
    arr.sort((a, b) => (lineOrder.get(a.lineId) ?? 0) - (lineOrder.get(b.lineId) ?? 0))
  }

  const [org] = await db.select().from(schema.orgs)
  const orgId = org.id

  const toInsert: [string, string, bigint, string][] = [] // from, to, amount, date
  let skippedNoLine = 0
  let unallocated = 0n

  for (const [key, amountUnits] of byPair) {
    if (amountUnits <= 0n) continue
    const [paymentTid, appliedTid] = key.split('|')
    const payLines = linesByTid.get(paymentTid!)
    const appLines = linesByTid.get(appliedTid!)
    if (!payLines || !appLines) {
      skippedNoLine++
      continue
    }
    // two-pointer fill: consume payment + applied line capacity together
    let remaining = amountUnits
    let pi = 0
    let ai = 0
    while (remaining > 0n && pi < payLines.length && ai < appLines.length) {
      const alloc = [remaining, payLines[pi]!.remaining, appLines[ai]!.remaining].reduce((a, b) => (b < a ? b : a))
      if (alloc <= 0n) {
        if (payLines[pi]!.remaining <= 0n) pi++
        else ai++
        continue
      }
      toInsert.push([payLines[pi]!.lineId, appLines[ai]!.lineId, alloc, payLines[pi]!.date])
      payLines[pi]!.remaining -= alloc
      appLines[ai]!.remaining -= alloc
      remaining -= alloc
      if (payLines[pi]!.remaining <= 0n) pi++
      if (appLines[ai]!.remaining <= 0n) ai++
    }
    unallocated += remaining // NetSuite applied more than the reconstructed line capacity
  }

  // batch insert; capacity already enforced in-memory so the trigger just agrees
  const client = await pool.connect()
  let inserted = 0
  try {
    await client.query('begin')
    for (let i = 0; i < toInsert.length; i += 1000) {
      const chunk = toInsert.slice(i, i + 1000)
      const values: string[] = []
      const params: unknown[] = [orgId]
      chunk.forEach((row, j) => {
        const b = params.length
        params.push(row[0], row[1], fromUnits(row[2]), row[3])
        values.push(`($1, $${b + 1}, $${b + 2}, $${b + 3}, $${b + 4})`)
      })
      await client.query(
        `insert into applications (org_id, from_line_id, to_line_id, amount, applied_on) values ${values.join(',')}`,
        params,
      )
      inserted += chunk.length
    }
    await client.query('commit')
  } catch (e) {
    await client.query('rollback')
    throw e
  } finally {
    client.release()
  }

  console.log(
    `DONE: ${inserted} applications inserted across ${byPair.size} txn pairs; ` +
      `${skippedNoLine} pairs skipped (no mapped line); ` +
      `${fromUnits(unallocated)} of applied amount unallocated (exceeds reconstructed line capacity — the FY2025 anomaly txns)`,
  )
  await pool.end()
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e)
  process.exit(1)
})
