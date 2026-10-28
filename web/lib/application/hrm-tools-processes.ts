import "server-only";
import { z } from "zod";
import { checklistDocumentSchema, type ChecklistDocument } from "@openbooks/forms-core";
import {
  cancelProcess,
  completeProcess,
  completeProcessStep,
  getChecklistDesigner,
  getChecklistVersion,
  openProcess,
  previewChecklistCoverage,
  publishChecklistDraft,
  retireChecklistTemplate,
  saveChecklistDraft,
  skipProcessStep,
  submitChecklistStepApproval,
  listProcessTemplates,
} from "@openbooks/engine/hrm/processes";
import { hrmMutation, hrmRead, HRM_DATE, HRM_UUID, hrmShortText } from "./hrm-tools-shared";
import { invalidInput } from "./errors";
import type { ApplicationToolDefinition } from "./tool-definition";

const stepEvidence = z
  .object({
    attachmentId: HRM_UUID.optional().describe("Existing cabinet file attached as step evidence."),
    acknowledged: z
      .boolean()
      .optional()
      .describe("Whether the employee explicitly acknowledged the step."),
    response: z
      .record(z.string(), z.json())
      .optional()
      .describe("Structured response fields required by the checklist step."),
  })
  .describe("Evidence or acknowledgment for completing a checklist step.");
const templateListInput = z.object({
  kind: z
    .enum(["onboarding", "offboarding", "transfer"])
    .optional()
    .describe("Optional HR process kind."),
  activeOnly: z
    .boolean()
    .optional()
    .describe("When true, show only templates available for new processes."),
  employmentId: HRM_UUID.optional().describe("Optional employment id for compatibility filtering."),
  effectiveDate: HRM_DATE.optional().describe(
    "Required with employmentId to evaluate template compatibility.",
  ),
});
const checklistDocumentJson = z
  .string()
  .trim()
  .min(2)
  .max(200_000)
  .describe("Complete checklist document JSON copied from the native template designer read.");

function parseChecklistDocument(documentJson: string): ChecklistDocument {
  let value: unknown;
  try {
    value = JSON.parse(documentJson);
  } catch {
    throw invalidInput("documentJson must contain valid checklist document JSON");
  }
  const parsed = checklistDocumentSchema.safeParse(value);
  if (!parsed.success) {
    throw invalidInput("Checklist document does not match the native template schema", {
      issues: parsed.error.issues.slice(0, 20),
    });
  }
  return parsed.data;
}

