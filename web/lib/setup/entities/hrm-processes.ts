/** Setup-registry hrm-processes entities (split from registry.ts; pure moves only). */
import type { SetupEntity } from '../types'

export const HRM_PROCESS_ENTITIES: SetupEntity[] = [
  // --- HRM process checklists (0193) ---------------------------------------
  // Onboarding/offboarding/transfer templates with their ordered steps. The
  // list/drawer/API are the generic Setup surfaces; ordered steps render by
  // position and the applies_to filter edits as JSON (validated per-entity
  // in write.ts, which proves the named subsidiary, department, and owner
  // party are visible in the org). Deleting a template that opened
  // processes is refused by name — retire with isActive instead.
  {
    key: 'hrm-process-templates',
    table: 'hrm_process_templates',
    actorCols: true,
    groupKey: 'workforce',
    featureKey: 'hrm',
    iconKey: 'clipboard-check',
    rehomed: true, // unified template + step drawer on /hrm/processes/templates
    rehomedTo: '/hrm/processes/templates',
    orgScoped: true,
    orderBy: 'kind, name',
    hasActive: true,
    columns: [
      { key: 'kind', kind: 'badge' },
      { key: 'name', kind: 'text' },
      { key: 'appliesEmployerSubsidiaryId', kind: 'ref', ref: 'subsidiaries' },
      { key: 'appliesDepartmentId', kind: 'ref', ref: 'departments' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      {
        key: 'kind',
        kind: 'select',
        required: true,
        options: [
          { value: 'onboarding', labelKey: 'options.hrmProcessKind.onboarding' },
          { value: 'offboarding', labelKey: 'options.hrmProcessKind.offboarding' },
          { value: 'transfer', labelKey: 'options.hrmProcessKind.transfer' },
        ],
      },
      { key: 'name', kind: 'text', required: true },
      // The two filter slots project from the applies_to jsonb through
      // STORED GENERATED columns (readable for prefill, never written):
      // empty means all. The write path folds them back into applies_to
      // before buildRow — see normalizeHrmProcessTemplateInput in write.ts.
      { key: 'appliesEmployerSubsidiaryId', kind: 'ref', ref: 'subsidiaries', helpTextKey: 'fieldHelp.hrmProcessAppliesSubsidiary' },
      { key: 'appliesDepartmentId', kind: 'ref', ref: 'departments', helpTextKey: 'fieldHelp.hrmProcessAppliesDepartment' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    key: 'hrm-process-template-steps',
    table: 'hrm_process_template_steps',
    actorCols: true,
    groupKey: 'workforce',
    featureKey: 'hrm',
    iconKey: 'list-checks',
    rehomed: true, // nested inside the process-template drawer
    rehomedTo: '/hrm/processes/templates',
    orgScoped: true,
    orderBy: 'position',
    hasActive: false,
    readOnly: true,
    columns: [
      { key: 'templateId', kind: 'ref', ref: 'hrm-process-templates' },
      { key: 'position', kind: 'number' },
      { key: 'title', kind: 'text' },
      { key: 'ownerKind', kind: 'badge' },
      { key: 'required', kind: 'boolean' },
    ],
    fields: [
      { key: 'templateId', kind: 'ref', ref: 'hrm-process-templates', required: true },
      { key: 'position', kind: 'integer', required: true },
      { key: 'title', kind: 'text', required: true },
      { key: 'description', kind: 'textarea' },
      {
        key: 'ownerKind',
        kind: 'select',
        required: true,
        options: [
          { value: 'manager', labelKey: 'options.hrmStepOwner.manager' },
          { value: 'hr', labelKey: 'options.hrmStepOwner.hr' },
          { value: 'employee', labelKey: 'options.hrmStepOwner.employee' },
          { value: 'named_party', labelKey: 'options.hrmStepOwner.namedParty' },
        ],
      },
      { key: 'ownerPartyId', kind: 'ref', ref: 'employees' },
      { key: 'dueOffsetDays', kind: 'integer' },
      { key: 'required', kind: 'boolean' },
      {
        key: 'evidenceKind',
        kind: 'select',
        options: [
          { value: 'none', labelKey: 'options.hrmStepEvidence.none' },
          { value: 'acknowledgement', labelKey: 'options.hrmStepEvidence.acknowledgement' },
          { value: 'attachment', labelKey: 'options.hrmStepEvidence.attachment' },
        ],
      },
    ],
  },
  // HRM pipeline funnels (0195): the org's own hiring funnel, managed
  // here; deactivation preserves history, and a template that opened
  // requisitions cannot be deleted (retire with isActive instead).
  {
    key: 'hrm-pipeline-templates',
    table: 'hrm_pipeline_templates',
    actorCols: true,
    groupKey: 'workforce',
    featureKey: 'hrm',
    iconKey: 'list-checks',
    orgScoped: true,
    orderBy: 'name',
    hasActive: true,
    columns: [
      { key: 'name', kind: 'text' },
      { key: 'isDefault', kind: 'boolean' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'name', kind: 'text', required: true },
      { key: 'isDefault', kind: 'boolean' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    key: 'hrm-pipeline-stages',
    table: 'hrm_pipeline_stages',
    actorCols: true,
    groupKey: 'workforce',
    featureKey: 'hrm',
    iconKey: 'list-checks',
    orgScoped: true,
    orderBy: 'position',
    hasActive: false,
    columns: [
      { key: 'templateId', kind: 'ref', ref: 'hrm-pipeline-templates' },
      { key: 'position', kind: 'number' },
      { key: 'name', kind: 'text' },
      { key: 'kind', kind: 'badge' },
    ],
    fields: [
      { key: 'templateId', kind: 'ref', ref: 'hrm-pipeline-templates', required: true },
      { key: 'position', kind: 'integer', required: true },
      { key: 'key', kind: 'text', required: true },
      { key: 'name', kind: 'text', required: true },
      {
        key: 'kind',
        kind: 'select',
        required: true,
        options: [
          { value: 'screening', labelKey: 'options.hrmPipelineStageKind.screening' },
          { value: 'interview', labelKey: 'options.hrmPipelineStageKind.interview' },
          { value: 'assessment', labelKey: 'options.hrmPipelineStageKind.assessment' },
          { value: 'offer', labelKey: 'options.hrmPipelineStageKind.offer' },
          { value: 'hired', labelKey: 'options.hrmPipelineStageKind.hired' },
          { value: 'rejected', labelKey: 'options.hrmPipelineStageKind.rejected' },
        ],
      },
      // Derived in storage from kind (never an independent control): the
      // drawer hides it and the write path folds kind into it before
      // buildRow (see normalizeHrmPipelineStageInput).
      { key: 'isTerminal', kind: 'boolean', hidden: true },
    ],
  },
  // Review templates (0196, HR-7): the review form per org — name, the
  // rating scale edited as structured min/max/labels fields (folded into
  // rating_scale before buildRow, never raw JSON), and ordered sections
  // with prompts. Deactivation (isActive) preserves history; deleting a
  // template that opened cycles is refused by name — retire it instead.
  {
    key: 'hrm-review-templates',
    table: 'hrm_review_templates',
    actorCols: true,
    groupKey: 'workforce',
    featureKey: 'hrm',
    iconKey: 'star',
    orgScoped: true,
    orderBy: 'name',
    hasActive: true,
    columns: [
      { key: 'name', kind: 'text' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'name', kind: 'text', required: true },
      { key: 'ratingScaleMin', kind: 'integer', required: true, helpTextKey: 'fieldHelp.hrmReviewScaleMin' },
      { key: 'ratingScaleMax', kind: 'integer', required: true, helpTextKey: 'fieldHelp.hrmReviewScaleMax' },
      { key: 'ratingScaleLabels', kind: 'stringArray', helpTextKey: 'fieldHelp.hrmReviewScaleLabels' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    key: 'hrm-review-template-sections',
    table: 'hrm_review_template_sections',
    actorCols: true,
    groupKey: 'workforce',
    featureKey: 'hrm',
    iconKey: 'list-checks',
    orgScoped: true,
    orderBy: 'position',
    hasActive: false,
    columns: [
      { key: 'templateId', kind: 'ref', ref: 'hrm-review-templates' },
      { key: 'position', kind: 'number' },
      { key: 'title', kind: 'text' },
      { key: 'kind', kind: 'badge' },
    ],
    fields: [
      { key: 'templateId', kind: 'ref', ref: 'hrm-review-templates', required: true },
      { key: 'position', kind: 'integer', required: true },
      { key: 'title', kind: 'text', required: true },
      {
        key: 'kind',
        kind: 'select',
        required: true,
        options: [
          { value: 'competency', labelKey: 'options.hrmReviewSectionKind.competency' },
          { value: 'goals', labelKey: 'options.hrmReviewSectionKind.goals' },
          { value: 'free_text', labelKey: 'options.hrmReviewSectionKind.freeText' },
        ],
      },
      { key: 'weight', kind: 'decimal' },
    ],
  },
  {
    key: 'hrm-review-template-questions',
    table: 'hrm_review_template_questions',
    actorCols: true,
    groupKey: 'workforce',
    featureKey: 'hrm',
    iconKey: 'list-checks',
    orgScoped: true,
    orderBy: 'position',
    hasActive: false,
    columns: [
      { key: 'sectionId', kind: 'ref', ref: 'hrm-review-template-sections' },
      { key: 'position', kind: 'number' },
      { key: 'prompt', kind: 'text' },
      { key: 'answerKind', kind: 'badge' },
      { key: 'required', kind: 'boolean' },
    ],
    fields: [
      { key: 'sectionId', kind: 'ref', ref: 'hrm-review-template-sections', required: true },
      { key: 'position', kind: 'integer', required: true },
      { key: 'prompt', kind: 'textarea', required: true },
      {
        key: 'answerKind',
        kind: 'select',
        required: true,
        options: [
          { value: 'rating', labelKey: 'options.hrmReviewAnswerKind.rating' },
          { value: 'text', labelKey: 'options.hrmReviewAnswerKind.text' },
          { value: 'rating_and_text', labelKey: 'options.hrmReviewAnswerKind.ratingAndText' },
        ],
      },
      { key: 'required', kind: 'boolean' },
    ],
  },
  // HR-17 begin: competency frameworks (0228) — the org's reusable skill
  // vocabulary with ranked levels. Setup-owned; deactivation preserves
  // history. Hidden while hrmCompetencies is off.
  {
    key: 'hrm-competency-frameworks',
    table: 'hrm_competency_frameworks',
    actorCols: true,
    groupKey: 'workforce',
    featureKey: 'hrmCompetencies',
    iconKey: 'award',
    orgScoped: true,
    orderBy: 'name',
    hasActive: true,
    readOnly: true,
    columns: [
      { key: 'name', kind: 'text' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'name', kind: 'text', required: true },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    key: 'hrm-competencies',
    table: 'hrm_competencies',
    actorCols: true,
    groupKey: 'workforce',
    featureKey: 'hrmCompetencies',
    iconKey: 'award',
    orgScoped: true,
    orderBy: 'position',
    hasActive: false,
    readOnly: true,
    columns: [
      { key: 'frameworkId', kind: 'ref', ref: 'hrm-competency-frameworks' },
      { key: 'code', kind: 'text' },
      { key: 'name', kind: 'text' },
    ],
    fields: [
      { key: 'frameworkId', kind: 'ref', ref: 'hrm-competency-frameworks', required: true },
      { key: 'code', kind: 'text', required: true },
      { key: 'name', kind: 'text', required: true },
      { key: 'description', kind: 'textarea' },
      { key: 'category', kind: 'text' },
    ],
  },
  // HR-17 end
]
