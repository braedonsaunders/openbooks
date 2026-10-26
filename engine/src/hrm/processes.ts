/** Governed HR onboarding, offboarding and transfer processes. Implementation lives in the process-* sibling modules; this entry point keeps the public names stable. */
export { HrmProcessError } from "./process-core.ts";
export type { HrmProcessCode, ProcessKind } from "./process-core.ts";
export { listProcessTemplates, getProcessTemplate, loadOpeningEmploymentContext, assertLiveVersionOn } from "./process-templates.ts";
export type { ProcessTemplateDTO, ProcessTemplateDetail, ProcessTemplateStepDTO, OpeningEmploymentContext } from "./process-templates.ts";
export { createProcessTemplate, updateProcessTemplate, deleteProcessTemplate, upsertProcessTemplateStep, reorderProcessTemplateSteps, deleteProcessTemplateStep } from "./process-template-admin.ts";
export type { CreateTemplateQuery, UpdateTemplateQuery, UpsertTemplateStepQuery } from "./process-template-admin.ts";
export { resolveStepActor } from "./process-runtime.ts";
export type { ProcessDTO, StepActor } from "./process-runtime.ts";
export { openProcess, openProcessInTx, processTriggerForApply, autoOpenProcessForChange } from "./process-opening.ts";
export type { OpenProcessQuery, OpenProcessInTx, AutoOpenTrigger, ChangeTriggerInput } from "./process-opening.ts";
export { completeProcessStep, skipProcessStep, completeProcess, cancelProcess } from "./process-step-execution.ts";
export type { CompleteStepQuery, SkipStepQuery } from "./process-step-execution.ts";
export { getChecklistDesigner, saveChecklistDraft, retireChecklistTemplate, publishChecklistDraft, previewChecklistCoverage, runChecklistReminders, getChecklistVersion } from "./process-checklist-designer.ts";
export type { ChecklistDesignerValue } from "./process-checklist-designer.ts";
export { submitChecklistStepApproval, releaseChecklistStepApproval } from "./process-step-approvals.ts";
