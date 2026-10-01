'use client'
import { useCallback, useEffect, useState } from 'react'
import { readApiErrorMessage } from '../api-error'
import { TRANSFER_CHUNK_BYTES, type TransferJob } from './transfer-contract'

export async function requestTransfer(url: string, init?: RequestInit): Promise<TransferJob> {
  const response = await fetch(url, { ...init, cache: 'no-store' })
  if (!response.ok) throw new Error(await readApiErrorMessage(response, 'The transfer request could not be completed.'))
  const result = await response.json()
  if (!result.job) throw new Error('The server returned no transfer status — refresh and try again.')
  return result.job as TransferJob
}
export const transferCommand = (job: TransferJob, action: string, values: Record<string, unknown> = {}) =>
  requestTransfer(`/api/data/transfers/${job.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, revision: job.revision, ...values }) })

export async function uploadTransfer(source: Blob, job: TransferJob, onProgress: (job: TransferJob) => void): Promise<TransferJob> {
  let live = job
  // Verify the already acknowledged prefix locally before appending bytes.
  // Name and size alone cannot distinguish two different source files.
  for (let position = 0; position < job.uploadedBytes; position += TRANSFER_CHUNK_BYTES) {
    const response = await fetch(`/api/data/transfers/${job.id}/chunks/${Math.floor(position / TRANSFER_CHUNK_BYTES)}`, { cache: 'no-store' })
    if (!response.ok) throw new Error(await readApiErrorMessage(response, 'The uploaded source could not be verified.'))
    const { part } = await response.json()
    const bytes = await source.slice(position, position + TRANSFER_CHUNK_BYTES).arrayBuffer()
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map((byte) => byte.toString(16).padStart(2, '0')).join('')
    if (!part || part.bytes !== bytes.byteLength || part.sha256 !== hash) throw new Error('This file differs from the uploaded source — select the original file or create a new import.')
  }
  for (let position = job.uploadedBytes; position < source.size; position += TRANSFER_CHUNK_BYTES) {
    const part = Math.floor(position / TRANSFER_CHUNK_BYTES)
    // Only this slice is read by the browser; the complete File stays on disk.
    live = await requestTransfer(`/api/data/transfers/${job.id}/chunks/${part}`, { method: 'PUT', body: source.slice(position, position + TRANSFER_CHUNK_BYTES), headers: { 'Content-Type': 'application/octet-stream' } })
    onProgress(live)
  }
  return transferCommand(live, 'finish-upload')
}
const running = new Set(['parsing', 'previewing', 'committing', 'exporting'])
export function useTransferJob(kind: TransferJob['kind']) {
  const [job, setJob] = useState<TransferJob | null>(null)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const jobId = job?.id, jobState = job?.state
  const remember = useCallback((next: TransferJob | null) => {
    setJob(next); setConnectionError(null)
    const url = new URL(window.location.href)
    if (next) url.searchParams.set('transfer', next.id)
    else url.searchParams.delete('transfer')
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
  }, [])
  useEffect(() => {
    const id = new URL(window.location.href).searchParams.get('transfer')
    if (!id) return
    const abort = new AbortController()
    void requestTransfer(`/api/data/transfers/${encodeURIComponent(id)}`, { signal: abort.signal }).then((next) => {
      if (next.kind !== kind) throw new Error('This transfer belongs to the other data workspace — open it from the matching import or export page.')
      setJob(next)
    }).catch((error: Error) => { if (!abort.signal.aborted) setConnectionError(error.message) })
    return () => abort.abort()
  }, [kind])
  useEffect(() => {
    if (!jobId || !jobState || !running.has(jobState)) return
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout>, failures = 0
    const poll = async () => {
      try {
        const next = await requestTransfer(`/api/data/transfers/${jobId}`, { signal: abort.signal })
        if (abort.signal.aborted) return
        setJob(next); setConnectionError(null); failures = 0
        if (!running.has(next.state)) return
      } catch (error) {
        if (abort.signal.aborted) return
        setConnectionError((error as Error).message); failures++
      }
      timer = setTimeout(() => { void poll() }, Math.min(30_000, 2000 * 2 ** Math.min(failures, 4)))
    }
    timer = setTimeout(() => { void poll() }, 1000)
    return () => { clearTimeout(timer); abort.abort() }
  }, [jobId, jobState])
  return { job, remember, connectionError, running: !!job && running.has(job.state) }
}
