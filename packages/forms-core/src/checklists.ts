import { z } from 'zod'
import { RECORD_FIELD_TYPES } from './record-data'
import { evaluateLogicRule } from './evaluator'
import { formSchemaV1Schema, logicRuleSchema, lintFormSchema, type LogicRule } from './schema'

export const CHECKLIST_STEP_SUBJECT_KIND = 'hrm_process_step'
export const checklistContextFields = ['employerSubsidiaryId', 'departmentId', 'kind'] as const
const id = z.string().uuid()
export const checklistStepDesignSchema = z.object({
  section: z.string().max(120).default(''),
  dependencies: z.array(id).max(100).default([]),
  condition: logicRuleSchema.nullable().default(null),
  form: formSchemaV1Schema.nullable().default(null),
  approval: z.boolean().default(false),
  reminderDays: z.number().int().min(0).max(365).nullable().default(null),
  resources: z
    .array(z.object({ label: z.string().max(200), url: z.string().max(2000) }))
    .max(20)
    .default([]),
})
export const checklistStepSchema = z.object({
  id,
  title: z.string().max(300),
  description: z.string().max(12000).nullable(),
  ownerKind: z.enum(['manager', 'hr', 'employee', 'named_party']),
  ownerPartyId: id.nullable(),
  dueOffsetDays: z.number().int().min(-3650).max(3650),
  required: z.boolean(),
  evidenceKind: z.enum(['none', 'acknowledgement', 'attachment']),
  design: checklistStepDesignSchema,
})
export const checklistDocumentSchema = z.object({
  name: z.string().max(200),
  kind: z.enum(['onboarding', 'offboarding', 'transfer']),
  appliesTo: z.object({ employerSubsidiaryId: id.nullable(), departmentId: id.nullable() }),
  steps: z.array(checklistStepSchema).max(200),
})
export type ChecklistDocument = z.infer<typeof checklistDocumentSchema>
export type ChecklistStep = z.infer<typeof checklistStepSchema>
export type ChecklistStepDesign = z.infer<typeof checklistStepDesignSchema>
export const emptyStepDesign = (): ChecklistStepDesign => ({
  section: '',
  dependencies: [],
  condition: null,
  form: null,
  approval: false,
  reminderDays: null,
  resources: [],
})
export type ChecklistIssue = { stepId?: string; message: string }
function ruleFields(rule: LogicRule, depth = 0): string[] {
  if (depth > 8) throw new Error('Conditions exceed eight levels — simplify the rule')
  if ('field' in rule) return [rule.field]
  if ('rule' in rule) return ruleFields(rule.rule, depth + 1)
  return rule.rules.flatMap((r) => ruleFields(r, depth + 1))
}
export function checklistConditionPredicates(
  rule: LogicRule,
): Extract<LogicRule, { field: string }>[] {
  if ('field' in rule) return [rule]
  if ('rule' in rule) return checklistConditionPredicates(rule.rule)
  return rule.rules.flatMap(checklistConditionPredicates)
}
/** Publication checks describe the complete process, including dependency cycles. */
export function checklistIssues(doc: ChecklistDocument): ChecklistIssue[] {
  const issues: ChecklistIssue[] = []
  if (!doc.name.trim()) issues.push({ message: 'Name the checklist before publishing.' })
  if (!doc.steps.length) issues.push({ message: 'Add at least one step before publishing.' })
  const ids = new Set(doc.steps.map((s) => s.id))
  if (ids.size !== doc.steps.length)
    issues.push({ message: 'Each step must have a distinct identity.' })
  for (const step of doc.steps) {
    const add = (message: string) => issues.push({ stepId: step.id, message })
    if (!step.title.trim()) add('Give this step a title.')
    if (
      !Number.isInteger(step.dueOffsetDays) ||
      step.dueOffsetDays < -3650 ||
      step.dueOffsetDays > 3650
    )
      add('Enter a whole number of days between -3650 and 3650 for the due date.')
    for (const resource of step.design.resources) {
      try {
        const url = new URL(resource.url)
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error()
      } catch {
        add('Give every resource an HTTP or HTTPS link, or remove the unfinished link.')
      }
    }
    if ((step.ownerKind === 'named_party') !== (step.ownerPartyId !== null))
      add('Choose a named owner, or clear the named person for a role assignment.')
    if (step.design.dependencies.some((x) => !ids.has(x) || x === step.id))
      add('Dependencies must name another step in this checklist.')
    if (new Set(step.design.dependencies).size !== step.design.dependencies.length)
      add('Remove duplicate dependencies.')
    if (step.design.form) {
      for (const issue of lintFormSchema(step.design.form)) add(`Response form: ${issue.message}.`)
      for (const field of step.design.form.sections.flatMap((s) => s.fields)) {
        if (!RECORD_FIELD_TYPES.includes(field.type))
          add(
            `Response form field "${field.label}" uses an unsupported type — use a supported field, or collect a file through File Cabinet evidence.`,
          )
      }
    }
    if (step.design.condition) {
      try {
        if (
          ruleFields(step.design.condition).some(
            (f) => !checklistContextFields.includes(f as (typeof checklistContextFields)[number]),
          )
        )
          add('Conditions may use the employer, department and process kind only.')
      } catch (error) {
        add(error instanceof Error ? error.message : 'Simplify this condition.')
        continue
      }
      for (const predicate of checklistConditionPredicates(step.design.condition)) {
        if (
          ['gt', 'lt', 'gte', 'lte'].includes(predicate.op) ||
          ('valueType' in predicate && predicate.valueType)
        )
          add(
            'Employer, department and process kind conditions use equality, membership or presence — choose a matching operator.',
          )
        if (!('value' in predicate)) continue
        const values = Array.isArray(predicate.value) ? predicate.value : [predicate.value]
        for (const value of values) {
          if (value === null) continue
          if (
            predicate.field === 'kind'
              ? !['onboarding', 'offboarding', 'transfer'].includes(String(value))
              : !id.safeParse(value).success
          )
            add('Choose a valid employer, department or process kind from the condition picker.')
        }
      }
    }
  }
  const visiting = new Set<string>(),
    visited = new Set<string>()
  function walk(id: string): boolean {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    const cycle = doc.steps.find((s) => s.id === id)?.design.dependencies.some(walk) ?? false
    visiting.delete(id)
    visited.add(id)
    return cycle
  }
  if (doc.steps.some((s) => walk(s.id)))
    issues.push({
      message: 'Steps form a dependency cycle — remove a dependency so work can progress.',
    })
  return issues
}
/** Conditions resolve once when the checklist opens; history is never re-evaluated. */
export function includedChecklistSteps(
  doc: ChecklistDocument,
  values: Record<string, unknown>,
): ChecklistStep[] {
  const included = doc.steps.filter(
    (s) => !s.design.condition || evaluateLogicRule(s.design.condition, { values, rows: {} }),
  )
  const ids = new Set(included.map((s) => s.id))
  for (const s of included)
    if (s.design.dependencies.some((id) => !ids.has(id)))
      throw new Error(
        `Step "${s.title}" depends on a step excluded by its condition — align their conditions before starting the checklist.`,
      )
  if (!included.length)
    throw new Error(
      'The conditions exclude every step — revise the template for this employee before starting a checklist.',
    )
  return included
}

export type ChecklistExecutionStep = {
  id: string
  sourceStepId: string | null
  status: string
  approvalStatus?: string
  dueOn: string
  position: number
  design?: Pick<ChecklistStepDesign, 'dependencies'>
}
/** Ready work excludes outstanding approvals and missing or pending prerequisites. */
export function actionableChecklistSteps<T extends ChecklistExecutionStep>(
  steps: readonly T[],
): T[] {
  return steps
    .filter(
      (step) =>
        step.status === 'pending' &&
        step.approvalStatus !== 'pending' &&
        (step.design?.dependencies ?? []).every((id) => {
          const dependency = steps.find((s) => s.sourceStepId === id)
          return dependency?.status === 'done' || dependency?.status === 'skipped'
        }),
    )
    .sort(
      (a, b) =>
        a.dueOn.localeCompare(b.dueOn) || a.position - b.position || a.id.localeCompare(b.id),
    )
}
