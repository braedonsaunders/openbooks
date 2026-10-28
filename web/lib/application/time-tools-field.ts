import "server-only";
import { z } from "zod";
import { can } from "../authz";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { type ApplicationToolDefinition } from "./tool-definition";
import { timeDefinition } from "./time-tool-common";
import { forbidden, invalidInput } from "./errors";
import {
  listKiosks,
  registerKiosk,
  revokeKiosk,
  setWorkerPin,
} from "@openbooks/engine/hrm/field-time/kiosk";
import {
  assertProjectGeofenceShape,
  deleteProjectGeofence,
  listProjectGeofences,
  saveProjectGeofence,
} from "@openbooks/engine/hrm/field-time/geofences";
import { createBatch } from "@openbooks/engine/hrm/field-time/crew";
import {
  readFieldTimeSettingsValue,
  saveFieldTimeSettings,
  validateFieldTimeSettings,
} from "@openbooks/engine/hrm/field-time/settings";
import { fieldTimeSettingsBody, normalizeFieldTimeSettingsBody } from "../field-time/settings-body";
import { postPermission } from "../document-kinds";
import { handleCrewBatchAction, type CrewBatchAction } from "../field-time/crew-batch-write";
import {
  DATE,
  IDEMPOTENCY_KEY,
  settleTimeRefusal,
  settleTimeResponse,
  UUID,
} from "./time-tool-common";

const POINT = z
  .object({
    lat: z.number().min(-90).max(90).describe("Latitude in decimal degrees."),
    lng: z.number().min(-180).max(180).describe("Longitude in decimal degrees."),
  })
  .strict()
  .describe("Geographic point.");
const GEO = z
  .object({
    action: z.literal("save").optional().describe("Save or update a geofence."),
    id: UUID.optional().describe("Existing geofence id when updating."),
    projectId: UUID.describe("Project id the geofence belongs to."),
    kind: z.enum(["circle", "polygon"]).describe("Geofence shape."),
    center: POINT.nullable().optional().describe("Circle center; required for circle fences."),
    radiusM: z
      .number()
      .int()
      .min(10)
      .max(100000)
      .nullable()
      .optional()
      .describe("Circle radius in metres."),
    polygon: z
      .array(POINT)
      .min(3)
      .max(64)
      .nullable()
      .optional()
      .describe("Polygon corners; required for polygon fences."),
    isActive: z.boolean().optional().describe("Whether the geofence is active."),
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict();
const kioskRegister = z
  .object({
    action: z.literal("register").describe("Register a kiosk."),
    name: z.string().trim().min(1).max(120).describe("Kiosk name."),
    locationId: UUID.nullable().optional().describe("Location assigned to the kiosk."),
    projectId: UUID.nullable().optional().describe("Project assigned to the kiosk."),
    pinRequired: z.boolean().optional().describe("Require an employee PIN."),
    photoRequired: z.boolean().optional().describe("Require clock-event photos."),
  })
  .strict();
const kioskRevoke = z
  .object({
    action: z.literal("revoke").describe("Retire a kiosk token."),
    kioskId: UUID.describe("Kiosk id from list_time_kiosks."),
  })
  .strict();
const kioskPin = z
  .object({
    action: z.literal("set_pin").describe("Set or reset an employee PIN."),
    employeePartyId: UUID.describe("Employee party id."),
    pin: z.string().min(1).max(100).describe("New PIN value."),
  })
  .strict();
const line = z
  .object({
    employeePartyId: UUID.describe("Employee party id."),
    hours: z
      .string()
      .max(32)
      .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/)
      .describe("Positive hours as an exact decimal string with at most four decimals."),
    timeTypeId: UUID.nullable().optional().describe("Time type id."),
    projectTaskId: UUID.nullable().optional().describe("Project task id."),
    costCodeRef: z.string().max(80).nullable().optional().describe("Cost code reference."),
    equipmentId: UUID.nullable().optional().describe("Equipment id, if charged."),
    equipmentHours: z
      .string()
      .max(32)
      .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/)
      .nullable()
      .optional()
      .describe("Equipment hours as an exact decimal string."),
    memo: z.string().max(2000).nullable().optional().describe("Line note."),
  })
  .strict();
