import 'server-only'
import { createHash } from 'node:crypto'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import { can, resolveAuthzByUserId, type Authz } from '../authz'
import { getResource } from './resources'
import { TransferRefusal, type TransferJob, type TransferOptions, type TransferState } from './transfer-contract'
import type { ExportFormat, WriteOutcome } from './types'

export const emptyOutcome = (): WriteOutcome => ({ created: 0, updated: 0, failed: 0, deleted: 0, errors: [], warnings: [] })
export const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
/** Canonical order prevents object key insertion order from changing approvals. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
export interface StoredTransfer extends TransferJob {
  orgId: string
  actorId: string
  scope: string[] | null
  schemaHash: string | null
  sourceHash: string | null
  claimToken: string | null
  failedPhase: TransferState | null
}
const projection = sql.raw(`id, org_id as "orgId", actor_id as "actorId", kind, resource_key as resource, format,
 file_name as filename, state, revision, byte_count::float8 as bytes, uploaded_bytes::float8 as "uploadedBytes",
 total_rows::float8 as "totalRows", processed_rows::float8 as "processedRows", headers, fields, sample, options,
 outcome, preview, error, (claim_token is not null and claim_until>now()) as "workerActive",updated_at::text as "lastActivity", cancel_requested as "cancelRequested", approval_hash as "approvalHash",
 scope, schema_hash as "schemaHash", source_hash as "sourceHash", claim_token as "claimToken", failed_phase as "failedPhase"`)

export async function loadTransfer(orgId: string, id: string, lock = false): Promise<StoredTransfer> {
  const result = await db.execute<StoredTransfer & Record<string, unknown>>(sql`select ${projection} from data_transfer_jobs where org_id=${orgId} and id=${id}${lock ? sql` for update` : sql``}`)
  if (!result.rows[0]) throw new TransferRefusal('Transfer not found.', 404)
  return result.rows[0]
}
export function publicTransfer(job: StoredTransfer): TransferJob {
  const { orgId: _org, actorId: _actor, scope: _scope, schemaHash: _schema, sourceHash: _source, claimToken: _claim, failedPhase: _phase, ...result } = job
  return { ...result, lastActivity: new Date(result.lastActivity).toISOString() }
}
/** A filename can identify a legal entity; recent metadata obeys captured scope. */
export function transferMetadataScope(scope: ReadonlySet<string> | null, column: SQL): SQL {
  if (scope === null) return sql`true`
  return sql`${column}<>'null'::jsonb and not exists (
    select 1 from jsonb_array_elements_text(${column}) captured(id)
    where captured.id not in (select jsonb_array_elements_text(${JSON.stringify([...scope])}::jsonb)))`
}
/** Grants are resolved live and intersected with the scope captured at creation. */
export async function transferAuthority(job: StoredTransfer, caller?: Authz) {
  const authz = caller ?? await resolveAuthzByUserId(job.orgId, job.actorId)
  if (!authz || authz.user.orgId !== job.orgId || authz.user.id !== job.actorId) throw new TransferRefusal('This transfer belongs to another operator, or its operator is inactive.', 404)
  const permission = job.kind === 'import' ? 'data.import' : 'data.export'
  if (!can(authz, permission)) throw new TransferRefusal(`The ${permission} permission is required — ask an administrator to restore it before retrying this transfer.`, 403)
  const currentScope = authz.allowedSubsidiaryIds
  if ((job.scope === null && currentScope !== null) || (job.scope !== null && currentScope !== null && job.scope.some((id) => !currentScope.has(id)))) throw new TransferRefusal('The operator no longer has the subsidiary scope approved for this transfer — restore that authorized scope or create a new transfer with the current scope.', 403)
  const scope = job.scope === null ? currentScope : new Set(job.scope.filter((id) => currentScope === null || currentScope.has(id)))
  const resource = await getResource(job.orgId, job.resource, scope)
  if (!resource) throw new TransferRefusal('This resource is unavailable — review its feature status in Company Settings → Features before retrying.', 403)
  const required = job.kind === 'import' ? resource.descriptor.writePermission : resource.descriptor.readPermission
  if (!can(authz, required)) throw new TransferRefusal(`The ${required} permission is required — ask an administrator to grant it before retrying.`, 403)
  if (job.kind === 'import' && (!resource.descriptor.supportsImport || (scope !== null && !resource.descriptor.scopedWrite))) {
    throw new TransferRefusal('This resource cannot be imported with the current subsidiary restrictions — use an operator whose authorized scope supports this resource.', 403)
  }
  if (job.options.post && (!resource.descriptor.canPost || !resource.descriptor.postPermission || !can(authz, resource.descriptor.postPermission))) {
    throw new TransferRefusal('Posting authority is unavailable — restore the resource posting permission before retrying this transfer.', 403)
  }
  return { authz, resource, scope }
}
export async function recordTransferEvent(job: StoredTransfer, action: string, state: TransferState, evidence: Record<string, unknown> = {}) {
  await db.execute(sql`insert into data_transfer_events (org_id,job_id,actor_id,action,before_state,after_state,revision,evidence)
    values (${job.orgId},${job.id},${job.actorId},${action},${job.state},${state},${job.revision},${JSON.stringify(evidence)}::jsonb)`)
}
/** History counts describe committed effects, never a dry-run estimate. */
export async function updateImportHistory(job: StoredTransfer, state: string, outcome = job.outcome) {
  if (job.kind !== 'import') return
  const result = await db.execute(sql`update import_jobs set status=${state},total_rows=${job.totalRows},
    created_count=${outcome.created},updated_count=${outcome.updated},failed_count=${outcome.failed},errors=${JSON.stringify(outcome.errors)}::jsonb,
    mapping=${JSON.stringify(job.options.mapping ?? {})}::jsonb,mode=${job.options.importMode ?? 'upsert'}
    where org_id=${job.orgId} and id=${job.id} returning id`)
  if (result.rows.length !== 1) throw new Error('Import history checkpoint did not persist')
}
export async function createTransfer(authz: Authz, input: {
  requestKey: string; kind: 'import' | 'export'; resource: string; format: ExportFormat; filename: string; bytes: number; options?: TransferOptions
}): Promise<TransferJob> {
  const requestHash = digest(canonical(input))
  const prior = (await db.execute<{ id: string; request_hash: string }>(sql`select id,request_hash from data_transfer_jobs where org_id=${authz.user.orgId} and actor_id=${authz.user.id} and request_key=${input.requestKey}`)).rows[0]
  if (prior) {
    if (prior.request_hash !== requestHash) throw new TransferRefusal('This request key was already used with different transfer inputs — create a new request key.')
    const existing = await loadTransfer(authz.user.orgId, prior.id)
    await transferAuthority(existing, authz)
    return publicTransfer(existing)
  }
  const job = { orgId: authz.user.orgId, actorId: authz.user.id, kind: input.kind, resource: input.resource, options: input.options ?? {}, scope: authz.allowedSubsidiaryIds === null ? null : [...authz.allowedSubsidiaryIds] } as StoredTransfer
  const { resource } = await transferAuthority(job, authz)
  const fields = await resource.fields()
  const columns = await resource.columns()
  if (input.kind === 'export' && (!input.options?.columns?.length || input.options.columns.some((key) => !columns.some((column) => column.key === key)))) throw new TransferRefusal('Select at least one available export column.', 422)
  const inserted = await db.execute<{ id: string }>(sql`insert into data_transfer_jobs
    (org_id,actor_id,kind,resource_key,format,file_name,state,byte_count,scope,options,fields,schema_hash,request_key,request_hash)
    values (${job.orgId},${job.actorId},${input.kind},${input.resource},${input.format},${input.filename},${input.kind === 'import' ? 'uploading' : 'exporting'},${input.bytes},${JSON.stringify(job.scope)}::jsonb,${JSON.stringify(job.options)}::jsonb,${JSON.stringify(fields)}::jsonb,${digest(canonical({ fields, columns }))},${input.requestKey},${requestHash}) returning id`)
  if (!inserted.rows[0]) throw new Error('Transfer creation did not persist')
  const stored = await loadTransfer(job.orgId, inserted.rows[0].id)
  if (stored.kind === 'import') await db.execute(sql`insert into import_jobs (id,org_id,resource_key,resource_label,format,file_name,status,created_by)
    values (${stored.id},${stored.orgId},${stored.resource},${resource.descriptor.label},${stored.format},${stored.filename},'uploading',${stored.actorId})`)
  await recordTransferEvent(stored, 'created', stored.state, { requestHash, scope: stored.scope, options: stored.options, schemaHash: stored.schemaHash })
  return publicTransfer(stored)
}

