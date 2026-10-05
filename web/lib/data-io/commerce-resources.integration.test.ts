import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { CommerceError } from '@openbooks/engine/commerce'
import { db, withBypassContext, withOrgContext } from '@openbooks/engine/src/platform/db.ts'
import { createScratchOrg, dropScratchOrg } from '@openbooks/engine/src/testing/fixtures.ts'
import { registerChannelAdapter } from '@openbooks/engine/src/commerce/adapters.ts'
import { createChannel } from '@openbooks/engine/src/commerce/channels.ts'
import { CHANNEL_AD_SPEND_KEY, channelAdSpendResource } from './commerce-resources'
import { getResource, listResources } from './resources'

const DB = Boolean(process.env.OPENBOOKS_DB_URL)

registerChannelAdapter({
  kind: 'shopify',
  describeSettings: () => z.object({}).strict(),
  verifyWebhook: () => ({ eventId: 'test', topic: 'test' }),
  testConnection: async () => ({ ok: true, detail: 'test' }),
  handleEvent: async () => ({ action: 'ignored', resultRef: {} }),
  workspaceTabs: () => [],
})

test('channel ad-spend imports daily figures through the margin restatement', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  const actorId = randomUUID()
  try {
    await withOrgContext(org.orgId, async () => {
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', '{"salesChannels":true}'::jsonb) where id = ${org.orgId}`)
    })
    const created = await withOrgContext(org.orgId, () =>
      createChannel(org.orgId, actorId, {
        kind: 'shopify',
        name: 'Test Shop',
        currency: 'USD',
        externalAccount: 'test.myshopify.com',
        settings: {},
      }),
    )
    const channelId = created.channel.id

    const resource = await withOrgContext(org.orgId, () => getResource(org.orgId, CHANNEL_AD_SPEND_KEY))
    assert.ok(resource, 'the import wizard offers channel ad spend while Sales Channels is on')
    assert.equal(resource.descriptor.supportsImport, true)
    // One import path, not two: the generic setup writer would store the row
    // without the margin restatement the domain write performs.
    const listed = (await withOrgContext(org.orgId, () => listResources(org.orgId))).filter(
      (descriptor) => descriptor.key === CHANNEL_AD_SPEND_KEY,
    )
    assert.equal(listed.length, 1)
    const direct = channelAdSpendResource(org.orgId)
    assert.equal(direct.descriptor.key, CHANNEL_AD_SPEND_KEY)

    const row = { channel: 'Test Shop', spendDate: '2026-07-20', amount: '120.50', currency: 'USD', source: 'meta-export' }
    const ctx = { orgId: org.orgId, actorId, dryRun: true, allowedSubsidiaryIds: null }
    const preview = await withOrgContext(org.orgId, () => resource.write([row], 'insert', ctx))
    assert.deepEqual([preview.created, preview.failed], [1, 0])
    const committed = await withOrgContext(org.orgId, () => resource.write([row], 'insert', { ...ctx, dryRun: false }))
    assert.deepEqual([committed.created, committed.failed], [1, 0])
    const stored = await withOrgContext(org.orgId, () => db.execute<{ amount: string; source: string }>(sql`
      select amount_minor::text as amount, source from channel_ad_spend
       where org_id = ${org.orgId} and channel_id = ${channelId} and spend_date = '2026-07-20'`))
    assert.equal(stored.rows.length, 1)
    assert.equal(stored.rows[0]!.amount, '12050')
    assert.equal(stored.rows[0]!.source, 'meta-export')

    // Re-importing the same source replaces its figure instead of doubling it.
    const replaced = await withOrgContext(org.orgId, () =>
      resource.write([{ ...row, amount: '100.00' }], 'insert', { ...ctx, dryRun: false }))
    assert.deepEqual([replaced.created, replaced.failed], [1, 0])
    const restated = await withOrgContext(org.orgId, () => db.execute<{ amount: string; source: string; channel: string }>(sql`
      select amount_minor::text as amount, source, channel_id::text as channel from channel_ad_spend
       where org_id = ${org.orgId} and channel_id = ${channelId} and spend_date = '2026-07-20'`))
    assert.equal(restated.rows.length, 1)
    assert.equal(restated.rows[0]!.amount, '10000')

    // The export renders the figure back in major units for the next file.
    const exported = await withOrgContext(org.orgId, () => resource.read())
    const exportedRow = exported.rows.find((item) => item.channel === 'Test Shop')
    assert.equal(exportedRow?.amount, '100.00')

    // Legacy imports could store an unsupported currency. Export must expose
    // that refusal instead of assigning a decimal precision to the amount.
    await withOrgContext(org.orgId, () => db.execute(sql`
      update channel_ad_spend set currency = 'ZZZ'
       where org_id = ${org.orgId} and channel_id = ${channelId}`))
    await assert.rejects(() => withOrgContext(org.orgId, () => resource.read()), (error: unknown) => {
      assert.ok(error instanceof CommerceError)
      assert.equal(error.code, 'ad_spend_currency_unsupported')
      assert.match(error.message, /Test Shop.*ZZZ/)
      assert.match(error.remedy, /Channels.*Settings.*ad spend/)
      return true
    })
    await withOrgContext(org.orgId, () => db.execute(sql`
      update channel_ad_spend set currency = 'USD'
       where org_id = ${org.orgId} and channel_id = ${channelId}`))

    const unknownChannel = await withOrgContext(org.orgId, () =>
      resource.write([{ ...row, channel: 'No Such Shop' }], 'insert', { ...ctx, dryRun: false }))
    assert.equal(unknownChannel.failed, 1)
    assert.match(unknownChannel.errors[0]?.message ?? '', /not found/)

    // The shared duplicate contract refuses every row sharing the key, not just the second.
    const dupe = await withOrgContext(org.orgId, () =>
      resource.write([row, row], 'insert', { ...ctx, dryRun: false }))
    assert.equal(dupe.failed, 2)
    assert.match(dupe.errors[0]?.message ?? '', /Duplicate channel/)
    assert.match(dupe.errors[1]?.message ?? '', /Duplicate channel/)

    const badAmount = await withOrgContext(org.orgId, () =>
      resource.write([{ ...row, amount: '12.34567' }], 'insert', { ...ctx, dryRun: false }))
    assert.equal(badAmount.failed, 1)

    await withOrgContext(org.orgId, () => db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', '{"salesChannels":false}'::jsonb) where id = ${org.orgId}`))
    assert.equal(await withOrgContext(org.orgId, () => getResource(org.orgId, CHANNEL_AD_SPEND_KEY)), null)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