const batchLinesAction = z
  .object({
    action: z.literal("lines").describe("Replace draft batch lines."),
    lines: z.array(line).max(500).describe("Draft crew time lines."),
  })
  .strict();
const batchSubmitAction = z
  .object({
    action: z.literal("submit").describe("Submit and sign the batch."),
    signerName: z
      .string()
      .max(200)
      .nullable()
      .optional()
      .describe("Name of the person signing the batch."),
  })
  .strict();
const batchWithdrawAction = z
  .object({
    action: z.literal("withdraw").describe("Withdraw the submitted batch."),
    reason: z.string().max(2000).nullable().optional().describe("Reason for withdrawal."),
  })
  .strict();
const batchPostAction = z
  .object({ action: z.literal("post").describe("Post approved time and equipment charges.") })
  .strict();
type CrewBatchAction =
  | z.infer<typeof batchLinesAction>
  | z.infer<typeof batchSubmitAction>
  | z.infer<typeof batchWithdrawAction>
  | z.infer<typeof batchPostAction>;

function canKiosk(authz: Parameters<typeof can>[0]) {
  return can(authz, "time.kiosk.manage");
}
function canFieldTime(authz: Parameters<typeof can>[0]) {
  return can(authz, "time.manage");
}

async function registerKioskFor(context: ApplicationContext, input: z.infer<typeof kioskRegister>) {
  const result = await registerKiosk({
    orgId: context.authz.user.orgId,
    actorUserId: context.authz.user.id,
    allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
    name: input.name,
    locationId: input.locationId ?? null,
    projectId: input.projectId ?? null,
    pinRequired: input.pinRequired,
    photoRequired: input.photoRequired,
  });
  return {
    ok: true,
    kioskId: result.kiosk.id,
    status: "active",
    kiosk: result.kiosk,
    token: result.token,
    href: "/time/kiosks",
  };
}

async function executeCrewBatchAction(
  context: ApplicationContext,
  batchId: string,
  action: CrewBatchAction,
): Promise<Record<string, unknown>> {
  const response = await handleCrewBatchAction({
    authz: context.authz,
    batchId,
    body: action,
  });
  const result = await settleTimeResponse(response);
  if (action.action === "post") {
    return { ok: true, batchId, status: "posted", ...result, href: "/time/crew-batches" };
  }
  const batch = result as { batch?: { status?: string } };
  return {
    ok: true,
    batchId,
    status: batch.batch?.status ?? action.action,
    batch: result,
    href: "/time/crew-batches",
  };
}

