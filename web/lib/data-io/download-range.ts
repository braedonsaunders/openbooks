import { TransferRefusal } from './transfer-contract'

/** One byte range permits download managers to resume an immutable artifact. */
export function transferDownloadRange(header: string | null, bytes: number): { start: number; end: number } | null {
  if (header === null) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  const refuse = () => { throw new TransferRefusal('The requested download range is unavailable — restart this export download.', 416) }
  if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(bytes) || bytes < 1) return refuse()
  const first = match[1] ? Number(match[1]) : null, last = match[2] ? Number(match[2]) : null
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return refuse()
  const start = first ?? Math.max(0, bytes - last!)
  const end = first === null ? bytes - 1 : Math.min(bytes - 1, last ?? bytes - 1)
  if ((first === null && last === 0) || start >= bytes || end < start) return refuse()
  return { start, end }
}
