import { ApplicationError } from '../application/errors'

/** Application errors are safe API feedback; arbitrary exceptions stay private. */
export function safeApplicationToolError(error: unknown): string {
  if (!(error instanceof ApplicationError) || error.status >= 500) return 'tool_failed'
  if (error.code === 'forbidden' || error.code === 'unauthorized') return error.code
  return `${error.code}: ${error.message}`
}
