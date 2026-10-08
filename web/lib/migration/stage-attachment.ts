'use client'
import { readApiErrorMessage } from '../api-error'
import { requestTransfer, uploadTransfer } from '../data-io/transfer-client'
import { provisionalResourceForFile } from '../data-io/resource-match'
import type { TransferJob } from '../data-io/transfer-contract'

/**
 * Stage a file dropped into the migration conversation through the native
 * durable import: create the transfer, upload its checksummed parts, and
 * wait until the worker has read it. Nothing is imported — the staged file
 * waits for the assistant (or the import wizard) to select its resource,
 * validate a mapping, and for the operator to approve the commit.
 */

const FORMATS: Record<string, TransferJob['format']> = { csv: 'csv', txt: 'csv', xlsx: 'xlsx', json: 'json' }
const READ_TIMEOUT_MS = 90_000

export class AttachmentRefusal extends Error {
  readonly name = 'AttachmentRefusal'
}

export interface AttachmentText {
  unsupported: string
  noImport: string
  uploading: (name: string) => string
  reading: (name: string) => string
  staged: (name: string, id: string, rows: number) => string
  stillReading: (name: string, id: string) => string
  failed: (name: string, reason: string) => string
}

export async function stageImportAttachment(file: File, text: AttachmentText, onProgress: (label: string) => void): Promise<string> {
  const extension = file.name.toLowerCase().split('.').pop() ?? ''
  const format = FORMATS[extension]
  if (!format) throw new AttachmentRefusal(text.unsupported)
  const listing = await fetch('/api/data/resources', { cache: 'no-store' })
  if (!listing.ok) throw new AttachmentRefusal(await readApiErrorMessage(listing, text.noImport))
  const { resources } = await listing.json() as { resources?: { key: string; supportsImport?: boolean }[] }
  const importable = (resources ?? []).filter((resource) => resource.supportsImport).map((resource) => resource.key)
  const resource = provisionalResourceForFile(file.name, importable)
  if (!resource) throw new AttachmentRefusal(text.noImport)

  onProgress(text.uploading(file.name))
  const created = await requestTransfer('/api/data/transfers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestKey: crypto.randomUUID(), kind: 'import', resource, format, filename: file.name, bytes: file.size }),
  })
  let job = await uploadTransfer(file, created, () => onProgress(text.uploading(file.name)))
  onProgress(text.reading(file.name))
  const deadline = Date.now() + READ_TIMEOUT_MS
  while (job.state === 'uploading' || job.state === 'parsing') {
    if (Date.now() > deadline) return text.stillReading(file.name, job.id)
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    job = await requestTransfer(`/api/data/transfers/${job.id}`)
  }
  if (job.state === 'failed') throw new AttachmentRefusal(text.failed(file.name, job.error ?? ''))
  return text.staged(file.name, job.id, job.totalRows)
}
