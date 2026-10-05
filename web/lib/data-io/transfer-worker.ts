import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import { Writable } from 'node:stream'
import { AsyncLocalStorage } from 'node:async_hooks'
import { sql } from 'drizzle-orm'
import { db, withBypassContext, withOrgContext, withOrgTransaction, withTransactionSavepoint } from '@openbooks/engine/platform/database'
import { createDataXlsxStream, guardCsvCell, SheetReadError } from '@openbooks/office'
import { applyMapping } from './mapping'
import { parseTransferRows } from './stream-parse'
import { ImportParseError } from './parse'
import { type ExportPage } from './export-page'
import { TRANSFER_BATCH_ROWS, TRANSFER_BATCHES_PER_CLAIM, TRANSFER_BATCH_BYTES, TRANSFER_CHUNK_BYTES, TRANSFER_SAMPLE_ROWS, TRANSFER_SAMPLE_BYTES, TransferRefusal } from './transfer-contract'
import { canonical, digest, emptyOutcome, loadTransfer, lockClaim, transferAuthority, updateTransfer, type StoredTransfer } from './transfer-store'
import type { RowError, WriteOutcome } from './types'

class TransferCancelled extends TransferRefusal {
  constructor() { super('Cancellation requested. Completed import batches remain committed and recorded; the current uncommitted batch is rolled back.') }
}
class BatchRefusal extends TransferRefusal {
  constructor(readonly outcome: WriteOutcome) { super('The import batch was refused and rolled back. Review the row errors, correct the cause, then retry from the stored checkpoint.', 422) }
}
class TransferInterrupted extends Error {}
const control = new AsyncLocalStorage<{ signal?: AbortSignal; heartbeatError?: unknown }>()
function assertRunning() {
  const current = control.getStore()
  if (current?.signal?.aborted) throw new TransferInterrupted('Worker shutdown; the durable checkpoint remains available.')
  if (current?.heartbeatError) throw current.heartbeatError
}
const independent = <T>(orgId: string, fn: () => Promise<T>) => withOrgContext(orgId, () => withOrgTransaction(orgId, fn))

async function currentClaim(orgId: string, id: string, token: string) {
  assertRunning()
  const job = await lockClaim(orgId, id, token)
  if (job.cancelRequested) throw new TransferCancelled()
  const authority = await transferAuthority(job)
  const fields = await authority.resource.fields(), columns = await authority.resource.columns()
  if (digest(canonical({ fields, columns })) !== job.schemaHash) throw new TransferRefusal('The resource fields changed after this transfer was created — create a new transfer and approve its new preview.', 422)
  return { job, ...authority }
}

/** Every stored part is verified on read. No file-sized Buffer is constructed. */
export async function* transferBytes(orgId: string, id: string, direction: 'source' | 'output', hash?: ReturnType<typeof createHash>): AsyncGenerator<Buffer> {
  let part = 0
  for (;;) {
    assertRunning()
    const entry = await independent(orgId, async () => (await db.execute<{ data: Buffer; sha256: string }>(sql`
      select data,sha256 from data_transfer_chunks where org_id=${orgId} and job_id=${id} and direction=${direction} and part_no=${part}`)).rows[0])
    if (!entry) return
    if (digest(entry.data) !== entry.sha256) throw new TransferRefusal(`Stored file part ${part + 1} failed its checksum — upload the source again or create a new export.`, 422)
    hash?.update(entry.data)
    yield entry.data
    part++
  }
}

