import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import type { Authz } from '../authz'
import { duplicateMappingTarget } from './mapping'
import { canonical, digest, emptyOutcome, loadTransfer, publicTransfer, recordTransferEvent, transferAuthority, updateImportHistory, type StoredTransfer } from './transfer-store'
import { TRANSFER_CHUNK_BYTES, TransferRefusal, type TransferOptions } from './transfer-contract'

export async function uploadTransferPart(authz: Authz, id: string, part: number, bytes: Buffer) {
  const job = await loadTransfer(authz.user.orgId, id, true)
  await transferAuthority(job, authz)
  if (job.kind !== 'import' || job.state !== 'uploading') throw new TransferRefusal('This transfer is no longer accepting file parts.')
  const hash = digest(bytes)
  const existing = (await db.execute<{ sha256: string }>(sql`select sha256 from data_transfer_chunks where org_id=${job.orgId} and job_id=${id} and direction='source' and part_no=${part}`)).rows[0]
  if (existing) {
    if (existing.sha256 !== hash) throw new TransferRefusal('This file part differs from the uploaded source — select the same file or create a new import.')
    return publicTransfer(job)
  }
  const expected = Math.floor(job.uploadedBytes / TRANSFER_CHUNK_BYTES)
  if (part !== expected || bytes.length !== Math.min(TRANSFER_CHUNK_BYTES, job.bytes - job.uploadedBytes)) throw new TransferRefusal('This file part is out of sequence or has the wrong size — resume from the server upload position.')
  await db.execute(sql`insert into data_transfer_chunks (org_id,job_id,direction,part_no,data,sha256) values (${job.orgId},${id},'source',${part},${bytes},${hash})`)
  const result = await db.execute(sql`update data_transfer_jobs set uploaded_bytes=uploaded_bytes+${bytes.length},updated_at=now() where org_id=${job.orgId} and id=${id} returning id`)
  if (result.rows.length !== 1) throw new Error('Upload checkpoint did not persist')
  return publicTransfer(await loadTransfer(job.orgId, id))
}

