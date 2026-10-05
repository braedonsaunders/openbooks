import { importRowError } from './row-error'
import { readExportWindow, transferId, transferWhere, transferOrder, transferLimit, finishExportPage } from './export-page'
/** Channel ad-spend data-io resource: daily marketing spend per storefront channel. */
import 'server-only'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/platform/database'
import {
  CommerceError,
  decimalToMinorUnits,
  minorUnitsForCurrency,
  recordChannelAdSpend,
} from '@openbooks/engine/commerce'
import type { CellValue, ImportMode, ResourceDescriptor, ResourceField, WriteOutcome } from './types'
import type { DataResource, WriteCtx } from './resource-core'
import { duplicateImportRowIndexes } from './resource-core'

export const CHANNEL_AD_SPEND_KEY = 'channel-ad-spend'

export const CHANNEL_AD_SPEND_DESCRIPTOR: ResourceDescriptor = {
  key: CHANNEL_AD_SPEND_KEY,
  label: 'Channel ad spend',
  group: 'Setup',
  iconKey: 'megaphone',
  readPermission: 'channels.read',
  writePermission: 'channels.manage',
  supportsImport: true,
  naturalKey: 'channel + spend date + source',
}

function channelAdSpendFields(): ResourceField[] {
  return [
    { key: 'channel', label: 'Channel', kind: 'text', required: true },
    { key: 'spendDate', label: 'Spend date', kind: 'date', required: true },
    { key: 'amount', label: 'Amount', kind: 'text', required: true },
    { key: 'currency', label: 'Currency', kind: 'text', required: true },
    { key: 'source', label: 'Source', kind: 'text' },
  ]
}

function describeRefusal(error: unknown): string {
  if (error instanceof CommerceError) return `${error.message} Remedy: ${error.remedy}`
  return importRowError(error)
}

/**
 * Channel names are not unique per org (identity is kind + external
 * account), so a CSV naming a duplicated display name refuses instead of
 * attributing spend to whichever row the lookup finds first.
 */
async function resolveChannelId(orgId: string, channel: string): Promise<string> {
  const value = channel.trim()
  if (!value) throw new Error('channel is required')
  const rows = (await db.execute<{ id: string }>(sql`
    select id from sales_channels where org_id = ${orgId} and (name = ${value} or id::text = ${value})`)).rows
  if (rows.length === 0) throw new Error(`channel "${value}" not found — create it under Channels first`)
  if (rows.length > 1) {
    throw new Error(
      `channel "${value}" names ${rows.length} channels — rename the duplicates under Channels so each name picks one`,
    )
  }
  return rows[0]!.id
}

type AdSpendInput = {
  channelId: string
  spendDate: string
  amountMinor: bigint
  currency: string
  source: string
}

async function prepareRow(orgId: string, source: Record<string, unknown>): Promise<AdSpendInput> {
  const channelId = await resolveChannelId(orgId, String(source.channel ?? ''))
  const spendDate = String(source.spendDate ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(spendDate)) {
    throw new Error(`spend date "${spendDate}" is not a calendar day (YYYY-MM-DD)`)
  }
  const currency = String(source.currency ?? '').trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`currency "${String(source.currency ?? '')}" is not a 3-letter code`)
  const amountText = String(source.amount ?? '').trim()
  if (!/^\d+(\.\d{1,4})?$/.test(amountText)) {
    throw new Error(`amount "${amountText}" is not a zero or positive decimal with at most 4 places`)
  }
  const amountMinor = decimalToMinorUnits(amountText, await minorUnitsForCurrency(currency))
  const origin = String(source.source ?? '').trim()
  return { channelId, spendDate, amountMinor, currency, source: origin ? origin : 'manual' }
}