async function stage(job: StoredTransfer, token: string) {
  const hash = createHash('sha256')
  let seen = 0, rows: Record<string, unknown>[] = [], headers: string[] = job.headers
  const sample: Record<string, unknown>[] = [...job.sample]
  let sampleBytes = Buffer.byteLength(JSON.stringify(sample)), batchBytes = 0
  const checkpoint = async () => {
    if (!rows.length) return
    const batch = rows; rows = []; batchBytes = 0
    await independent(job.orgId, async () => {
      const { job: live } = await currentClaim(job.orgId, job.id, token)
      if (live.state !== 'parsing') throw new TransferRefusal('The transfer is no longer parsing.')
      const values = batch.map((data, i) => sql`(${job.orgId},${job.id},${live.totalRows + i + 1},${JSON.stringify(data)}::jsonb)`)
      await db.execute(sql`insert into data_transfer_rows (org_id,job_id,row_no,data) values ${sql.join(values, sql`, `)}`)
      await updateTransfer(live, { totalRows: live.totalRows + batch.length, processedRows: live.totalRows + batch.length, headers: [...headers], sample })
    })
  }
  for await (const record of parseTransferRows(job.format, transferBytes(job.orgId, job.id, 'source', hash))) {
    headers = [...record.headers]
    if (!record.row) continue
    seen++
    if (seen <= job.totalRows) continue // Immutable source replay resumes a crashed parser.
    const size = Buffer.byteLength(JSON.stringify(record.row))
    if (sample.length < TRANSFER_SAMPLE_ROWS && sampleBytes + size <= TRANSFER_SAMPLE_BYTES) { sample.push(record.row); sampleBytes += size }
    if (rows.length && batchBytes + size > TRANSFER_BATCH_BYTES) await checkpoint()
    rows.push(record.row)
    batchBytes += size
    if (rows.length === TRANSFER_BATCH_ROWS) await checkpoint()
  }
  await checkpoint()
  await independent(job.orgId, async () => {
    const { job: live } = await currentClaim(job.orgId, job.id, token)
    if (seen !== live.totalRows) throw new TransferRefusal('The staged record count does not match the immutable source — create a new import.', 422)
    if (!seen) throw new TransferRefusal('The source contains no data records — add data below its headers and upload it again.', 422)
    await updateTransfer(live, { state: 'mapping', headers, sourceHash: hash.digest('hex'), processedRows: 0 }, 'source-staged')
  })
}

function mergeOutcome(previous: WriteOutcome, batch: WriteOutcome, offset: number): WriteOutcome {
  const adjust = (issue: RowError) => ({ ...issue, row: issue.row > 0 ? issue.row + offset : issue.row })
  return {
    created: previous.created + batch.created, updated: previous.updated + batch.updated,
    deleted: (previous.deleted ?? 0) + (batch.deleted ?? 0), failed: previous.failed + batch.failed,
    errors: [...previous.errors, ...batch.errors.map(adjust)].slice(0, 100),
    warnings: [...(previous.warnings ?? []), ...(batch.warnings ?? []).map(adjust)].slice(0, 100),
  }
}
async function storeIssues(job: StoredTransfer, phase: 'preview' | 'commit', result: WriteOutcome, offset: number) {
  const entries = [
    ...result.errors.map((issue) => ({ ...issue, severity: 'error' })),
    ...(result.warnings ?? []).map((issue) => ({ ...issue, severity: 'warning' })),
  ]
  if (!entries.length) return
  await db.execute(sql`insert into data_transfer_issues (org_id,job_id,phase,row_no,severity,message,field) values ${sql.join(entries.map((issue) =>
    sql`(${job.orgId},${job.id},${phase},${issue.row > 0 ? offset + issue.row : 0},${issue.severity},${issue.message},${issue.field ?? null})`), sql`, `)}`)
}
function sourceKeys(job: StoredTransfer, rows: Record<string, unknown>[], naturalKey?: string): (string | null)[] {
  if (!naturalKey) return rows.map(() => null)
  const fields = naturalKey.split(/\s*\+\s*/)
  return rows.map((row) => {
    const values = fields.map((field) => String(row[field] ?? '').trim())
    if (fields.length === 1 && !values[0] && job.resource === 'parties') return `party-name:${String(row.displayName ?? '').trim()}`
    return values.every((value) => value === '') ? null : canonical(values)
  })
}
async function storeKeys(job: StoredTransfer, keys: readonly (string | null)[], offset: number, namespace: string) {
  const values = keys.flatMap((key, index) => key === null ? [] : [sql`(${job.orgId},${job.id},${digest(`${namespace}:${key}`)},${offset + index + 1})`])
  if (!values.length) return
  // The same resource may declare its resolved key more than once. Repeated
  // declaration for one source row is evidence of the same identity, not a write.
  await db.execute(sql`insert into data_transfer_keys (org_id,job_id,key_hash,row_no) values ${sql.join(values, sql`, `)} on conflict (org_id,job_id,key_hash,row_no) do nothing`)
}
async function storeConstraints(job: StoredTransfer, values: readonly (readonly ({ key: string; value: string; label: string } | null)[])[], length: number) {
  const rows = Array.from({ length }, (_, i) => {
    const constraints = values.flatMap((set, namespace) => set[i] ? [{ key: digest(`${namespace}:${set[i]!.key}`), value: digest(set[i]!.value), label: set[i]!.label }] : [])
    return sql`(${job.processedRows + i + 1}::bigint,${JSON.stringify(constraints)}::jsonb)`
  })
  const result = await db.execute(sql`update data_transfer_rows r set keys=v.keys from (values ${sql.join(rows, sql`, `)}) as v(row_no,keys)
    where r.org_id=${job.orgId} and r.job_id=${job.id} and r.row_no=v.row_no returning r.row_no`)
  if (result.rows.length !== length) throw new Error('Source constraint evidence did not persist for every row')
}
async function historyCheckpoint(job: StoredTransfer, outcome: WriteOutcome, state: string) {
  const result = await db.execute(sql`update import_jobs set status=${state},total_rows=${job.totalRows},
    created_count=${outcome.created},updated_count=${outcome.updated},failed_count=${outcome.failed},errors=${JSON.stringify(outcome.errors)}::jsonb,
    mapping=${JSON.stringify(job.options.mapping ?? {})}::jsonb, mode=${job.options.importMode ?? 'upsert'}
    where org_id=${job.orgId} and id=${job.id} returning id`)
  if (result.rows.length !== 1) throw new Error('Import history checkpoint did not persist')
}
export const approvalDigest = (job: StoredTransfer) => digest(canonical({
  source: job.sourceHash, schema: job.schemaHash, scope: job.scope, options: job.options,
  resource: job.resource, actor: job.actorId, total: job.totalRows,
}))

