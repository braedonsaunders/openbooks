import type { EnrollmentDrawerRecord } from '../../app/(app)/hrm/benefits/EnrollmentDrawer'

export interface EmployeeBenefitAssignment {
  id: string
  nativeId: string
  nativeKind: 'enrollment' | 'membership' | 'vacation_terms'
  programId: string
  programName: string
  programType: string
  programTypeLabel: string
  programHref: string
  employmentId: string
  employeePartyId: string
  employeeName: string
  employeeHref: string
  assignmentHref: string
  status: string
  statusLabel: string
  effectiveFrom: string
  effectiveTo: string | null
}

export type EmployeeBenefitPolicyRow = Record<string, unknown> & {
  id: string
  employment_id: string
  effective_from: string
  effective_to: string | null
}

export interface EmployeeBenefitsData {
  employments: { value: string; label: string }[]
  assignments: EmployeeBenefitAssignment[]
  enrollments: { id: string; record: EnrollmentDrawerRecord; canChange: boolean }[]
  vacation: EmployeeBenefitPolicyRow[]
  service: EmployeeBenefitPolicyRow[]
  programs: { value: string; label: string }[]
  canManage: boolean
  canReadBanks: boolean
  payroll: boolean
}

export interface BenefitParticipantInput {
  id: string
  programId: string
  nativeKind: EmployeeBenefitAssignment['nativeKind']
  employmentId: string
  employeePartyId: string
  employeeName: string
  status: string
  effectiveFrom: string
  effectiveTo: string | null
}

export class EmployeeBenefitAssignmentError extends Error {
  readonly status = 409
  readonly code = 'PROGRAM_SCOPE_MISMATCH'
  constructor(employeeName: string) {
    super(`The benefit assignment for ${employeeName} has no accessible program. Check the program and employee legal-employer scope before continuing.`)
    this.name = 'EmployeeBenefitAssignmentError'
  }
}

/** A cross-program view must preserve every authorized relationship and its native identity. */
export function employeeBenefitAssignments(
  programs: { id: string; name: string; type: string }[],
  participants: BenefitParticipantInput[],
  labels: { type: (type: string) => string; status: (status: string) => string },
): EmployeeBenefitAssignment[] {
  const byId = new Map(programs.map(program => [program.id, program]))
  return participants.map(participant => {
    const program = byId.get(participant.programId)
    if (!program) throw new EmployeeBenefitAssignmentError(participant.employeeName)
    const programHref = `/hrm/benefits?view=programs&program=${encodeURIComponent(program.id)}`
    return {
      ...participant,
      id: `${participant.nativeKind}:${participant.id}`,
      nativeId: participant.id,
      programName: program.name,
      programType: program.type,
      programTypeLabel: labels.type(program.type),
      statusLabel: labels.status(participant.status),
      programHref,
      employeeHref: `/entities/employees?party=${encodeURIComponent(participant.employeePartyId)}&entityTab=benefits`,
      assignmentHref: participant.nativeKind === 'enrollment'
        ? `/hrm/benefits?view=employees&enrollmentConfig=${encodeURIComponent(participant.id)}`
        : participant.nativeKind === 'vacation_terms'
          ? `/hrm/benefits?view=employees&vacationTerms=${encodeURIComponent(participant.id)}`
          : `${programHref}&transactionTab=participants`,
    }
  }).sort((left, right) => left.employeeName.localeCompare(right.employeeName) || left.programName.localeCompare(right.programName) || right.effectiveFrom.localeCompare(left.effectiveFrom) || left.id.localeCompare(right.id))
}

/** Loaded native tables require the complete service population, including the last page. */
export async function completeBenefitPopulation<T>(read: (query: { limit: number; offset: number }) => Promise<T[]>): Promise<T[]> {
  const pageSize = 500
  const population: T[] = []
  for (let offset = 0; ; offset += pageSize) {
    const page = await read({ limit: pageSize, offset })
    population.push(...page)
    if (page.length < pageSize) return population
  }
}
