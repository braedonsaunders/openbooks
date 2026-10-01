import { NextResponse } from 'next/server'
import { can, getAuthz } from '../authz'
import { TRANSFER_CHUNK_BYTES, TransferRefusal } from './transfer-contract'

export const transferFeature = { none: 'Import and export are common ERP data controls with resource-specific authority and feature checks.' }
export async function authorizeTransfers() {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'Sign in to access data transfers.' }, { status: 401 })
  if (!can(authz, 'data.import') && !can(authz, 'data.export')) return NextResponse.json({ error: 'A data.import or data.export permission is required.' }, { status: 403 })
  return authz
}
export async function boundedTransferChunk(request: Request): Promise<Buffer> {
  if (Number(request.headers.get('content-length') ?? 0) > TRANSFER_CHUNK_BYTES) throw new TransferRefusal('Upload each file part in chunks of at most 4 MiB.', 413)
  if (!request.body) throw new TransferRefusal('The upload part is empty — retry this part.', 422)
  const reader = request.body.getReader(), parts: Uint8Array[] = []
  let count = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      count += value.byteLength
      if (count > TRANSFER_CHUNK_BYTES) { await reader.cancel(); throw new TransferRefusal('Upload each file part in chunks of at most 4 MiB.', 413) }
      parts.push(value)
    }
  } finally { reader.releaseLock() }
  if (!count) throw new TransferRefusal('The upload part is empty — retry this part.', 422)
  return Buffer.concat(parts, count)
}