async function importBatch(orgId: string, id: string, token: string): Promise<boolean> {
  return independent(orgId, async () => {
    const { job, authz, resource, scope } = await currentClaim(orgId, id, token)
    const preview = job.state === 'previewing'
    if (!preview && job.state !== 'committing') return false
    if (!preview && (job.preview.failed > 0 || job.approvalHash !== approvalDigest(job))) throw new TransferRefusal('The approved preview no longer matches this import — run and approve a new preview before committing.', 422)
    const page = (await db.execute<{ row_no: string; data: Record<string, unknown> }>(sql`
      with candidates as materialized (
        select row_no,data from data_transfer_rows where org_id=${orgId} and job_id=${id} and row_no>${job.processedRows} order by row_no limit ${TRANSFER_BATCH_ROWS}
      ), bounded as (
        select row_no,data,sum(octet_length(data::text)) over (order by row_no) as page_bytes from candidates
      ) select row_no,data from bounded where page_bytes<=${TRANSFER_BATCH_BYTES} or row_no=${job.processedRows + 1} order by row_no`)).rows
    if (!page.length) {
      if (job.processedRows !== job.totalRows) throw new TransferRefusal('The source staging is incomplete — create a new import.', 422)
      if (preview) {
        // Scan the collected keys once, including identities shared across
        // batches. Materialization prevents stale tenant cardinality estimates
        // from choosing a join that repeatedly scans the entire source.
        await db.execute(sql`insert into data_transfer_issues (org_id,job_id,phase,row_no,severity,message,field)
          with evidence as materialized (
            select row_no,count(*) over (partition by key_hash) as occurrences
            from data_transfer_keys where org_id=${orgId} and job_id=${id}
          ) select ${orgId},${id},'preview',row_no,'error','This identity appears in more than one source record — keep one record per natural key, then upload the corrected file.',null
          from evidence where occurrences>1 group by row_no`)
        await db.execute(sql`insert into data_transfer_issues (org_id,job_id,phase,row_no,severity,message,field)
          with evidence as materialized (
            select r.row_no,k.value,
              min(k.value->>'value') over (partition by k.value->>'key') as first_value,
              max(k.value->>'value') over (partition by k.value->>'key') as last_value
            from data_transfer_rows r cross join lateral jsonb_array_elements(r.keys) k
            where r.org_id=${orgId} and r.job_id=${id}
          ) select ${orgId},${id},'preview',row_no,'error',value->>'label',null from evidence where first_value<>last_value`)
        const failures = (await db.execute<{ count: string }>(sql`select count(distinct row_no) as count from data_transfer_issues where org_id=${orgId} and job_id=${id} and phase='preview' and severity='error'`)).rows[0]
        const errors = (await db.execute<RowError & Record<string, unknown>>(sql`select row_no::float8 as row,message,field from data_transfer_issues where org_id=${orgId} and job_id=${id} and phase='preview' and severity='error' order by row_no limit 100`)).rows
        const outcome = { ...job.preview, failed: Number(failures?.count ?? 0), errors }
        await updateTransfer(job, { state: 'ready', preview: outcome, approvalHash: approvalDigest(job) }, 'preview-completed')
      } else {
        await historyCheckpoint(job, job.outcome, 'committed')
        await updateTransfer(job, { state: 'completed' }, 'import-completed')
      }
      return false
    }
    if (Number(page[0]!.row_no) !== job.processedRows + 1) throw new TransferRefusal('A source row is missing from staging — create a new import.', 422)
    const mapped = page.map((row) => applyMapping(row.data, job.options.mapping ?? {}))
    const keySets: (readonly (string | null)[])[] = []
    const constraintSets: (readonly ({ key: string; value: string; label: string } | null)[])[] = []
    const write = await withTransactionSavepoint(db, async () => {
      const result = await resource.write(mapped, job.options.importMode ?? 'upsert', {
        orgId, actorId: job.actorId, permissions: authz.permissions, dryRun: preview,
        post: job.options.post === true, allowedSubsidiaryIds: scope,
        recordKeys: async (keys) => { if (keys.length !== mapped.length) throw new Error('Resource uniqueness evidence has an incorrect row count'); keySets.push(keys) },
        recordConstraints: async (values) => { if (values.length !== mapped.length) throw new Error('Resource consistency evidence has an incorrect row count'); constraintSets.push(values) },
      })
      if (!preview && (result.failed || result.errors.length)) throw new BatchRefusal({ ...result, failed: Math.max(result.failed, new Set(result.errors.map((issue) => issue.row)).size) })
      return result
    })
    if (preview) {
      await storeKeys(job, sourceKeys(job, mapped, resource.descriptor.naturalKey), job.processedRows, 'source')
      for (let i = 0; i < keySets.length; i++) await storeKeys(job, keySets[i]!, job.processedRows, `resolved-${i}`)
      await storeConstraints(job, constraintSets, mapped.length)
    }
    await storeIssues(job, preview ? 'preview' : 'commit', write, job.processedRows)
    const outcome = mergeOutcome(preview ? job.preview : job.outcome, write, job.processedRows)
    const processed = job.processedRows + page.length
    if (!preview) await historyCheckpoint(job, outcome, 'committing')
    await updateTransfer(job, { processedRows: processed, ...(preview ? { preview: outcome } : { outcome }) }, preview ? undefined : 'batch-committed')
    return true
  })
}

