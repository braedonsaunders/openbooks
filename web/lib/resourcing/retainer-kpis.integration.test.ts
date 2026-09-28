import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
const { sql } = await import('drizzle-orm')
const { cmp } = await import('@openbooks/engine/src/money/money.ts')
const { db, env, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { loadRetainerKpis } = await import('./retainer-kpis.ts')

test('retainer KPIs balance per currency through posted drawdowns only', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  const ids = Object.fromEntries(['hiddenSub', 'seenProject', 'hiddenProject', 'customer', 'item', 'usd', 'eur', 'hidden', 'posted', 'draft'].map((name) => [name, randomUUID()])) as Record<string, string>
  try {
    await withBypassContext(async () => {
      await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values(${ids.hiddenSub},${org.orgId},${org.subsidiaryId},'Hidden retainer entity','USD','US')`)
      await db.execute(sql`insert into projects(id,org_id,name,subsidiary_id) values(${ids.seenProject},${org.orgId},'Seen project',${org.subsidiaryId}),(${ids.hiddenProject},${org.orgId},'Hidden project',${ids.hiddenSub})`)
      await db.execute(sql`insert into parties(id,org_id,kind,display_name) values(${ids.customer},${org.orgId},'customer','KPI customer')`)
      await db.execute(sql`insert into items(id,org_id,kind,name) values(${ids.item},${org.orgId},'service','KPI service')`)
      await db.execute(sql`insert into res_retainers(id,org_id,project_id,customer_party_id,kind,total_amount,currency,total_hours,unit_rate,starts_on,ends_on,retainer_item_id,state) values
        (${ids.usd},${org.orgId},${ids.seenProject},${ids.customer},'hours','1000.0000','USD','100.0000','10.0000','2026-04-01','2026-04-25',${ids.item},'active'),
        (${ids.eur},${org.orgId},${ids.seenProject},${ids.customer},'fees','500.0000','EUR',null,null,'2026-04-01','2026-06-30',${ids.item},'active'),
        (${ids.hidden},${org.orgId},${ids.hiddenProject},${ids.customer},'hours','999.0000','USD','99.9000','10.0000','2026-04-01','2026-04-20',${ids.item},'active')`)
      await db.execute(sql`insert into res_retainer_drawdowns(id,org_id,retainer_id,week_start,hours,amount,state) values
        (${ids.posted},${org.orgId},${ids.usd},'2026-04-12','25.0000','250.0000','posted'),
        (${ids.draft},${org.orgId},${ids.usd},'2026-04-19','10.0000','100.0000','draft')`)
    })
    // The loader shares the engine balance policy: total minus posted only.
    const kpis = await loadRetainerKpis(org.orgId, new Set([org.subsidiaryId]), '2026-04-15')
    const usd = kpis.perCurrency.find((entry) => entry.currency === 'USD')
    assert.ok(usd)
    assert.equal(cmp(usd.balance, '750'), 0, 'draft drawdowns do not reduce the balance')
    assert.equal(cmp(usd.drawn, '250'), 0)
    const eur = kpis.perCurrency.find((entry) => entry.currency === 'EUR')
    assert.ok(eur)
    assert.equal(cmp(eur.balance, '500'), 0, 'currencies never mix')
    // The hidden-subsidiary retainer ends 2026-04-20 with a 999 balance: a
    // USD balance of 750 and an expiring count of 1 prove it is excluded.
    assert.equal(kpis.expiringCount, 1, 'only the visible active retainer inside the 30-day window counts')
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
