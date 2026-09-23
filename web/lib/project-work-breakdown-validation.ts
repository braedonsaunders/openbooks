import { isDocumentRevisionToken } from '@openbooks/engine/src/records/revision.ts'
import { normalizeMoney } from '@openbooks/engine/src/money/money.ts'
import { canonicalDecimal } from './exact-decimal'

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

/**
 * Closed-task lifecycle: a finished task never slides sideways between
 * terminal states — complete ↔ cancelled moves reopen through open, so the
 * reopen (and its reason) is always visible in history.
 */
const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  open: ['open', 'complete', 'cancelled'],
  complete: ['complete', 'open'],
  cancelled: ['cancelled', 'open'],
}

const CLOSED_STATUSES: readonly TaskStatus[] = ['complete', 'cancelled']

/** Canonical four-decimal comparison: '10' and '10.0000' are the same budget. */
export function sameTaskDecimal(before: string | null | undefined, after: string | null | undefined): boolean {
  const normalized = (value: string | null | undefined): string | null => {
    if (value === null || value === undefined || value === '') return null
    return canonicalDecimal(value, 4)
  }
  return normalized(before) === normalized(after)
}

/**
 * Enforce the status transition table and the reason rule for closed tasks:
 * reopening a complete/cancelled task, or changing its estimates while it
 * stays closed, requires a reason — renames and same-state saves do not.
 * Throws ProjectWorkBreakdownError naming the remedy.
 */
export function assertTaskTransition(args: {
  from: TaskStatus
  to: TaskStatus
  estimatedHoursChanged: boolean
  estimatedCostChanged: boolean
  reason: string | null
}): void {
  if (!TASK_TRANSITIONS[args.from].includes(args.to)) {
    if (args.from === 'complete' && args.to === 'cancelled') {
      throw new ProjectWorkBreakdownError('Reopen the task before cancelling it')
    }
    if (args.from === 'cancelled' && args.to === 'complete') {
      throw new ProjectWorkBreakdownError('Reopen the task before completing it')
    }
    throw new ProjectWorkBreakdownError(`Cannot move a task from ${args.from} to ${args.to}`)
  }
  const wasClosed = (CLOSED_STATUSES as readonly string[]).includes(args.from)
  const reopening = wasClosed && args.to === 'open'
  const budgetChangedOnClosed = wasClosed && (args.estimatedHoursChanged || args.estimatedCostChanged)
  if ((reopening || budgetChangedOnClosed) && !args.reason) {
    throw new ProjectWorkBreakdownError(
      reopening
        ? 'Reopening a closed task requires a reason'
        : 'Changing estimates on a closed task requires a reason',
    )
  }
}

/**
 * Parse the optional reopen/budget-change reason: absent or blank stays
 * null (the transition rule decides whether null is acceptable); a present
 * reason must be short text, matching the admin identity-link reason shape.
 */
export function parseTaskReason(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') throw new ProjectWorkBreakdownError('Reason must be text')
  const reason = value.trim()
  if (!reason) return null
  if (reason.length > 500) {
    throw new ProjectWorkBreakdownError('Reason must be 500 characters or fewer')
  }
  return reason
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
  const exact = canonicalDecimal(value, 4)
  if (exact === null) {
    throw new ProjectWorkBreakdownError(`${label} must be a number`)
  }
  let normalized: string
  try {
    normalized = normalizeMoney(exact)
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
  if (!isDocumentRevisionToken(value)) {
    throw new ProjectWorkBreakdownError('A valid task version is required')
  }
  return value
}