async function transition(job: StoredTransfer, state: StoredTransfer['state'], action: string, options = job.options) {
  const result = await db.execute(sql`update data_transfer_jobs set state=${state},revision=revision+1,options=${JSON.stringify(options)}::jsonb,
    updated_at=now(),claim_token=null,claim_until=null,error=null where org_id=${job.orgId} and id=${job.id} and revision=${job.revision} returning id`)
  if (result.rows.length !== 1) throw new TransferRefusal('The transfer changed concurrently — reload its current status before retrying.')
  await recordTransferEvent(job, action, state, { beforeOptions: job.options, options, previousRevision: job.revision, sourceHash: job.sourceHash, approvalHash: job.approvalHash })
  await updateImportHistory(await loadTransfer(job.orgId, job.id), state)
}
export async function commandTransfer(authz: Authz, id: string, input: {
  action: 'finish-upload' | 'preview' | 'commit' | 'cancel' | 'retry'
  revision: number
  approvalHash?: string
  options?: TransferOptions
}) {
  const job = await loadTransfer(authz.user.orgId, id, true)
  const { resource } = await transferAuthority(job, authz)
  // Replayed commit commands observe the same job, never create a second run.
  if (input.action === 'commit' && ['committing', 'completed'].includes(job.state) && input.approvalHash === job.approvalHash) return publicTransfer(job)
  if (job.revision !== input.revision) throw new TransferRefusal('The transfer changed concurrently — reload its current status before issuing this command.')
  if (input.action === 'cancel') {
    if (['completed', 'cancelled'].includes(job.state)) return publicTransfer(job)
    const active = ['parsing', 'previewing', 'committing', 'exporting'].includes(job.state)
    const result = await db.execute(sql`update data_transfer_jobs set cancel_requested=true,state=${active ? job.state : 'cancelled'},revision=revision+1,updated_at=now() where org_id=${job.orgId} and id=${id} returning id`)
    if (result.rows.length !== 1) throw new TransferRefusal('Cancellation did not persist — reload the transfer and retry.')
    await recordTransferEvent(job, 'cancellation-requested', active ? job.state : 'cancelled', { committed: job.outcome, checkpoint: job.processedRows })
    if (!active) await updateImportHistory(job, 'cancelled')
  } else if (input.action === 'finish-upload') {
    if (job.state !== 'uploading' || job.uploadedBytes !== job.bytes || !job.bytes) throw new TransferRefusal('The source upload is incomplete — upload its remaining file parts before continuing.')
    await transition(job, 'parsing', 'upload-completed')
  } else if (input.action === 'preview') {
    if (job.kind !== 'import' || !['mapping', 'ready'].includes(job.state)) throw new TransferRefusal('This import is not ready for mapping — wait for source parsing to finish.')
    const options: TransferOptions = { mapping: input.options?.mapping ?? {}, importMode: input.options?.importMode ?? 'upsert', post: input.options?.post ?? false }
    const duplicate = duplicateMappingTarget(options.mapping!)
    if (duplicate) throw new TransferRefusal(`Columns "${duplicate.sources[0]}" and "${duplicate.sources[1]}" both map to "${duplicate.field}" — keep one source column for this field.`, 422)
    const fields = await resource.fields()
    for (const [source, target] of Object.entries(options.mapping!)) {
      if (!job.headers.includes(source) || (target && !fields.some((field) => field.key === target && !field.readOnly))) throw new TransferRefusal(`Mapping "${source}" → "${target}" is unavailable — select an existing source and editable field.`, 422)
    }
    for (const field of fields.filter((field) => field.required && !field.readOnly)) {
      if (!Object.values(options.mapping!).includes(field.key)) throw new TransferRefusal(`Map the required "${field.label}" field before validating.`, 422)
    }
    if (!Object.values(options.mapping!).some(Boolean)) throw new TransferRefusal('Map at least one source column before validating.', 422)
    await transferAuthority({ ...job, options }, authz)
    await db.execute(sql`delete from data_transfer_issues where org_id=${job.orgId} and job_id=${id} and phase='preview'`)
    await db.execute(sql`delete from data_transfer_keys where org_id=${job.orgId} and job_id=${id}`)
    const reset = await db.execute(sql`update data_transfer_jobs set processed_rows=0,preview=${JSON.stringify(emptyOutcome())}::jsonb,approval_hash=null where org_id=${job.orgId} and id=${id} returning id`)
    if (reset.rows.length !== 1) throw new TransferRefusal('The preview checkpoint did not persist — reload the transfer before retrying.')
    await transition(job, 'previewing', 'preview-requested', options)
  } else if (input.action === 'commit') {
    if (job.kind !== 'import' || job.state !== 'ready' || job.preview.failed !== 0 || !job.approvalHash || input.approvalHash !== job.approvalHash) throw new TransferRefusal('Commit requires a clean preview and its current approval — correct the row errors and validate again.', 422)
    const reset = await db.execute(sql`update data_transfer_jobs set processed_rows=0 where org_id=${job.orgId} and id=${id} returning id`)
    if (reset.rows.length !== 1) throw new TransferRefusal('The commit checkpoint did not persist — reload the transfer before retrying.')
    await transition(job, 'committing', 'preview-approved')
  } else {
    if (job.state !== 'failed' || !job.failedPhase || !['parsing', 'previewing', 'committing', 'exporting'].includes(job.failedPhase)) throw new TransferRefusal('Only a failed worker phase can be retried — create a new transfer for a corrected source.')
    const fields = await resource.fields(), columns = await resource.columns()
    if (digest(canonical({ fields, columns })) !== job.schemaHash) throw new TransferRefusal('The resource schema changed — create a new transfer and approve its new preview.', 422)
    if (job.cancelRequested) throw new TransferRefusal('This transfer was cancelled — create a new transfer to continue.')
    if (job.failedPhase === 'committing') {
      await db.execute(sql`delete from data_transfer_issues where org_id=${job.orgId} and job_id=${id} and phase='commit'`)
      const reset = await db.execute(sql`update data_transfer_jobs set outcome=${JSON.stringify({ ...job.outcome, failed: 0, errors: [] })}::jsonb where org_id=${job.orgId} and id=${id} returning id`)
      if (reset.rows.length !== 1) throw new TransferRefusal('The retry checkpoint did not persist — reload the transfer before retrying.')
    }
    await transition(job, job.failedPhase, 'retry-requested')
  }
  return publicTransfer(await loadTransfer(job.orgId, id))
}