export const HRM_PROCESS_TOOLS: ApplicationToolDefinition[] = [
  hrmRead({
    name: "list_process_templates",
    title: "List HR Process Templates",
    description:
      "List live onboarding, offboarding and transfer templates, optionally filtered to those compatible with an employment on an effective date. Use it to find a template id before opening a process; results use the native template read.",
    input: templateListInput,
    permission: "hrm.process.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      if ((input.employmentId === undefined) !== (input.effectiveDate === undefined)) {
        throw invalidInput("employmentId and effectiveDate must be supplied together");
      }
      return {
        templates: await listProcessTemplates({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          activeOnly: input.activeOnly ?? false,
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.employmentId
            ? { employmentId: input.employmentId, effectiveDate: input.effectiveDate! }
            : {}),
        }),
        href: "/hrm/processes/templates",
      };
    },
  }),
  hrmMutation({
    name: "create_hr_process",
    title: "Create HR Process",
    description:
      "Open an onboarding, offboarding or transfer checklist for an employment with a live version. Read the employee with hrm_employment_as_of and choose a compatible template from list_process_templates first.",
    input: z.object({
      employmentId: HRM_UUID.describe("Employment id from hrm_employment_as_of."),
      kind: z
        .enum(["onboarding", "offboarding", "transfer"])
        .describe("Lifecycle process to open."),
      effectiveDate: HRM_DATE.describe("Effective date for the process."),
      templateId: HRM_UUID.optional().describe(
        "Compatible template id from list_process_templates; omit only when native policy selects one.",
      ),
    }),
    permission: "hrm.process.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      const process = await openProcess({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...input,
      });
      return {
        ok: true,
        process,
        processId: process.id,
        status: process.status,
        href: "/hrm/processes",
      };
    },
  }),
  hrmMutation({
    name: "complete_hr_process_step",
    title: "Complete HR Process Step",
    description:
      "Complete an owned checklist step with its required acknowledgment, response or evidence; the service checks employee ownership and step state. Find the step in hrm_processes or the key's own hrm_me checklist read.",
    input: z.object({
      stepId: HRM_UUID.describe("Checklist step id from a native process read."),
      ...stepEvidence.shape,
    }),
    permission: ["hrm.process.read", "hrm.self.read"],
    featureKey: "hrm",
    execute: async (context, input) => {
      const { stepId, ...evidence } = input;
      const result = await completeProcessStep({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        stepId,
        ...evidence,
      });
      return { ok: true, ...result, stepId, href: "/hrm/processes" };
    },
  }),
  hrmMutation({
    name: "submit_hr_process_step",
    title: "Submit HR Process Step",
    description:
      "Submit an owned checklist step for manager approval with its evidence or acknowledgment. Find the step in hrm_processes or the key's own hrm_me checklist read; the approval and ownership rules are enforced by the native service.",
    input: z.object({
      stepId: HRM_UUID.describe("Checklist step id from a native process read."),
      ...stepEvidence.shape,
    }),
    permission: ["hrm.process.read", "hrm.self.read"],
    featureKey: "hrm",
    execute: async (context, input) => {
      const { stepId, ...evidence } = input;
      await submitChecklistStepApproval({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        stepId,
        ...evidence,
      });
      return { ok: true, stepId, href: "/hrm/processes" };
    },
  }),
  hrmMutation({
    name: "skip_hr_process_step",
    title: "Skip HR Process Step",
    description:
      "Skip an eligible checklist step with a reason; required steps demand the native manager permission and cannot be silently omitted. Find the step in hrm_processes and confirm the process state before skipping.",
    input: z.object({
      stepId: HRM_UUID.describe("Checklist step id from a native process read."),
      reason: hrmShortText("Why the checklist step is skipped.", 2000),
    }),
    permission: "hrm.process.read",
    featureKey: "hrm",
    execute: async (context, input) => {
      await skipProcessStep({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...input,
      });
      return { ok: true, stepId: input.stepId, href: "/hrm/processes" };
    },
  }),
  hrmMutation({
    name: "complete_hr_process",
    title: "Complete HR Process",
    description:
      "Complete an open onboarding, offboarding or transfer process after all required steps are complete. Read the process with hrm_processes first; the native service refuses while a required step remains pending.",
    input: z.object({ processId: HRM_UUID.describe("Open process id from hrm_processes.") }),
    permission: "hrm.process.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      await completeProcess({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        processId: input.processId,
      });
      return { ok: true, processId: input.processId, href: "/hrm/processes" };
    },
  }),
  hrmMutation({
    name: "cancel_hr_process",
    title: "Cancel HR Process",
    description:
      "Cancel an open HR process with an audit reason. Find the process with hrm_processes and verify it is still open; cancellation preserves its history.",
    input: z.object({
      processId: HRM_UUID.describe("Open process id from hrm_processes."),
      reason: hrmShortText("Reason for cancelling the process.", 2000),
    }),
    permission: "hrm.process.manage",
    featureKey: "hrm",
    destructive: true,
    execute: async (context, input) => {
      await cancelProcess({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        processId: input.processId,
        reason: input.reason,
      });
      return { ok: true, processId: input.processId, href: "/hrm/processes" };
    },
  }),
  hrmMutation({
    name: "save_checklist_template_draft",
    title: "Save Checklist Template Draft",
    description:
      "Save a revision-checked onboarding or offboarding checklist draft before publishing it. Read the designer with get_checklist_template first; the document must use supported step types and stable ids.",
    input: z.object({
      templateId: HRM_UUID.describe("Checklist template id from get_checklist_template."),
      revision: z
        .number()
        .int()
        .nonnegative()
        .describe("Current template revision returned by the designer read."),
      documentJson: checklistDocumentJson,
    }),
    permission: "hrm.process.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      const result = await saveChecklistDraft({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        templateId: input.templateId,
        revision: input.revision,
        document: parseChecklistDocument(input.documentJson),
      });
      return {
        ok: true,
        ...result,
        templateId: input.templateId,
        href: "/hrm/processes/templates",
      };
    },
  }),
  hrmMutation({
    name: "publish_checklist_template",
    title: "Publish Checklist Template",
    description:
      "Publish the current checklist draft revision for future lifecycle processes. Read the designer with get_checklist_template, confirm the saved revision, and provide the publication reason; active processes keep their pinned version.",
    input: z.object({
      templateId: HRM_UUID.describe("Checklist template id from get_checklist_template."),
      revision: z
        .number()
        .int()
        .nonnegative()
        .describe("Current draft revision returned by the designer read."),
      reason: hrmShortText("Reason for publishing this checklist revision.", 2000),
    }),
    permission: "hrm.process.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      const result = await publishChecklistDraft({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...input,
      });
      return {
        ok: true,
        ...result,
        templateId: input.templateId,
        href: "/hrm/processes/templates",
      };
    },
  }),
  hrmMutation({
    name: "retire_checklist_template",
    title: "Retire Checklist Template",
    description:
      "Retire a checklist template so it cannot be selected for new HR processes while existing process history remains readable. Read the designer with get_checklist_template and provide the retirement reason.",
    input: z.object({
      templateId: HRM_UUID.describe("Checklist template id from get_checklist_template."),
      revision: z
        .number()
        .int()
        .nonnegative()
        .describe("Current revision returned by the designer read."),
      reason: hrmShortText("Reason for retiring this checklist template.", 2000),
    }),
    permission: "hrm.process.manage",
    featureKey: "hrm",
    destructive: true,
    execute: async (context, input) => {
      const result = await retireChecklistTemplate({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...input,
      });
      return {
        ok: true,
        ...result,
        templateId: input.templateId,
        href: "/hrm/processes/templates",
      };
    },
  }),
  hrmRead({
    name: "get_checklist_template",
    title: "Get Checklist Template",
    description:
      "Read a checklist template's current designer document and revision before saving, publishing or retiring it. Find template ids in the HRM Processes template workspace.",
    input: z.object({
      templateId: HRM_UUID.describe(
        "Checklist template id from the HRM Processes template workspace.",
      ),
    }),
    permission: "hrm.process.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      const designer = await getChecklistDesigner({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        templateId: input.templateId,
      });
      return { ...designer, href: "/hrm/processes/templates" };
    },
  }),
  hrmRead({
    name: "get_checklist_template_version",
    title: "Get Checklist Template Version",
    description:
      "Read one published checklist version to inspect the exact content pinned to a process. Find template ids and versions in the HRM Processes template workspace.",
    input: z.object({
      templateId: HRM_UUID.describe(
        "Checklist template id from the HRM Processes template workspace.",
      ),
      version: z
        .number()
        .int()
        .positive()
        .describe("Published version number from the template history."),
    }),
    permission: "hrm.process.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      const version = await getChecklistVersion({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...input,
      });
      return { ...version, href: "/hrm/processes/templates" };
    },
  }),
  hrmRead({
    name: "preview_checklist_template_coverage",
    title: "Preview Checklist Template Coverage",
    description:
      "Check which checklist steps apply to an employment on an effective date before opening or publishing a process. Read the employment with hrm_employment_as_of and choose the candidate checklist document from the template designer.",
    input: z.object({
      employmentId: HRM_UUID.describe("Employment id from hrm_employment_as_of."),
      effectiveDate: HRM_DATE.describe("Date whose employment and checklist rules are evaluated."),
      documentJson: checklistDocumentJson,
    }),
    permission: "hrm.process.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      const preview = await previewChecklistCoverage({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        employmentId: input.employmentId,
        effectiveDate: input.effectiveDate,
        document: parseChecklistDocument(input.documentJson),
      });
      return { ...preview, href: "/hrm/processes/templates" };
    },
  }),
];
