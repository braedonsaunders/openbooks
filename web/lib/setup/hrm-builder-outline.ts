/**
 * Shapes and pure outline moves shared by the review-template and hiring
 * pipeline builders (client and server). No server imports: the builders
 * reorder optimistically with these, and the order endpoints accept the
 * resulting shapes.
 */

export type ReviewSectionKind = 'competency' | 'goals' | 'free_text'
export type ReviewAnswerKind = 'rating' | 'text' | 'rating_and_text'
export type PipelineStageKind = 'screening' | 'interview' | 'assessment' | 'offer' | 'hired' | 'rejected'

export const REVIEW_SECTION_KINDS: readonly ReviewSectionKind[] = ['competency', 'goals', 'free_text']
export const REVIEW_ANSWER_KINDS: readonly ReviewAnswerKind[] = ['rating', 'text', 'rating_and_text']
export const PIPELINE_STAGE_KINDS: readonly PipelineStageKind[] = ['screening', 'interview', 'assessment', 'offer', 'hired', 'rejected']

export interface ReviewQuestionNode {
  id: string
  sectionId: string
  /** Stored position (unique per section); display order is list order. */
  position: number
  prompt: string
  answerKind: ReviewAnswerKind
  required: boolean
}

export interface ReviewSectionNode {
  id: string
  /** Stored position (unique per template); display order is list order. */
  position: number
  title: string
  kind: ReviewSectionKind
  weight: string | null
  competencyId: string | null
  questions: ReviewQuestionNode[]
}

export interface ReviewTemplateNode {
  id: string
  name: string
  isActive: boolean
  scaleMin: string
  scaleMax: string
  scaleLabels: string[]
  /** Review cycles opened on this template: the template is history-pinned. */
  cycleCount: number
  sections: ReviewSectionNode[]
}

export interface PipelineStageNode {
  id: string
  /** Stored position (unique per pipeline); display order is list order. */
  position: number
  key: string
  name: string
  kind: PipelineStageKind
  isTerminal: boolean
  /** Applications currently sitting on the stage (status active). */
  activeApplications: number
  /** Every application that ever referenced the stage: deletion is refused. */
  totalApplications: number
  kits: { id: string; name: string; isActive: boolean }[]
}

export interface PipelineTemplateNode {
  id: string
  name: string
  isDefault: boolean
  isActive: boolean
  requisitionCount: number
  stages: PipelineStageNode[]
}

/** The body the review outline order endpoint accepts. */
export interface ReviewOutlineOrder {
  sections: { id: string; questionIds: string[] }[]
}

/** Move one entry of a list to a new index (clamped); a no-op returns the same array. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const target = Math.max(0, Math.min(list.length - 1, to))
  if (from < 0 || from >= list.length || from === target) return list as T[]
  const next = list.slice()
  const [item] = next.splice(from, 1)
  next.splice(target, 0, item as T)
  return next
}

/**
 * Move a question to `index` within `toSectionId` (possibly another
 * section). The question keeps its fields and takes the new section id.
 * Unknown ids return the outline unchanged.
 */
export function moveQuestion(
  sections: readonly ReviewSectionNode[],
  questionId: string,
  toSectionId: string,
  index: number,
): ReviewSectionNode[] {
  const from = sections.find((section) => section.questions.some((question) => question.id === questionId))
  const to = sections.find((section) => section.id === toSectionId)
  if (!from || !to) return sections as ReviewSectionNode[]
  const question = from.questions.find((entry) => entry.id === questionId)!
  if (from.id === to.id) {
    const fromIndex = from.questions.indexOf(question)
    const moved = moveItem(from.questions, fromIndex, index)
    if (moved === from.questions) return sections as ReviewSectionNode[]
    return sections.map((section) => (section.id === from.id ? { ...section, questions: moved } : section))
  }
  return sections.map((section) => {
    if (section.id === from.id) return { ...section, questions: section.questions.filter((entry) => entry.id !== questionId) }
    if (section.id === to.id) {
      const questions = section.questions.slice()
      questions.splice(Math.max(0, Math.min(questions.length, index)), 0, { ...question, sectionId: to.id })
      return { ...section, questions }
    }
    return section
  })
}

/** The order-endpoint body for an outline. */
export function outlineOrder(sections: readonly ReviewSectionNode[]): ReviewOutlineOrder {
  return { sections: sections.map((section) => ({ id: section.id, questionIds: section.questions.map((question) => question.id) })) }
}

/** A stage key derived from its name, unique within the pipeline. */
export function stageKeyFor(name: string, taken: readonly string[]): string {
  const base = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'stage'
  const used = new Set(taken)
  if (!used.has(base)) return base
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}_${suffix}`
    if (!used.has(candidate)) return candidate
  }
}

export type ReviewTemplateIssue = 'noRequiredQuestion' | 'inactive' | 'emptySection'
export type PipelineIssue = 'noStages' | 'noHiredStage' | 'multipleHiredStages' | 'terminalFirstStage' | 'inactive'

/**
 * What the performance service will refuse about this form: a cycle opens
 * only on an active template holding at least one required question. An
 * empty non-goals section asks nothing (goals sections render the cycle's
 * goals even with no questions).
 */
export function reviewTemplateIssues(template: ReviewTemplateNode): { issue: ReviewTemplateIssue; sectionId?: string }[] {
  const issues: { issue: ReviewTemplateIssue; sectionId?: string }[] = []
  if (!template.isActive) issues.push({ issue: 'inactive' })
  if (!template.sections.some((section) => section.questions.some((question) => question.required))) {
    issues.push({ issue: 'noRequiredQuestion' })
  }
  for (const section of template.sections) {
    if (section.kind !== 'goals' && section.questions.length === 0) issues.push({ issue: 'emptySection', sectionId: section.id })
  }
  return issues
}

/**
 * What the recruiting service will refuse about this funnel: applications
 * start on the first stage, so it must be a working step, and hiring needs
 * exactly one hired stage to land on.
 */
export function pipelineIssues(template: Pick<PipelineTemplateNode, 'isActive' | 'stages'>): PipelineIssue[] {
  const issues: PipelineIssue[] = []
  if (!template.isActive) issues.push('inactive')
  if (template.stages.length === 0) {
    issues.push('noStages')
    return issues
  }
  const hired = template.stages.filter((stage) => stage.kind === 'hired').length
  if (hired === 0) issues.push('noHiredStage')
  if (hired > 1) issues.push('multipleHiredStages')
  if (template.stages[0]!.isTerminal) issues.push('terminalFirstStage')
  return issues
}