/** Backpressure limits output to one 4 MiB part plus the current source page. */
async function exportFile(job: StoredTransfer, token: string) {
  await independent(job.orgId, async () => {
    const { job: live } = await currentClaim(job.orgId, job.id, token)
    await db.execute(sql`delete from data_transfer_chunks where org_id=${job.orgId} and job_id=${job.id} and direction='output'`)
    await updateTransfer(live, { processedRows: 0, totalRows: 0, bytes: 0 }, 'export-snapshot-started')
  })
  let part = 0, bytes = 0, pending = Buffer.allocUnsafe(TRANSFER_CHUNK_BYTES), pendingBytes = 0, processed = 0
  const outputHash = createHash('sha256')
  const persist = async (data: Buffer) => {
    outputHash.update(data)
    await independent(job.orgId, async () => {
      const live = await lockClaim(job.orgId, job.id, token)
      if (live.cancelRequested) throw new TransferCancelled()
      await db.execute(sql`insert into data_transfer_chunks (org_id,job_id,direction,part_no,data,sha256)
        values (${job.orgId},${job.id},'output',${part},${data},${digest(data)})`)
      bytes += data.length; part++
      await updateTransfer(live, { bytes })
    })
  }
  const sink = new Writable({ highWaterMark: TRANSFER_CHUNK_BYTES, write(chunk: Buffer, _encoding, callback) {
    void (async () => {
      let remaining = Buffer.from(chunk)
      while (remaining.length) {
        const take = Math.min(TRANSFER_CHUNK_BYTES - pendingBytes, remaining.length)
        remaining.copy(pending, pendingBytes, 0, take); pendingBytes += take
        remaining = remaining.subarray(take)
        if (pendingBytes === TRANSFER_CHUNK_BYTES) { const flush = pending; pending = Buffer.allocUnsafe(TRANSFER_CHUNK_BYTES); pendingBytes = 0; await persist(flush) }
      }
    })().then(() => callback(), (error: Error) => callback(error))
  } })
  let sinkFailure: Error | null = null
  sink.on('error', (error: Error) => { sinkFailure = error })
  const push = (text: string) => new Promise<void>((resolve, reject) => { sink.write(text, (error) => error ? reject(error) : resolve()) })
  const columns = job.options.columns!
  const csvCell = (value: unknown) => {
    const text = String(guardCsvCell(value === null || value === undefined ? '' : String(value)))
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
  }
  const xlsx = job.format === 'xlsx' ? createDataXlsxStream(sink, columns) : null
  try {
    if (job.format === 'csv') await push(`${columns.map(csvCell).join(',')}\r\n`)
    if (job.format === 'json') await push('[')
    await withOrgContext(job.orgId, () => withOrgTransaction(job.orgId, async () => {
      // The complete read uses one repeatable-read snapshot; status and
      // artifact chunks use independent tenant transactions so progress is live.
      const { resource } = await transferAuthority(job)
      let after: string | null = null, offset = 0
      for (;;) {
        const scope = await independent(job.orgId, async () => (await currentClaim(job.orgId, job.id, token)).scope)
        const page: ExportPage = { size: TRANSFER_BATCH_ROWS, after, next: null, done: false, offset, columns }
        const result = await resource.read({ actorId: job.actorId, allowedSubsidiaryIds: scope, page })
        for (const row of result.rows) {
          const values = columns.map((key) => row[key] ?? null)
          if (xlsx) xlsx.append(values)
          else if (job.format === 'csv') await push(`${values.map(csvCell).join(',')}\r\n`)
          else await push(`${processed ? ',' : ''}${JSON.stringify(Object.fromEntries(columns.map((key, i) => [key, values[i]])))}`)
          processed++
        }
        if (xlsx) await xlsx.drain()
        if (sinkFailure) throw sinkFailure
        await independent(job.orgId, async () => {
          const live = await lockClaim(job.orgId, job.id, token)
          if (live.cancelRequested) throw new TransferCancelled()
          await updateTransfer(live, { processedRows: processed })
        })
        if (page.done) break
        if (page.next === null || page.next === after) throw new TransferRefusal('This export resource did not advance its bounded cursor — contact your administrator.', 422)
        after = page.next; offset += page.size
      }
    }, { isolationLevel: 'REPEATABLE READ', readOnly: true }))
    if (xlsx) await xlsx.finish()
    if (job.format === 'json') await push(']\n')
    if (!sink.writableFinished) await new Promise<void>((resolve, reject) => { sink.once('error', reject); sink.end(resolve) })
    if (sinkFailure) throw sinkFailure
    if (pendingBytes) await persist(pending.subarray(0, pendingBytes))
    await independent(job.orgId, async () => {
      const { job: live } = await currentClaim(job.orgId, job.id, token)
      await updateTransfer(live, { state: 'completed', totalRows: processed, processedRows: processed, bytes, sourceHash: outputHash.digest('hex') }, 'export-completed')
    })
  } finally { xlsx?.abort(); sink.destroy() }
}

