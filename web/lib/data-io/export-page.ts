import { sql, type SQL } from 'drizzle-orm'
import { MAX_EXPORT_ROWS, enforceExportRowLimit } from './export-cap'
import type { ReadCtx } from './resource-core'
import type { SqlExecutor } from '@openbooks/engine/platform/database'
import { TRANSFER_BATCH_BYTES, TRANSFER_MAX_ROW_BYTES, TransferRefusal } from './transfer-contract'

/** Mutable cursor belongs to one read; scope wrappers forward the same object. */
export interface ExportPage {
  size: number
  after: string | null
  next: string | null
  done: boolean
  offset?: number
  columns?: readonly string[]
  truncated?: boolean
}
export const transferId = (ctx: ReadCtx | undefined, column: SQL) =>
  ctx?.page ? sql`, ${column}::text as "__transferId", ${column} as "__transferOrder"` : sql``
export const transferWhere = (ctx: ReadCtx | undefined, column: SQL) =>
  ctx?.page?.after ? sql` and ${column} > ${ctx.page.after}` : sql``
export const transferOrder = (ctx: ReadCtx | undefined, column: SQL, legacy: SQL) =>
  ctx?.page ? column : legacy
export const transferLimit = (ctx: ReadCtx | undefined) => ctx?.page?.size ?? MAX_EXPORT_ROWS + 1

/** Measure the bounded SQL window before loading payloads into JavaScript.
 * Payloads keep PostgreSQL's native numeric decoding; a JSON envelope would
 * turn exact financial decimals into JavaScript numbers. */
export async function readExportWindow<T extends Record<string, unknown> = Record<string, unknown>>(runner: SqlExecutor, query: SQL, ctx?: ReadCtx, identity = '__transferOrder'): Promise<{ rows: T[] }> {
  if (!ctx?.page) return { rows: (await runner.execute<T>(query)).rows as T[] }
  const order = sql.identifier(identity)
  const sizes = (await runner.execute<{ bytes: string }>(sql`select octet_length(transfer_window::text)::text as bytes
    from (${query}) transfer_window order by ${order}`)).rows
  let bytes = 0, count = 0
  for (const row of sizes) {
    const size = Number(row.bytes)
    if (size > TRANSFER_MAX_ROW_BYTES) {
      if (count) break
      throw new TransferRefusal('An export record exceeds the 4 MiB transfer limit. Ask your administrator to review this resource’s data shape before retrying.', 422)
    }
    if (bytes + size > TRANSFER_BATCH_BYTES) break
    bytes += size; count++
  }
  ctx.page.truncated = count < sizes.length
  return { rows: (await runner.execute<T>(sql`select * from (${query}) transfer_window order by ${order} limit ${count}`)).rows as T[] }
}

export function finishExportPage<T extends Record<string, unknown>>(rows: T[], label: string, ctx?: ReadCtx): T[] {
  if (!ctx?.page) return enforceExportRowLimit(rows, label)
  if (ctx.page.size < 1 || ctx.page.size > 1000 || rows.length > ctx.page.size) throw new Error('Invalid bounded export page')
  ctx.page.done = !ctx.page.truncated && rows.length < ctx.page.size
  ctx.page.next = rows.length ? String(rows[rows.length - 1]!.__transferId) : ctx.page.after
  if (rows.length && (ctx.page.next === 'undefined' || ctx.page.next === ctx.page.after)) throw new Error('The export resource did not advance its cursor')
  for (const row of rows) { delete row.__transferId; delete row.__transferOrder }
  return rows
}