/** A stale worker cannot checkpoint or commit after another claim succeeds. */
export async function lockClaim(orgId: string, id: string, token: string): Promise<StoredTransfer> {
  const job = await loadTransfer(orgId, id, true)
  if (job.claimToken !== token) throw new TransferRefusal('The worker claim was replaced; processing must restart from the stored checkpoint.')
  return job
}
export async function updateTransfer(job: StoredTransfer, patch: Partial<Pick<StoredTransfer,
  'state' | 'processedRows' | 'totalRows' | 'headers' | 'sample' | 'outcome' | 'preview' | 'error' | 'approvalHash' | 'sourceHash' | 'failedPhase' | 'bytes'
>>, event?: string) {
  const names: Record<keyof typeof patch, string> = { state: 'state', processedRows: 'processed_rows', totalRows: 'total_rows', headers: 'headers', sample: 'sample', outcome: 'outcome', preview: 'preview', error: 'error', approvalHash: 'approval_hash', sourceHash: 'source_hash', failedPhase: 'failed_phase', bytes: 'byte_count' }
  const jsonKeys = new Set(['headers', 'sample', 'outcome', 'preview'])
  const sets = Object.entries(patch).map(([key, value]) => sql`${sql.raw(names[key as keyof typeof patch])}=${jsonKeys.has(key) ? sql`${JSON.stringify(value)}::jsonb` : sql`${value}`}`)
  if (!sets.length) return
  const result = await db.execute(sql`update data_transfer_jobs set ${sql.join(sets, sql`, `)},updated_at=now(),claim_until=now()+interval '10 minutes' where org_id=${job.orgId} and id=${job.id} and revision=${job.revision} returning id`)
  if (result.rows.length !== 1) throw new TransferRefusal('The transfer changed concurrently — reload its current status before retrying.')
  if (patch.state) await updateImportHistory({ ...job, ...patch }, patch.state === 'completed' ? 'committed' : patch.state)
  if (event) await recordTransferEvent(job, event, patch.state ?? job.state, {
    ...patch,
    sourceHash: patch.sourceHash === undefined ? job.sourceHash : patch.sourceHash,
    approvalHash: patch.approvalHash === undefined ? job.approvalHash : patch.approvalHash,
  })
}
