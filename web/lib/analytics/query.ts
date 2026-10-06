import 'server-only'
import { createHash } from 'node:crypto'
import { serialize, deserialize } from 'node:v8'
import { gzip, gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import { getTranslations } from 'next-intl/server'
import type { SQL } from 'drizzle-orm'
import type { QueryResultRow } from 'pg'
import { PgDialect } from 'drizzle-orm/pg-core'
import { db } from '@openbooks/engine/platform/database'
import { currentAnalyticsRead } from './read-context'
import { cachedAnalyticsRead, AnalyticsPreviewBusyError } from './preview-cache'

const dialect = new PgDialect()
const compress = promisify(gzip)
const expand = promisify(gunzip)
let active = 0
const waiting: (() => void)[] = []

async function execute<T extends QueryResultRow>(query: SQL): Promise<{ rows: T[] }> {
  if (active >= 8) {
    if (waiting.length >= 128) throw new AnalyticsPreviewBusyError((await getTranslations('analytics'))('preview.busy'))
    await new Promise<void>((resolve) => waiting.push(resolve))
  } else active += 1
  try { return { rows: (await db.execute<T>(query)).rows as T[] } }
  finally {
    const next = waiting.shift()
    if (next) next()
    else active -= 1
  }
}

/** Detail flyouts read current record visibility while sharing the same SQL
 * admission limit as dashboard aggregates. Private or transferred records
 * must not be retained in a detail-result cache. */
export function analyticsQueryLive<T extends QueryResultRow = Record<string, unknown>>(query: SQL): Promise<{ rows: T[] }> {
  return execute<T>(query)
}

/** Reuse a scoped SQL aggregate across cards, tabs and equally authorized
 * users. SQL and all binds identify the source fact; dates and exact decimal
 * strings retain their native types when shared through Redis. */
export async function analyticsQuery<T extends QueryResultRow = Record<string, unknown>>(query: SQL): Promise<{ rows: T[] }> {
  const read = currentAnalyticsRead()
  if (!read) return execute<T>(query)
  const compiled = dialect.sqlToQuery(query)
  const hash = createHash('sha256').update(serialize({ sql: compiled.sql, params: compiled.params })).digest('hex')
  const encoded = await cachedAnalyticsRead(read.authz, `fact:${hash}`, {}, async () => {
    const result = await execute<T>(query)
    return (await compress(serialize(result.rows))).toString('base64')
  }, { identity: read, admit: false })
  return { rows: deserialize(await expand(Buffer.from(encoded, 'base64'), { maxOutputLength: 64 * 1024 * 1024 })) as T[] }
}