export async function processTransfer(orgId: string, id: string, token: string, signal?: AbortSignal) {
  return control.run({ signal }, async () => {
  let heartbeat: Promise<void> | null = null
  const current = control.getStore()!
  const timer = setInterval(() => {
    if (heartbeat || signal?.aborted) return
    heartbeat = independent(orgId, async () => {
      await currentClaim(orgId, id, token)
      const result = await db.execute(sql`update data_transfer_jobs set claim_until=now()+interval '10 minutes',updated_at=now()
        where org_id=${orgId} and id=${id} and claim_token=${token} returning id`)
      if (result.rows.length !== 1) throw new TransferRefusal('The worker claim was replaced; processing must restart from the stored checkpoint.')
    }).catch((error: unknown) => { current.heartbeatError = error }).finally(() => { heartbeat = null })
  }, 30_000)
  try {
    const job = await independent(orgId, () => loadTransfer(orgId, id))
    if (job.state === 'parsing') await stage(job, token)
    else if (job.state === 'exporting') await exportFile(job, token)
    else {
      // Long imports yield their fenced claim after a bounded quantum so
      // other organizations' queued work can advance between checkpoints.
      let batches = 0
      while (await importBatch(orgId, id, token)) if (++batches === TRANSFER_BATCHES_PER_CLAIM) break
    }
  } catch (error) {
    if (error instanceof TransferInterrupted) return
    console.error(`[data-transfer] ${id} stopped:`, error)
    await independent(orgId, async () => {
      const job = await loadTransfer(orgId, id, true)
      // Another worker owns the checkpoint now. A stale failure must not
      // overwrite its state or clear its fencing token.
      if (job.claimToken !== token) return
      if (error instanceof BatchRefusal) await storeIssues(job, 'commit', error.outcome, job.processedRows)
      const message = error instanceof TransferRefusal || error instanceof ImportParseError || error instanceof SheetReadError ? error.message : 'Transfer processing failed. Ask an administrator to inspect the worker log, then retry from the stored checkpoint.'
      const state = error instanceof TransferCancelled ? 'cancelled' : 'failed'
      const outcome = error instanceof BatchRefusal ? mergeOutcome(job.outcome, { ...emptyOutcome(), failed: error.outcome.failed, errors: error.outcome.errors }, job.processedRows) : job.outcome
      await updateTransfer(job, { state, failedPhase: job.state, error: message, outcome }, state)
      if (job.kind === 'import') await historyCheckpoint(job, outcome, state)
    })
  } finally {
    clearInterval(timer)
    await heartbeat
    // Zero affected rows is expected only when another fenced claim owns
    // the job; this release must never clear that replacement claim.
    await independent(orgId, async () => { await db.execute(sql`update data_transfer_jobs set claim_token=null,claim_until=null where org_id=${orgId} and id=${id} and claim_token=${token}`) })
  }
  })
}