export const FIELD_TIME_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  timeDefinition({
    name: "list_time_kiosks",
    title: "List Time Kiosks",
    description:
      "List kiosk devices and their active state without exposing token hashes. Use this to find kiosk ids before revoking a device.",
    inputSchema: z.object({}).strict(),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: canKiosk,
    featureKey: "fieldTime",
    execute: async (context) => {
      assertApplicationPermission(context, "time.kiosk.manage");
      const kiosks = await listKiosks(context.authz.user.orgId, context.authz.allowedSubsidiaryIds);
      return { ok: true, kiosks, href: "/time/kiosks" };
    },
  }),
  timeDefinition({
    name: "list_project_geofences",
    title: "List Project Geofences",
    description:
      "List active project geofences in the current subsidiary scope. Use the results to find a geofence id for update or removal.",
    inputSchema: z.object({
      projectId: UUID.optional().describe("Restrict the list to one visible project."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: canFieldTime,
    featureKey: "fieldTime",
    execute: async (context, input) => {
      assertApplicationPermission(context, "time.manage");
      const geofences = await listProjectGeofences(
        context.authz.user.orgId,
        input.projectId ?? null,
        context.authz.allowedSubsidiaryIds,
      );
      return { ok: true, geofences, href: "/time/geofences" };
    },
  }),
  timeDefinition({
    name: "get_field_time_settings",
    title: "Get Field Time Settings",
    description:
      "Read the organization-wide field-time rules used by kiosks and crew batches. Use this before updating settings so every required field stays explicit.",
    inputSchema: z.object({}).strict(),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: canFieldTime,
    featureKey: "fieldTime",
    execute: async (context) => {
      assertApplicationPermission(context, "time.manage");
      return {
        ok: true,
        settings: await readFieldTimeSettingsValue(context.authz.user.orgId),
        href: "/time/settings",
      };
    },
  }),
  timeDefinition({
    name: "register_time_kiosk",
    title: "Register Time Kiosk",
    description:
      "Register a new field-time kiosk and return its one-time raw token. Use list_time_kiosks and list_records to choose its location or project.",
    inputSchema: kioskRegister.extend({ idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: canKiosk,
    featureKey: "fieldTime",
    execute: async (context, input) => {
      assertApplicationPermission(context, "time.kiosk.manage");
      try {
        return await registerKioskFor(context, input);
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "revoke_time_kiosk",
    title: "Revoke Time Kiosk",
    description:
      "Retire a kiosk token so the device can no longer submit field-time events. Use list_time_kiosks to find the kiosk id and verify its retired state.",
    inputSchema: kioskRevoke.extend({ idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: canKiosk,
    featureKey: "fieldTime",
    execute: async (context, input) => {
      assertApplicationPermission(context, "time.kiosk.manage");
      try {
        await revokeKiosk({
          orgId: context.authz.user.orgId,
          actorUserId: context.authz.user.id,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          kioskId: input.kioskId,
        });
        return { ok: true, kioskId: input.kioskId, status: "revoked", href: "/time/kiosks" };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "set_time_kiosk_pin",
    title: "Set Time Kiosk PIN",
    description:
      "Set or reset an employee's kiosk PIN. Use list_records to find the employee id; kiosk policy determines whether the PIN is required for clock events.",
    inputSchema: kioskPin.extend({ idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: canKiosk,
    featureKey: "fieldTime",
    execute: async (context, input) => {
      assertApplicationPermission(context, "time.kiosk.manage");
      try {
        await setWorkerPin({
          orgId: context.authz.user.orgId,
          actorUserId: context.authz.user.id,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          employeePartyId: input.employeePartyId,
          pin: input.pin,
        });
        return {
          ok: true,
          employeePartyId: input.employeePartyId,
          status: "pin_set",
          href: "/time/kiosks",
        };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "save_project_geofence",
    title: "Save Project Geofence",
    description:
      "Create or update a circle or polygon geofence for a project. Use the project and existing geofence ids from the time setup or project reads, then verify it from the geofence list.",
    inputSchema: GEO,
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: canFieldTime,
    featureKey: "fieldTime",
    execute: async (context, input) => {
      assertApplicationPermission(context, "time.manage");
      try {
        assertProjectGeofenceShape(input);
        const result = await saveProjectGeofence({
          orgId: context.authz.user.orgId,
          actorUserId: context.authz.user.id,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          fence: input,
        });
        if (result === "hidden") throw forbidden("subsidiary.restricted");
        if (result === "project-unknown")
          throw invalidInput("Unknown project — pick it from the list");
        if (result === "fence-unknown")
          throw invalidInput("The geofence is unknown in this organization — reload and retry");
        return {
          ok: true,
          geofenceId: result.id,
          status: "saved",
          geofence: result,
          href: "/time/geofences",
        };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "delete_project_geofence",
    title: "Delete Project Geofence",
    description:
      "Retire a project geofence by id from the geofence list. The native service hides records outside the caller's legal-entity scope.",
    inputSchema: z.object({
      geofenceId: UUID.describe("Geofence id from the geofence list."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: canFieldTime,
    featureKey: "fieldTime",
    execute: async (context, input) => {
      assertApplicationPermission(context, "time.manage");
      try {
        const result = await deleteProjectGeofence({
          orgId: context.authz.user.orgId,
          id: input.geofenceId,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        if (result === "hidden") throw forbidden("subsidiary.restricted");
        if (result !== "ok")
          throw invalidInput("The geofence is unknown in this organization — reload and retry");
        return {
          ok: true,
          geofenceId: input.geofenceId,
          status: "deleted",
          href: "/time/geofences",
        };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "update_field_time_settings",
    title: "Update Field Time Settings",
    description:
      "Set required field-time rounding, break, auto-close, signature, equipment and photo rules. Requires unrestricted subsidiary access because these organization-wide rules affect every entity; the time settings read verifies the saved values.",
    inputSchema: fieldTimeSettingsBody.extend({ idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: canFieldTime,
    featureKey: "fieldTime",
    execute: async (context, input) => {
      assertApplicationPermission(context, "time.manage");
      if (context.authz.allowedSubsidiaryIds !== null) throw forbidden("subsidiary.unrestricted");
      try {
        const { idempotencyKey: _key, ...body } = input;
        const settings = validateFieldTimeSettings(normalizeFieldTimeSettingsBody(body));
        const saved = await saveFieldTimeSettings(context.authz.user.orgId, settings);
        if (!saved) throw invalidInput("The organization is not available.");
        return {
          ok: true,
          status: "updated",
          settings: await readFieldTimeSettingsValue(context.authz.user.orgId),
          href: "/time/settings",
        };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "create_crew_time_batch",
    title: "Create Crew Time Batch",
    description:
      "Open a field-time batch for a foreman, project and worked day. Use the project and employee ids from native reads; `crew_batches` verifies the created batch.",
    inputSchema: z.object({
      foremanPartyId: UUID.describe("Foreman employee party id."),
      projectId: UUID.describe("Project id for the crew's work."),
      workedOn: DATE.describe("Date the crew worked."),
      notes: z.string().max(2000).nullable().optional().describe("Batch note."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "time.crew.enter"),
    featureKey: "fieldTime",
    execute: async (context, input) => {
      assertApplicationPermission(context, "time.crew.enter");
      try {
        const id = await createBatch({
          orgId: context.authz.user.orgId,
          actorUserId: context.authz.user.id,
          foremanPartyId: input.foremanPartyId,
          projectId: input.projectId,
          workedOn: input.workedOn,
          notes: input.notes ?? null,
          canManageAll: can(context.authz, "time.manage"),
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, batchId: id, status: "draft", href: "/time/crew-batches" };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "set_crew_time_batch_lines",
    title: "Set Crew Time Batch Lines",
    description:
      "Replace the editable draft lines on a crew time batch. Find its id with crew_batches and use project, employee and item ids from native reads.",
    inputSchema: batchLinesAction.extend({
      batchId: UUID.describe("Batch id from crew_batches."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "time.crew.enter"),
    featureKey: "fieldTime",
    execute: async (context, input) => {
      assertApplicationPermission(context, "time.crew.enter");
      const { idempotencyKey: _key, batchId, ...action } = input;
      try {
        return await executeCrewBatchAction(context, batchId, action);
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "submit_crew_time_batch",
    title: "Submit Crew Time Batch",
    description:
      "Submit and sign a complete crew time batch for approval. Use crew_batches to confirm the batch is still in draft and its lines are complete.",
    inputSchema: batchSubmitAction.extend({
      batchId: UUID.describe("Draft batch id from crew_batches."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "time.crew.enter"),
    featureKey: "fieldTime",
    execute: async (context, input) => {
      assertApplicationPermission(context, "time.crew.enter");
      const { idempotencyKey: _key, batchId, ...action } = input;
      try {
        return await executeCrewBatchAction(context, batchId, action);
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "withdraw_crew_time_batch",
    title: "Withdraw Crew Time Batch",
    description:
      "Withdraw a submitted crew batch and record the reason. Find the batch with crew_batches; approved or posted batches must follow their governed correction path.",
    inputSchema: batchWithdrawAction.extend({
      batchId: UUID.describe("Submitted batch id from crew_batches."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "time.crew.enter"),
    featureKey: "fieldTime",
    execute: async (context, input) => {
      assertApplicationPermission(context, "time.crew.enter");
      const { idempotencyKey: _key, batchId, ...action } = input;
      try {
        return await executeCrewBatchAction(context, batchId, action);
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "post_crew_time_batch",
    title: "Post Crew Time Batch",
    description:
      "Post approved crew time and its equipment charge documents to the ledger. Find the approved batch with crew_batches; time management and project-charge posting permission are both required.",
    inputSchema: batchPostAction.extend({
      batchId: UUID.describe("Approved batch id from crew_batches."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "time.manage") && can(authz, postPermission("project_charge")),
    featureKey: "fieldTime",
    execute: async (context, input) => {
      assertApplicationPermission(context, "time.manage");
      assertApplicationPermission(context, postPermission("project_charge"));
      const { idempotencyKey: _key, batchId, ...action } = input;
      try {
        return await executeCrewBatchAction(context, batchId, action);
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
];