export function channelAdSpendResource(orgId: string): DataResource {
  return {
    descriptor: CHANNEL_AD_SPEND_DESCRIPTOR,
    async fields() { return channelAdSpendFields() },
    async columns() { return channelAdSpendFields().map(({ key, label }) => ({ key, label })) },
    async read(ctx?: import('./resource-core').ReadCtx) {
      const result = await readExportWindow<{
        channel: string; spend_date: string; amount_minor: string; currency: string; source: string | null;
      }>(db, sql`
        select c.name as channel, s.spend_date::text as spend_date,
               s.amount_minor::text as amount_minor, s.currency, s.source
          ${transferId(ctx, sql`s.id`)} from channel_ad_spend s
          join sales_channels c on c.org_id = s.org_id and c.id = s.channel_id
         where s.org_id = ${orgId}
           ${transferWhere(ctx, sql`s.id`)} order by ${transferOrder(ctx, sql`s.id`, sql`s.spend_date desc, s.id`)}
         limit ${ctx?.page ? transferLimit(ctx) : 10001}`, ctx)
      finishExportPage(result.rows, CHANNEL_AD_SPEND_DESCRIPTOR.label, ctx)
      const fields = channelAdSpendFields()
      const rows: Record<string, CellValue>[] = []
      for (const source of result.rows) {
        const minorUnits = await minorUnitsForCurrency(source.currency).catch((error: unknown) => {
          if (!(error instanceof CommerceError) || error.code !== 'currency_unsupported') throw error
          throw new CommerceError(
            'ad_spend_currency_unsupported',
            `Ad spend for channel "${source.channel}" on ${source.spend_date} cannot be exported in ${source.currency}: its currency precision is unsupported.`,
            "Open the channel under Channels → Settings and correct the ad spend currency and amount, then export again.",
            { field: 'currency' },
          )
        })
        const divisor = 10n ** BigInt(minorUnits)
        const minor = BigInt(source.amount_minor)
        const major = `${minor / divisor}.${(minor % divisor).toString().padStart(minorUnits, '0')}`
        rows.push({
          channel: source.channel,
          spendDate: source.spend_date,
          amount: minorUnits === 0 ? (minor).toString() : major,
          currency: source.currency,
          source: source.source,
        })
      }
      return { fields, columns: fields.map(({ key, label }) => ({ key, label })), rows }
    },
    async write(rows: Record<string, unknown>[], _mode: ImportMode, ctx: WriteCtx): Promise<WriteOutcome> {
      const outcome: WriteOutcome = { created: 0, updated: 0, failed: 0, errors: [] }
      if (ctx.orgId !== orgId) {
        return { ...outcome, failed: rows.length, errors: rows.map((_, index) => ({ row: index + 1, message: 'resource belongs to another organization' })) }
      }
      return withOrgTransaction(orgId, async () => {
        const prepared: ({ row: number; input: AdSpendInput } | { row: number; error: string; key: string | null })[] = []
        for (let index = 0; index < rows.length; index++) {
          const source = rows[index]!
          const identityKey = `${String(source.channel ?? '').trim()}\0${String(source.spendDate ?? '').trim()}\0${String(source.source ?? '').trim()}`
          try {
            prepared.push({ row: index + 1, input: await prepareRow(orgId, source) })
          } catch (error) {
            prepared.push({ row: index + 1, error: describeRefusal(error), key: identityKey })
          }
        }

        const identityKeys = prepared.map((row) => 'input' in row
          ? `${row.input.channelId}\0${row.input.spendDate}\0${row.input.source}` : row.key)
        await ctx.recordKeys?.(identityKeys)
        const duplicateRows = duplicateImportRowIndexes(identityKeys)
        const valid: { row: number; input: AdSpendInput }[] = []
        for (let index = 0; index < prepared.length; index++) {
          const row = prepared[index]!
          if (duplicateRows.has(index)) {
            outcome.failed++
            outcome.errors.push({ row: row.row, message: 'Duplicate channel, spend date and source in this file.' })
            continue
          }
          if (!('input' in row)) {
            outcome.failed++
            outcome.errors.push({ row: row.row, message: row.error })
            continue
          }
          // A preview exercises the same domain write as commit — the
          // engine upserts by channel, day and source, so validation sees
          // exactly what commit stores — then discards the batch.
          await db.execute(sql`savepoint channel_ad_spend_validate`)
          try {
            await recordChannelAdSpend(orgId, ctx.actorId, row.input)
            await db.execute(sql`rollback to savepoint channel_ad_spend_validate`)
            await db.execute(sql`release savepoint channel_ad_spend_validate`)
            valid.push(row)
          } catch (error) {
            await db.execute(sql`rollback to savepoint channel_ad_spend_validate`)
            await db.execute(sql`release savepoint channel_ad_spend_validate`)
            outcome.failed++
            outcome.errors.push({ row: row.row, message: describeRefusal(error) })
          }
        }

        if (ctx.dryRun) {
          outcome.created = valid.length
          return outcome
        }
        // Re-importing a source replaces its figure, so every valid row
        // commits through the same domain write the preview exercised.
        for (const row of valid) {
          try {
            await recordChannelAdSpend(orgId, ctx.actorId, row.input)
          } catch (error) {
            outcome.failed++
            outcome.errors.push({ row: row.row, message: describeRefusal(error) })
            continue
          }
          outcome.created++
        }
        return outcome
      })
    },
  }
}