/** A targeted claim lets an operator drain one transfer with a matching worker release. */
export async function claimTransfer(target?: { orgId: string; id: string }): Promise<{ orgId: string; id: string; token: string } | null> {
  // bypass: scheduler-tick — discover only tenant/job identities whose durable work is due.
  const due = await withBypassContext(async () => (await db.execute<{ org_id: string; id: string }>(sql`
    select org_id,id from data_transfer_jobs where state in ('parsing','previewing','committing','exporting')
    and (claim_until is null or claim_until<now())
    ${target ? sql`and org_id=${target.orgId} and id=${target.id}` : sql``}
    order by updated_at,id limit 20`)).rows)
  for (const candidate of due) {
    const token = randomUUID()
    const claimed = await independent(candidate.org_id, async () => (await db.execute(sql`
      update data_transfer_jobs set claim_token=${token},claim_until=now()+interval '10 minutes'
      where org_id=${candidate.org_id} and id=${candidate.id} and state in ('parsing','previewing','committing','exporting')
        and (claim_until is null or claim_until<now()) returning id`)).rows.length === 1)
    if (claimed) return { orgId: candidate.org_id, id: candidate.id, token }
  }
  return null
}

/** Separate worker process, two bounded jobs; PostgreSQL is the durable queue. */
export function startDataTransferWorker(): () => Promise<void> {
  let stopped = false
  const abort = new AbortController()
  const timers = new Map<ReturnType<typeof setTimeout>, () => void>()
  const wait = () => new Promise<void>((resolve) => { const timer = setTimeout(() => { timers.delete(timer); resolve() }, 2000); timers.set(timer, resolve) })
  const run = async () => {
    while (!stopped) {
      try {
        const next = await claimTransfer()
        if (next) await processTransfer(next.orgId, next.id, next.token, abort.signal)
        else await wait()
      } catch (error) { console.error('[data-transfer] dispatch failed:', error); await wait() }
    }
  }
  const loops = [run(), run()]
  return async () => { stopped = true; abort.abort(); for (const [timer, resolve] of timers) { clearTimeout(timer); resolve() }; await Promise.all(loops) }
}
