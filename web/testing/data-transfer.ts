import type { TransferJob } from '../lib/data-io/transfer-contract'

/** Network fixtures describe observable protocol states, not domain validation. */
export function dataTransferJob(patch: Partial<TransferJob> = {}): TransferJob {
  return {
    id: '00000000-0000-4000-8000-000000000001', kind: 'import', resource: 'customers', format: 'csv', filename: 'import.csv',
    state: 'uploading', revision: 1, bytes: 9, uploadedBytes: 0, totalRows: 0, processedRows: 0,
    headers: ['Name'], fields: [{ key: 'name', label: 'Name', kind: 'text' }], sample: [{ Name: 'Acme' }],
    options: {}, outcome: { created: 0, updated: 0, failed: 0, errors: [] }, preview: { created: 0, updated: 0, failed: 0, errors: [] },
    error: null, workerActive: true, lastActivity: '2026-10-01T12:00:00.000Z', cancelRequested: false, approvalHash: null, ...patch,
  }
}
