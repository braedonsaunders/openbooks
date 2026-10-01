/** Durable transfer protocol. Counts refer to logical records, excluding headers. */
import type { ExportFormat, ImportMode, ResourceField, WriteOutcome } from './types'

export const TRANSFER_CHUNK_BYTES = 4 * 1024 * 1024
export const TRANSFER_BATCH_ROWS = 250
export const TRANSFER_BATCHES_PER_CLAIM = 20
export const TRANSFER_BATCH_BYTES = 8 * 1024 * 1024
export const TRANSFER_SAMPLE_ROWS = 20
export const TRANSFER_SAMPLE_BYTES = 64 * 1024
export const TRANSFER_MAX_ROW_BYTES = 4 * 1024 * 1024
export const TRANSFER_STATES = ['uploading', 'parsing', 'mapping', 'previewing', 'ready', 'committing', 'exporting', 'completed', 'failed', 'cancelled'] as const
export type TransferState = typeof TRANSFER_STATES[number]
export interface TransferOptions {
  mapping?: Record<string, string>
  importMode?: ImportMode
  post?: boolean
  columns?: string[]
}
export interface TransferJob {
  id: string
  kind: 'import' | 'export'
  resource: string
  format: ExportFormat
  filename: string
  state: TransferState
  revision: number
  bytes: number
  uploadedBytes: number
  totalRows: number
  processedRows: number
  headers: string[]
  fields: ResourceField[]
  sample: Record<string, unknown>[]
  options: TransferOptions
  outcome: WriteOutcome
  preview: WriteOutcome
  error: string | null
  workerActive: boolean
  lastActivity: string
  cancelRequested: boolean
  approvalHash: string | null
}
export type TransferSummary = Pick<TransferJob, 'id' | 'kind' | 'filename' | 'state'>
export class TransferRefusal extends Error {
  readonly name = 'TransferRefusal'
  constructor(message: string, readonly status = 409, readonly code = 'data_transfer_refused') { super(message) }
}
