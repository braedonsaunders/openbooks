/**
 * Which week "New timesheet" opens, decided without a session so the rule is
 * testable on its own.
 *
 * - A login linked to an in-scope employee always starts its own week.
 * - Only someone who manages other people's time (time.manage plus a duty
 *   that acts on other people's hours: approving timesheets or entering crew
 *   time) may start from the first active employee as a picker seed.
 * - A self-service time enterer is never handed another person's week. When
 *   there is nothing to open the action is withdrawn and the caller shows the
 *   named refusal with its remedy.
 */

export type NewTimesheetRefusal = 'unlinked' | 'linkedOutOfScope' | 'noEmployees'

export interface NewTimesheetStart {
  employeeId: string | null
  /** Set only for a time enterer with nothing to open. */
  refusal: NewTimesheetRefusal | null
}

/** Grants that act on other people's hours, beyond entering one's own. */
export const OTHERS_TIME_DUTIES = ['time.approve', 'time.crew.enter'] as const

export function managesOthersTime(can: (permission: string) => boolean): boolean {
  return can('time.manage') && OTHERS_TIME_DUTIES.some((permission) => can(permission))
}

export async function resolveNewTimesheetStart(input: {
  canManage: boolean
  managesOthersTime: boolean
  linkedEmployeeId: string | null
  /** Returns the employee id when it is active and inside the caller's scope. */
  pinInScope: (employeeId: string) => Promise<string | null>
  firstActiveEmployeeId: string | null
}): Promise<NewTimesheetStart> {
  if (!input.canManage) return { employeeId: null, refusal: null }
  const own = input.linkedEmployeeId ? await input.pinInScope(input.linkedEmployeeId) : null
  if (own) return { employeeId: own, refusal: null }
  if (input.managesOthersTime) {
    return input.firstActiveEmployeeId
      ? { employeeId: input.firstActiveEmployeeId, refusal: null }
      : { employeeId: null, refusal: 'noEmployees' }
  }
  return { employeeId: null, refusal: input.linkedEmployeeId ? 'linkedOutOfScope' : 'unlinked' }
}
