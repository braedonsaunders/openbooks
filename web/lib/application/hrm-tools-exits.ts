import "server-only";
import { z } from "zod";
import {
  getExitRecord,
  listExitRecords,
  recordExit,
  updateExitRecord,
} from "@openbooks/engine/hrm/performance";
import { listExports, listOwnExports, requestExport } from "@openbooks/engine/hrm/documents";
import { describeObjectFields, hrmMutation, hrmRead, HRM_DATE, HRM_UUID } from "./hrm-tools-shared";
import type { ApplicationToolDefinition } from "./tool-definition";
import { recordExitBody, patchExitBody } from "../../app/api/hrm/exit-records/bodies";
import { requestExportBody } from "../../app/api/hrm/retention-schedules/bodies";

const patchExitInput = describeObjectFields(patchExitBody).extend({
  exitId: HRM_UUID.describe("Exit record id from list_exit_records."),
});

export const HRM_EXIT_TOOLS: ApplicationToolDefinition[] = [
  hrmRead({
    name: "list_exit_records",
    title: "List Exit Records",
    description:
      "List HR exit records, optionally for one employment, to find ids for correction. Results use the retention-gated native exit read and respect subsidiary scope.",
    input: z.object({
      employmentId: HRM_UUID.optional().describe(
        "Optional employment id from hrm_employment_as_of.",
      ),
    }),
    permission: "hrm.retention.read",
    featureKey: "hrm",
    execute: async (context, input) => ({
      exits: await listExitRecords({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...(input.employmentId ? { employmentId: input.employmentId } : {}),
      }),
      href: "/hrm/performance?tab=retention",
    }),
  }),
  hrmRead({
    name: "get_exit_record",
    title: "Get Exit Record",
    description:
      "Read one exit record and its revision before correcting it. Find ids with list_exit_records; this uses the same retention-gated native read as the HR Performance workspace.",
    input: z.object({ exitId: HRM_UUID.describe("Exit record id from list_exit_records.") }),
    permission: "hrm.retention.read",
    featureKey: "hrm",
    execute: async (context, input) => ({
      exit: await getExitRecord({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        exitId: input.exitId,
      }),
      href: "/hrm/performance?tab=retention",
    }),
  }),
  hrmMutation({
    name: "record_exit",
    title: "Record Employment Exit",
    description:
      "Record an exit interview and reason for a terminated employment. Find employment and termination change ids with native HRM reads; verify the record with list_exit_records.",
    input: describeObjectFields(
      recordExitBody.extend({
        employmentId: HRM_UUID,
        terminationChangeId: HRM_UUID.nullable().optional(),
        interviewHeldOn: HRM_DATE.nullable().optional(),
        interviewerPartyId: HRM_UUID.nullable().optional(),
      }),
    ),
    permission: "hrm.performance.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      const exit = await recordExit({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...input,
        terminationChangeId: input.terminationChangeId ?? null,
        isRegrettable: input.isRegrettable ?? null,
        wouldRehire: input.wouldRehire ?? null,
        interviewHeldOn: input.interviewHeldOn ?? null,
        interviewerPartyId: input.interviewerPartyId ?? null,
        destination: input.destination ?? null,
        notes: input.notes ?? null,
      });
      return { ok: true, exit, exitId: exit.id, href: "/hrm/performance?tab=retention" };
    },
  }),
  hrmMutation({
    name: "correct_exit_record",
    title: "Correct Exit Record",
    description:
      "Correct an existing exit record with its expected revision and audit reason. Read the record with get_exit_record first; stale revisions refuse instead of overwriting a newer correction.",
    input: patchExitInput,
    permission: "hrm.performance.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      const { exitId, expectedRevision, ...patch } = input;
      const exit = await updateExitRecord({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        exitId,
        expectedRevision,
        ...(patch.reason !== undefined ? { reason: patch.reason } : {}),
        ...(patch.reasonKind ? { reasonKind: patch.reasonKind } : {}),
        ...(patch.isVoluntary !== undefined ? { isVoluntary: patch.isVoluntary } : {}),
        ...(patch.isRegrettable !== undefined ? { isRegrettable: patch.isRegrettable } : {}),
        ...(patch.wouldRehire !== undefined ? { wouldRehire: patch.wouldRehire } : {}),
        ...(patch.interviewHeldOn !== undefined ? { interviewHeldOn: patch.interviewHeldOn } : {}),
        ...(patch.interviewerPartyId !== undefined
          ? { interviewerPartyId: patch.interviewerPartyId }
          : {}),
        ...(patch.destination !== undefined ? { destination: patch.destination } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      });
      return { ok: true, exit, exitId, href: "/hrm/performance?tab=retention" };
    },
  }),
  hrmRead({
    name: "list_data_subject_exports",
    title: "List Data Subject Exports",
    description:
      "List queued and completed subject-access exports, optionally for one party, to find export ids and verify request status. This uses the native export read and enforces subsidiary visibility.",
    input: z.object({
      partyId: HRM_UUID.optional().describe("Optional native party id to filter the export list."),
    }),
    permission: "hrm.documents.read",
    featureKey: "hrmDocuments",
    execute: async (context, input) => ({
      exports: await listExports({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...(input.partyId ? { partyId: input.partyId } : {}),
      }),
      href: "/hrm/documents?view=exports",
    }),
  }),
  hrmRead({
    name: "list_my_data_subject_exports",
    title: "List My Data Subject Exports",
    description:
      "List the key user's own subject-access exports, including queued or ready status, for verifying a self-service export request. The native read binds the result to the party linked to the key's user.",
    input: z.object({}),
    permission: ["hrm.self.read", "hrm.documents.read"],
    featureKey: "hrmDocuments",
    execute: async (context) => ({
      exports: await listOwnExports({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
      }),
      href: "/hrm/documents?view=exports",
    }),
  }),
  hrmMutation({
    name: "request_data_subject_export",
    title: "Request Data Subject Export",
    description:
      "Queue a complete data export for a party, or for yourself when using self-service access. Find the party with native party reads; the service restricts self-service callers to their own record and HR requests to visible subsidiaries.",
    input: describeObjectFields(requestExportBody),
    permission: ["hrm.documents.manage", "hrm.self.read"],
    featureKey: "hrmDocuments",
    execute: async (context, input) => {
      const exportRequest = await requestExport({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        partyId: input.partyId,
      });
      return {
        ok: true,
        export: exportRequest,
        exportId: exportRequest.id,
        status: exportRequest.status,
        href: "/hrm/documents?view=exports",
      };
    },
  }),
];
