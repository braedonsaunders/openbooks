/**
 * Which week "New timesheet" opens, decided without a session so the rule is
 * testable on its own.
 *
 * - A login linked to an in-scope timekeeper always starts its own week.
 * - Only someone who manages other people's time (the supervisory
 *   time.manage grant) may start from the first active timekeeper as a picker
 *   seed.
 * - A self-service time enterer (time.self) is never handed another person's
 *   week. When there is nothing to open the action is withdrawn and the
 *   caller shows the named refusal with its remedy.
 */

export type NewTimesheetRefusal = 'unlinked' | 'linkedOutOfScope' | 'noEmployees'

export interface NewTimesheetStart {
  employeeId: string | null
  /** Set only for a time enterer with nothing to open. */
  refusal: NewTimesheetRefusal | null
}

/** time.manage is the supervisory grant over everyone's time; time.self is one's own. */
export function managesOthersTime(can: (permission: string) => boolean): boolean {
  return can('time.manage')
}

export async function resolveNewTimesheetStart(input: {
  canManage: boolean
  managesOthersTime: boolean
  linkedEmployeeId: string | null
  /** Returns the timekeeper id when it is active and inside the caller's scope. */
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
