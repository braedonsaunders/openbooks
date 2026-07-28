import { normalizeMoney } from '@openbooks/engine/src/money.ts'

const TASK_STATUSES = ['open', 'complete', 'cancelled'] as const
type TaskStatus = (typeof TASK_STATUSES)[number]

export interface WorkBreakdownTaskInput {
  code: string | null
  name: string
  status: TaskStatus
  estimatedHours: string | null
  estimatedCost: string | null
}

export class ProjectWorkBreakdownError extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message)
  }
}

function optionalText(value: unknown, max: number, label: string): string | null {
  if (value == null || value === '') return null
  if (typeof value !== 'string') throw new ProjectWorkBreakdownError(`${label} must be text`)
  const normalized = value.trim()
  if (!normalized) return null
  if (normalized.length > max) {
    throw new ProjectWorkBreakdownError(`${label} must be ${max} characters or fewer`)
  }
  return normalized
}

function nonnegativeDecimal(value: unknown, label: string): string | null {
  if (value == null || value === '') return null
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new ProjectWorkBreakdownError(`${label} must be a number`)
  }
  let normalized: string
  try {
    normalized = normalizeMoney(String(value))
  } catch {
    throw new ProjectWorkBreakdownError(`${label} must be a number`)
  }
  if (normalized.startsWith('-')) {
    throw new ProjectWorkBreakdownError(`${label} cannot be negative`)
  }
  const integerDigits = normalized.split('.')[0]!.replace(/^0+/, '').length
  if (integerDigits > 15) {
    throw new ProjectWorkBreakdownError(`${label} is too large`)
  }
  return normalized
}

/** Validate the complete WBS editor payload before opening a transaction. */
export function parseWorkBreakdownTaskInput(input: unknown): WorkBreakdownTaskInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ProjectWorkBreakdownError('Task details are required')
  }
  const body = input as Record<string, unknown>
  const allowed = new Set(['code', 'name', 'status', 'estimatedHours', 'estimatedCost'])
  const unknown = Object.keys(body).find((key) => !allowed.has(key))
  if (unknown) throw new ProjectWorkBreakdownError(`Unknown task field: ${unknown}`)

  if (typeof body.name !== 'string' || !body.name.trim()) {
    throw new ProjectWorkBreakdownError('Task name is required')
  }
  const name = body.name.trim()
  if (name.length > 300) {
    throw new ProjectWorkBreakdownError('Task name must be 300 characters or fewer')
  }
  const status = body.status ?? 'open'
  if (!TASK_STATUSES.includes(status as TaskStatus)) {
    throw new ProjectWorkBreakdownError('Invalid task status')
  }

  return {
    code: optionalText(body.code, 80, 'Task code'),
    name,
    status: status as TaskStatus,
    estimatedHours: nonnegativeDecimal(body.estimatedHours, 'Estimated hours'),
    estimatedCost: nonnegativeDecimal(body.estimatedCost, 'Estimated cost'),
  }
}

export function parseExpectedTaskVersion(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) {
    throw new ProjectWorkBreakdownError('A valid task version is required')
  }
  return new Date(value).toISOString()
}
