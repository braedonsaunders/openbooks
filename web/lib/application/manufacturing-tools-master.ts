import "server-only";
import { z } from "zod";
import { can } from "../authz";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import {
  lockManufacturingCenterAuthority,
  lockManufacturingRoutingAuthority,
} from "@openbooks/engine/manufacturing/authority";
import {
  createRouting,
  createNextRoutingVersion,
  createRoutingOperation,
  updateRouting,
  updateRoutingOperation,
  deleteRoutingOperation,
  submitRoutingActivation,
  archiveRouting,
  getRouting,
  type RoutingInput,
  type RoutingOperationInput,
} from "@openbooks/engine/manufacturing/routings";
import {
  addWorkCenterRate,
  createWorkCenter,
  deactivateWorkCenter,
  endWorkCenterRate,
  getWorkCenter,
  getWorkCenterRate,
  reactivateWorkCenter,
  updateWorkCenter,
  type WorkCenterInput,
} from "@openbooks/engine/manufacturing/work-centers";
import {
  updateManufacturingPolicies,
  type ManufacturingPoliciesInput,
} from "@openbooks/engine/manufacturing/policies";
import {
  getItemPolicy,
  upsertItemPolicy,
  type ItemPolicyInput,
} from "@openbooks/engine/manufacturing/item-policies";
import {
  previewStandardRollup,
  proposeStandardRollup,
} from "@openbooks/engine/manufacturing/standard-rollup";
import {
  BomPolicyError,
  saveBomPolicy,
  type BomPolicyInput,
} from "@openbooks/engine/inventory/bom-policy";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { ManufacturingNotFoundError } from "@openbooks/engine/manufacturing/errors";
import { idempotentManufacturingCreate } from "@/app/api/manufacturing/_idempotent";
import {
  assertPermission,
  assertUnrestricted,
  assertVisibleSubsidiary,
  runManufacturing,
  UUID,
  DATE,
  DECIMAL,
  IDEMPOTENCY_KEY,
  nativeIdempotencyKey,
  settleManufacturingRefusal,
} from "./manufacturing-tools-shared";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, conflict, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const OVERHEAD = z.enum(["labor_hours", "machine_hours", "units"]);
const BASIS = z.object({
  itemId: UUID("Produced item id from item reads"),
  subsidiaryId: UUID("Legal-entity id from manufacturing options"),
  onDate: DATE.describe("Date to price the proposed standard cost."),
  batchQuantity: DECIMAL.describe("Positive exact batch quantity as a decimal string."),
});
const REQUEST_URL = "http://openbooks.local/api/manufacturing";
const requestForKey = (key: string) =>
  new Request(REQUEST_URL, { headers: { "Idempotency-Key": nativeIdempotencyKey(key) } });

function assertRoutingScope(
  context: ApplicationContext,
  routing: {
    operations?: Array<{ workCenterSubsidiaryId: string | null }>;
    locations?: Array<{ subsidiaryId: string | null }>;
  },
) {
  for (const operation of routing.operations ?? [])
    assertVisibleSubsidiary(context, operation.workCenterSubsidiaryId);
  for (const location of routing.locations ?? [])
    assertVisibleSubsidiary(context, location.subsidiaryId);
}

async function requireRouting(context: ApplicationContext, id: string) {
  const routing = await getRouting(db, context.authz.user.orgId, id);
  if (!routing) throw notFound("routing");
  assertRoutingScope(context, routing);
  return routing;
}

async function requireCenter(context: ApplicationContext, id: string) {
  const center = await getWorkCenter(db, context.authz.user.orgId, id);
  if (!center) throw notFound("work center");
  assertVisibleSubsidiary(context, center.subsidiaryId as string | null);
  return center;
}

async function authorizeRoutingReplay(context: ApplicationContext, id: string) {
  await runManufacturing(context, async () => {
    await requireRouting(context, id);
  });
}

async function authorizeCenterReplay(context: ApplicationContext, id: string) {
  await runManufacturing(context, async () => {
    await requireCenter(context, id);
  });
}

async function authorizeOrgWideReplay(context: ApplicationContext, permission: string) {
  assertPermission(context, permission);
  assertUnrestricted(context);
}

function settleBomRefusal(error: unknown): never {
  if (error instanceof BomPolicyError) {
    const details: Record<string, unknown> = { code: error.code };
    if (error.details) Object.assign(details, error.details);
    if (error.status === 403) throw new ApplicationError("forbidden", error.message, 403, details);
    if (error.status === 404) throw new ApplicationError("not_found", error.message, 404, details);
    if (error.status === 409) throw conflict(error.message, details);
    throw invalidInput(error.message, details);
  }
  if (error instanceof ScopeNotFoundError || error instanceof ManufacturingNotFoundError)
    throw notFound("record");
  settleManufacturingRefusal(error);
}

async function runBom<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    settleBomRefusal(error);
  }
}

function assertBomManage(context: ApplicationContext) {
  assertApplicationPermission(context, "admin.setup.manage");
  assertUnrestricted(context);
}

export const MANUFACTURING_MASTER_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "create_manufacturing_routing",
    title: "Create Manufacturing Routing",
    description:
      "Create a draft routing header for an active produced item and its effectivity dates. Use item and manufacturing option reads for references; add operations, then activate the version through the governed routing activation flow.",
    inputSchema: z.object({
      producedItemId: UUID("Produced item id from item reads"),
      code: z.string().trim().min(1).max(100).describe("Unique routing code."),
      name: z.string().trim().min(1).max(200).describe("Routing display name."),
      effectiveFrom: DATE.describe("First date the routing can be used."),
      effectiveTo: DATE.nullable()
        .optional()
        .describe("Exclusive end date, or null for open-ended."),
      defaultIssueLocationId: UUID("Default component issue stock-location id")
        .nullable()
        .optional(),
      defaultReceiptLocationId: UUID("Default finished-goods receipt stock-location id")
        .nullable()
        .optional(),
      overheadBasis: OVERHEAD.describe("Allocation basis for routing overhead."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "manufacturing.manage"),
    authorizeReplay: async (context, input) =>
      runManufacturing(context, async () => {
        assertUnrestricted(context);
        await lockManufacturingRoutingAuthority(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          nativeIdempotencyKey(input.idempotencyKey),
        );
        if (
          !(await getRouting(
            db,
            context.authz.user.orgId,
            nativeIdempotencyKey(input.idempotencyKey),
          ))
        )
          throw notFound("routing");
      }),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.manage");
      assertUnrestricted(context);
      return runManufacturing(context, async () => {
        const orgId = context.authz.user.orgId;
        const match = {
          producedItemId: input.producedItemId,
          code: input.code,
          name: input.name,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo,
          defaultIssueLocationId: input.defaultIssueLocationId,
          defaultReceiptLocationId: input.defaultReceiptLocationId,
          overheadBasis: input.overheadBasis,
        };
        const row = await idempotentManufacturingCreate({
          orgId,
          actorId: context.authz.user.id,
          request: requestForKey(nativeIdempotencyKey(input.idempotencyKey)),
          table: "mfg_routings",
          match,
          create: (id, requestId, savedMatch) =>
            createRouting(db, orgId, context.authz.user.id, match as RoutingInput, {
              id,
              requestId,
              match: savedMatch,
            }),
          load: async () => {
            await lockManufacturingRoutingAuthority(
              db,
              orgId,
              context.authz.user.id,
              nativeIdempotencyKey(input.idempotencyKey),
            );
            return getRouting(db, orgId, nativeIdempotencyKey(input.idempotencyKey));
          },
        });
        return {
          ok: true,
          ...row,
          href: `/manufacturing/routings?record=${encodeURIComponent(String(row.id))}`,
        };
      });
    },
  }),
  definition({
    name: "update_manufacturing_routing",
    title: "Update Manufacturing Routing",
    description:
      "Edit a draft routing header's code, name, effectivity, locations or overhead basis. Read the routing first; activated versions refuse edits and require a new version.",
    inputSchema: z.object({
      id: UUID("Routing id from list_manufacturing_records"),
      patch: z
        .object({
          code: z.string().trim().min(1).max(100).optional().describe("Unique routing code."),
          name: z.string().trim().min(1).max(200).optional().describe("Routing display name."),
          effectiveFrom: DATE.optional().describe("First date the routing can be used."),
          effectiveTo: DATE.nullable()
            .optional()
            .describe("Exclusive end date, or null for open-ended."),
          defaultIssueLocationId: UUID("Default component issue stock-location id")
            .nullable()
            .optional(),
          defaultReceiptLocationId: UUID("Default finished-goods receipt stock-location id")
            .nullable()
            .optional(),
          overheadBasis: OVERHEAD.optional().describe("Allocation basis for routing overhead."),
        })
        .refine((patch) => Object.keys(patch).length > 0)
        .describe("Fields to update on the draft routing."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "manufacturing.manage"),
    authorizeReplay: (context, input) => authorizeRoutingReplay(context, input.id),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.manage");
      return runManufacturing(context, async () => {
        await requireRouting(context, input.id);
        const row = await updateRouting(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          input.id,
          input.patch as Partial<RoutingInput>,
        );
        return {
          ok: true,
          ...row,
          href: `/manufacturing/routings?record=${encodeURIComponent(input.id)}`,
        };
      });
    },
  }),
  definition({
    name: "create_routing_version",
    title: "Create Routing Version",
    description:
      "Create a new draft version from an existing routing when an activated routing needs a governed change. Copy the base routing id from list_manufacturing_records, then edit the returned draft and submit its activation.",
    inputSchema: z.object({
      id: UUID("Base routing id from list_manufacturing_records"),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "manufacturing.manage"),
    authorizeReplay: async (context, input) =>
      runManufacturing(context, async () => {
        await requireRouting(context, input.id);
        await lockManufacturingRoutingAuthority(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          nativeIdempotencyKey(input.idempotencyKey),
        );
        if (
          !(await getRouting(
            db,
            context.authz.user.orgId,
            nativeIdempotencyKey(input.idempotencyKey),
          ))
        )
          throw notFound("routing");
      }),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.manage");
      return runManufacturing(context, async () => {
        const base = await requireRouting(context, input.id);
        const orgId = context.authz.user.orgId;
        const row = await idempotentManufacturingCreate({
          orgId,
          actorId: context.authz.user.id,
          request: requestForKey(nativeIdempotencyKey(input.idempotencyKey)),
          table: "mfg_routings",
          match: { baseRoutingId: input.id },
          create: (id, requestId, match) =>
            createNextRoutingVersion(db, orgId, context.authz.user.id, input.id, {
              id,
              requestId,
              match,
            }),
          load: async () => {
            await lockManufacturingRoutingAuthority(
              db,
              orgId,
              context.authz.user.id,
              nativeIdempotencyKey(input.idempotencyKey),
            );
            return getRouting(db, orgId, nativeIdempotencyKey(input.idempotencyKey));
          },
        });
        assertRoutingScope(context, base);
        return {
          ok: true,
          ...row,
          href: `/manufacturing/routings?record=${encodeURIComponent(String(row.id))}`,
        };
      });
    },
  }),
  definition({
    name: "activate_manufacturing_routing",
    title: "Activate Manufacturing Routing",
    description:
      "Submit a draft routing version for activation in a legal entity; configured approval flows may leave it pending. Read the routing first and provide the business reason required by the activation policy.",
    inputSchema: z.object({
      id: UUID("Draft routing id from list_manufacturing_records"),
      subsidiaryId: UUID("Legal-entity id from manufacturing options"),
      reason: z
        .string()
        .trim()
        .min(8)
        .max(500)
        .describe("Why this routing version should become effective."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "manufacturing.manage") && authz.allowedSubsidiaryIds === null,
    authorizeReplay: async (context, input) => {
      assertPermission(context, "manufacturing.manage");
      assertUnrestricted(context);
      await authorizeRoutingReplay(context, input.id);
    },
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.manage");
      assertUnrestricted(context);
      return runManufacturing(context, async () => {
        await requireRouting(context, input.id);
        const row = await submitRoutingActivation(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          input.id,
          {
            subsidiaryId: input.subsidiaryId,
            reason: input.reason,
            idempotencyKey: nativeIdempotencyKey(input.idempotencyKey),
          },
        );
        return {
          ok: true,
          ...row,
          href: `/manufacturing/routings?record=${encodeURIComponent(input.id)}`,
        };
      });
    },
  }),
  definition({
    name: "archive_manufacturing_routing",
    title: "Archive Manufacturing Routing",
    description:
      "Archive a routing that is no longer used. Read the routing first; active or referenced versions are refused by the manufacturing lifecycle rules.",
    inputSchema: z.object({
      id: UUID("Routing id from list_manufacturing_records"),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "manufacturing.manage"),
    authorizeReplay: (context, input) => authorizeRoutingReplay(context, input.id),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.manage");
      return runManufacturing(context, async () => {
        await requireRouting(context, input.id);
        const row = await archiveRouting(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          input.id,
        );
        return {
          ok: true,
          ...row,
          href: `/manufacturing/routings?record=${encodeURIComponent(input.id)}`,
        };
      });
    },
  }),
  definition({
    name: "add_routing_operation",
    title: "Add Routing Operation",
    description:
      "Add a sequenced operation to a draft routing using a work center from manufacturing options. Use get_manufacturing_record to review existing operation sequence and times before adding one.",
    inputSchema: z.object({
      routingId: UUID("Draft routing id from list_manufacturing_records"),
      sequence: z.number().int().positive().describe("Unique positive operation sequence."),
      name: z.string().trim().min(1).max(200).describe("Operation name."),
      workCenterId: UUID("Work-center id from get_manufacturing_options"),
      setupMinutes: DECIMAL.describe("Planned setup minutes as an exact decimal string."),
      runMinutesPerUnit: DECIMAL.describe(
        "Planned run minutes per unit as an exact decimal string.",
      ),
      laborTimeSource: z
        .enum(["operation", "approved_time"])
        .optional()
        .describe("Whether labor time comes from the operation or approved time."),
      laborMinutesPerUnit: DECIMAL.nullable()
        .optional()
        .describe("Labor minutes per unit when operation-sourced."),
      backflushAt: z
        .enum(["none", "start", "finish"])
        .optional()
        .describe("When components are backflushed."),
      qualityGate: z
        .enum(["none", "measure"])
        .optional()
        .describe("Whether the operation requires a quality measurement."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "manufacturing.manage"),
    authorizeReplay: async (context, input) =>
      runManufacturing(context, async () => {
        await requireRouting(context, input.routingId);
        await requireCenter(context, input.workCenterId);
      }),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.manage");
      return runManufacturing(context, async () => {
        const routing = await requireRouting(context, input.routingId);
        await requireCenter(context, input.workCenterId);
        const orgId = context.authz.user.orgId;
        const operation = {
          sequence: input.sequence,
          name: input.name,
          workCenterId: input.workCenterId,
          setupMinutes: input.setupMinutes,
          runMinutesPerUnit: input.runMinutesPerUnit,
          laborTimeSource: input.laborTimeSource,
          laborMinutesPerUnit: input.laborMinutesPerUnit,
          backflushAt: input.backflushAt,
          qualityGate: input.qualityGate,
        };
        const row = await idempotentManufacturingCreate({
          orgId,
          actorId: context.authz.user.id,
          request: requestForKey(nativeIdempotencyKey(input.idempotencyKey)),
          table: "mfg_routing_operations",
          match: { routingId: input.routingId, ...operation },
          create: (id, requestId, match) =>
            createRoutingOperation(
              db,
              orgId,
              context.authz.user.id,
              input.routingId,
              operation as RoutingOperationInput,
              { id, requestId, match },
            ),
          load: async () => {
            await lockManufacturingRoutingAuthority(
              db,
              orgId,
              context.authz.user.id,
              input.routingId,
            );
            const current = await getRouting(db, orgId, input.routingId);
            return (
              (current?.operations as Array<Record<string, unknown>> | undefined)?.find(
                (candidate) => candidate.id === nativeIdempotencyKey(input.idempotencyKey),
              ) ?? null
            );
          },
        });
        assertRoutingScope(context, routing);
        return {
          ok: true,
          ...row,
          href: `/manufacturing/routings?record=${encodeURIComponent(input.routingId)}`,
        };
      });
    },
  }),
  definition({
    name: "update_routing_operation",
    title: "Update Routing Operation",
    description:
      "Edit a sequence, work center, time standard or execution setting on a draft routing operation. Read the routing first; changing a work center requires the same subsidiary access as the routing.",
    inputSchema: z.object({
      routingId: UUID("Draft routing id from list_manufacturing_records"),
      operationId: UUID("Operation id from get_manufacturing_record"),
      patch: z
        .object({
          sequence: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Unique positive operation sequence."),
          name: z.string().trim().min(1).max(200).optional().describe("Operation name."),
          workCenterId: UUID("Work-center id from get_manufacturing_options").optional(),
          setupMinutes: DECIMAL.optional().describe(
            "Planned setup minutes as an exact decimal string.",
          ),
          runMinutesPerUnit: DECIMAL.optional().describe(
            "Planned run minutes per unit as an exact decimal string.",
          ),
          laborTimeSource: z
            .enum(["operation", "approved_time"])
            .optional()
            .describe("Source of reported labor minutes."),
          laborMinutesPerUnit: DECIMAL.nullable()
            .optional()
            .describe("Labor minutes per unit when operation-sourced."),
          backflushAt: z
            .enum(["none", "start", "finish"])
            .optional()
            .describe("When components are backflushed."),
          qualityGate: z
            .enum(["none", "measure"])
            .optional()
            .describe("Whether the operation requires a quality measurement."),
        })
        .refine((patch) => Object.keys(patch).length > 0)
        .describe("Fields to change on the routing operation."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "manufacturing.manage"),
    authorizeReplay: async (context, input) =>
      runManufacturing(context, async () => {
        await requireRouting(context, input.routingId);
        if (input.patch.workCenterId) await requireCenter(context, input.patch.workCenterId);
      }),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.manage");
      return runManufacturing(context, async () => {
        await requireRouting(context, input.routingId);
        if (input.patch.workCenterId) await requireCenter(context, input.patch.workCenterId);
        const row = await updateRoutingOperation(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          input.routingId,
          input.operationId,
          input.patch as Partial<RoutingOperationInput>,
        );
        return {
          ok: true,
          ...row,
          href: `/manufacturing/routings?record=${encodeURIComponent(input.routingId)}`,
        };
      });
    },
  }),
  definition({
    name: "delete_routing_operation",
    title: "Delete Routing Operation",
    description:
      "Remove an operation from a draft routing before activation. Use get_manufacturing_record to confirm the routing and operation ids; active routing history is governed and cannot be edited this way.",
    inputSchema: z.object({
      routingId: UUID("Draft routing id from list_manufacturing_records"),
      operationId: UUID("Operation id from get_manufacturing_record"),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "manufacturing.manage"),
    authorizeReplay: (context, input) => authorizeRoutingReplay(context, input.routingId),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.manage");
      return runManufacturing(context, async () => {
        await requireRouting(context, input.routingId);
        await deleteRoutingOperation(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          input.routingId,
          input.operationId,
        );
        return {
          ok: true,
          routingId: input.routingId,
          operationId: input.operationId,
          deleted: true,
          href: `/manufacturing/routings?record=${encodeURIComponent(input.routingId)}`,
        };
      });
    },
  }),
  definition({
    name: "create_work_center",
    title: "Create Work Center",
    description:
      "Create a manufacturing machine, labor center or cell with exact capacity, efficiency and legal-entity ownership. Use manufacturing options for department and calendar references; rate schedules are added separately.",
    inputSchema: z.object({
      code: z.string().trim().min(1).max(100).describe("Unique work-center code."),
      name: z.string().trim().min(1).max(200).describe("Work-center name."),
      subsidiaryId: UUID("Legal-entity id from manufacturing options").nullable().optional(),
      kind: z.enum(["machine", "labor", "cell"]).describe("Resource type."),
      capacityHoursPerDay: DECIMAL.describe("Exact available capacity hours per day."),
      efficiencyPct: DECIMAL.describe("Expected efficiency percentage as a decimal string."),
      departmentId: UUID("Department id from manufacturing options").nullable().optional(),
      absorbsOverhead: z.boolean().describe("Whether this center absorbs manufacturing overhead."),
      calendarId: UUID("Work calendar id from setup records").nullable().optional(),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "manufacturing.manage"),
    authorizeReplay: async (context, input) =>
      runManufacturing(context, async () => {
        assertVisibleSubsidiary(context, input.subsidiaryId ?? null);
        await lockManufacturingCenterAuthority(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          nativeIdempotencyKey(input.idempotencyKey),
        );
        if (
          !(await getWorkCenter(
            db,
            context.authz.user.orgId,
            nativeIdempotencyKey(input.idempotencyKey),
          ))
        )
          throw notFound("work center");
      }),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.manage");
      return runManufacturing(context, async () => {
        assertVisibleSubsidiary(context, input.subsidiaryId ?? null);
        const orgId = context.authz.user.orgId;
        const payload = {
          code: input.code,
          name: input.name,
          subsidiaryId: input.subsidiaryId,
          kind: input.kind,
          capacityHoursPerDay: input.capacityHoursPerDay,
          efficiencyPct: input.efficiencyPct,
          departmentId: input.departmentId,
          absorbsOverhead: input.absorbsOverhead,
          calendarId: input.calendarId,
        };
        const row = await idempotentManufacturingCreate({
          orgId,
          actorId: context.authz.user.id,
          request: requestForKey(nativeIdempotencyKey(input.idempotencyKey)),
          table: "mfg_work_centers",
          match: payload,
          create: (id, requestId, match) =>
            createWorkCenter(db, orgId, context.authz.user.id, payload as WorkCenterInput, {
              id,
              requestId,
              match,
            }),
          load: async () => {
            await lockManufacturingCenterAuthority(
              db,
              orgId,
              context.authz.user.id,
              nativeIdempotencyKey(input.idempotencyKey),
            );
            return getWorkCenter(db, orgId, nativeIdempotencyKey(input.idempotencyKey));
          },
        });
        return {
          ok: true,
          ...row,
          href: `/manufacturing/work-centers?record=${encodeURIComponent(String(row.id))}`,
        };
      });
    },
  }),
  definition({
    name: "update_work_center",
    title: "Update Work Center",
    description:
      "Update a work center's details, legal-entity assignment, active state or scheduling configuration. Read the current center first; moving it requires access to both its current and destination entity.",
    inputSchema: z.object({
      id: UUID("Work-center id from list_manufacturing_records"),
      patch: z
        .object({
          code: z.string().trim().min(1).max(100).optional().describe("Unique work-center code."),
          name: z.string().trim().min(1).max(200).optional().describe("Work-center name."),
          subsidiaryId: UUID("New legal-entity id from manufacturing options")
            .nullable()
            .optional(),
          kind: z.enum(["machine", "labor", "cell"]).optional().describe("Resource type."),
          capacityHoursPerDay: DECIMAL.optional().describe(
            "Exact available capacity hours per day.",
          ),
          efficiencyPct: DECIMAL.optional().describe(
            "Expected efficiency percentage as a decimal string.",
          ),
          departmentId: UUID("Department id from manufacturing options").nullable().optional(),
          absorbsOverhead: z
            .boolean()
            .optional()
            .describe("Whether this center absorbs manufacturing overhead."),
          calendarId: UUID("Work calendar id from setup records").nullable().optional(),
          isActive: z
            .boolean()
            .optional()
            .describe("Set false to deactivate or true to reactivate the center."),
        })
        .refine((patch) => Object.keys(patch).length > 0)
        .describe("Fields to change on the work center."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "manufacturing.manage"),
    authorizeReplay: (context, input) => authorizeCenterReplay(context, input.id),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.manage");
      return runManufacturing(context, async () => {
        const current = await requireCenter(context, input.id);
        const { isActive, ...patch } = input.patch;
        const target =
          patch.subsidiaryId === undefined
            ? (current.subsidiaryId as string | null)
            : patch.subsidiaryId;
        assertVisibleSubsidiary(context, target);
        let updated = current;
        if (Object.keys(patch).length)
          updated = await updateWorkCenter(
            db,
            context.authz.user.orgId,
            context.authz.user.id,
            input.id,
            patch as Partial<WorkCenterInput>,
          );
        if (isActive === true && current.isActive !== true)
          updated = await reactivateWorkCenter(
            db,
            context.authz.user.orgId,
            context.authz.user.id,
            input.id,
          );
        if (isActive === false && current.isActive !== false)
          updated = await deactivateWorkCenter(
            db,
            context.authz.user.orgId,
            context.authz.user.id,
            input.id,
          );
        return {
          ok: true,
          ...updated,
          href: `/manufacturing/work-centers?record=${encodeURIComponent(input.id)}`,
        };
      });
    },
  }),
  definition({
    name: "add_work_center_rate",
    title: "Add Work Center Rate",
    description:
      "Add an effective-dated machine rate per hour to a work center. Read the center and existing rate history first; the service refuses overlapping or invalid rate windows.",
    inputSchema: z.object({
      workCenterId: UUID("Work-center id from list_manufacturing_records"),
      machineRatePerHour: DECIMAL.describe("Exact machine cost per hour; never a JSON number."),
      effectiveFrom: DATE.describe("First date this rate is effective."),
      effectiveTo: DATE.nullable()
        .optional()
        .describe("Exclusive end date, or null for open-ended."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "manufacturing.manage"),
    authorizeReplay: async (context, input) =>
      runManufacturing(context, async () => {
        await requireCenter(context, input.workCenterId);
        await lockManufacturingCenterAuthority(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          input.workCenterId,
        );
        if (
          !(await getWorkCenterRate(
            db,
            context.authz.user.orgId,
            input.workCenterId,
            nativeIdempotencyKey(input.idempotencyKey),
          ))
        )
          throw notFound("work-center rate");
      }),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.manage");
      return runManufacturing(context, async () => {
        await requireCenter(context, input.workCenterId);
        const orgId = context.authz.user.orgId;
        const payload = {
          machineRatePerHour: input.machineRatePerHour,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo,
        };
        const row = await idempotentManufacturingCreate({
          orgId,
          actorId: context.authz.user.id,
          request: requestForKey(nativeIdempotencyKey(input.idempotencyKey)),
          table: "mfg_work_center_rates",
          match: { workCenterId: input.workCenterId, ...payload },
          create: (id, requestId, match) =>
            addWorkCenterRate(db, orgId, context.authz.user.id, input.workCenterId, payload, {
              id,
              requestId,
              match,
            }),
          load: async () => {
            await lockManufacturingCenterAuthority(
              db,
              orgId,
              context.authz.user.id,
              input.workCenterId,
            );
            return getWorkCenterRate(
              db,
              orgId,
              input.workCenterId,
              nativeIdempotencyKey(input.idempotencyKey),
            );
          },
        });
        return {
          ok: true,
          ...row,
          href: `/manufacturing/work-centers?record=${encodeURIComponent(input.workCenterId)}`,
        };
      });
    },
  }),
  definition({
    name: "end_work_center_rate",
    title: "End Work Center Rate",
    description:
      "Set the end date on a work-center rate when a successor rate takes effect. Copy the center and rate ids from manufacturing reads; history remains intact and the end date must satisfy the rate policy.",
    inputSchema: z.object({
      workCenterId: UUID("Work-center id from list_manufacturing_records"),
      rateId: UUID("Rate id from the work-center record"),
      effectiveTo: DATE.describe("Exclusive end date for the existing rate."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "manufacturing.manage"),
    authorizeReplay: (context, input) => authorizeCenterReplay(context, input.workCenterId),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.manage");
      return runManufacturing(context, async () => {
        await requireCenter(context, input.workCenterId);
        const row = await endWorkCenterRate(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          input.workCenterId,
          input.rateId,
          input.effectiveTo,
        );
        return {
          ok: true,
          ...row,
          href: `/manufacturing/work-centers?record=${encodeURIComponent(input.workCenterId)}`,
        };
      });
    },
  }),
  definition({
    name: "update_manufacturing_policies",
    title: "Update Manufacturing Policies",
    description:
      "Change organization-wide shortage handling, completion tolerance or abnormal-scrap approval threshold. Read current settings first; only an unrestricted manufacturing manager may change this shared policy.",
    inputSchema: z.object({
      shortagePolicy: z.enum(["warn", "refuse"]).describe("How material shortages affect release."),
      completionTolerancePct: DECIMAL.describe(
        "Allowed production completion tolerance percentage.",
      ),
      abnormalScrapApprovalThreshold: DECIMAL.nullable().describe(
        "Exact threshold requiring approval, or null when no threshold is configured.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "manufacturing.manage") && authz.allowedSubsidiaryIds === null,
    authorizeReplay: (context) => authorizeOrgWideReplay(context, "manufacturing.manage"),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.manage");
      assertUnrestricted(context);
      return runManufacturing(context, async () => {
        const payload = {
          shortagePolicy: input.shortagePolicy,
          completionTolerancePct: input.completionTolerancePct,
          abnormalScrapApprovalThreshold: input.abnormalScrapApprovalThreshold,
        };
        const result = await updateManufacturingPolicies(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          payload as ManufacturingPoliciesInput,
        );
        return { ok: true, ...result, href: "/admin/setup/manufacturing" };
      });
    },
  }),
  definition({
    name: "update_manufacturing_item_policy",
    title: "Update Manufacturing Item Policy",
    description:
      "Set an item's manufacturing supply method, lead time, safety stock, minimum quantity, order multiple and planned scrap rate. Read the current item policy first; configuration is organization-wide.",
    inputSchema: z.object({
      itemId: UUID("Item id from item reads"),
      supplyMethod: z
        .enum(["make", "buy", "transfer"])
        .describe("How MRP should source this item."),
      leadTimeDays: z
        .number()
        .int()
        .nonnegative()
        .nullable()
        .describe("Lead time in calendar days, or null when not configured."),
      safetyStockQty: DECIMAL.describe("Exact safety-stock quantity."),
      minimumQty: DECIMAL.describe("Exact minimum order quantity."),
      orderMultipleQty: DECIMAL.describe("Exact order multiple; zero means no multiple."),
      scrapPctPlanned: DECIMAL.describe("Planned scrap percentage as an exact decimal string."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "manufacturing.manage") && authz.allowedSubsidiaryIds === null,
    authorizeReplay: async (context, input) => {
      await authorizeOrgWideReplay(context, "manufacturing.manage");
      await runManufacturing(context, async () => {
        await getItemPolicy(db, context.authz.user.orgId, input.itemId);
      });
    },
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.manage");
      assertUnrestricted(context);
      return runManufacturing(context, async () => {
        const payload = {
          supplyMethod: input.supplyMethod,
          leadTimeDays: input.leadTimeDays,
          safetyStockQty: input.safetyStockQty,
          minimumQty: input.minimumQty,
          orderMultipleQty: input.orderMultipleQty,
          scrapPctPlanned: input.scrapPctPlanned,
        };
        const row = await upsertItemPolicy(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          input.itemId,
          payload as ItemPolicyInput,
        );
        return {
          ok: true,
          ...row,
          href: `/inventory/items?record=${encodeURIComponent(input.itemId)}`,
        };
      });
    },
  }),
  definition({
    name: "preview_standard_cost_rollup",
    title: "Preview Standard Cost Rollup",
    description:
      "Calculate the standard cost for an item, legal entity, date and batch quantity without changing records. Use the preview digest unchanged when proposing the reviewed rollup.",
    inputSchema: BASIS,
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "manufacturing.manage") && authz.allowedSubsidiaryIds === null,
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.manage");
      assertUnrestricted(context);
      return runManufacturing(context, async () => ({
        ok: true,
        ...(await previewStandardRollup(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          input,
        )),
        href: "/manufacturing/work-orders",
      }));
    },
  }),
  definition({
    name: "propose_standard_cost_rollup",
    title: "Propose Standard Cost Rollup",
    description:
      "Submit a reviewed standard-cost rollup using the preview digest and an audit reason. Read the resulting approval/change record; financial policy and approval rules can refuse stale or incomplete previews.",
    inputSchema: BASIS.extend({
      reason: z
        .string()
        .trim()
        .min(8)
        .max(1000)
        .describe("Why this standard-cost change is needed."),
      expectedDigest: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .describe("Digest returned by preview_standard_cost_rollup."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "manufacturing.manage") && authz.allowedSubsidiaryIds === null,
    authorizeReplay: (context) => authorizeOrgWideReplay(context, "manufacturing.manage"),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.manage");
      assertUnrestricted(context);
      return runManufacturing(context, async () => {
        const result = await proposeStandardRollup(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          {
            itemId: input.itemId,
            subsidiaryId: input.subsidiaryId,
            onDate: input.onDate,
            batchQuantity: input.batchQuantity,
            reason: input.reason,
            idempotencyKey: nativeIdempotencyKey(input.idempotencyKey),
            expectedDigest: input.expectedDigest,
          },
        );
        const changeId = "changeId" in result ? String(result.changeId) : undefined;
        return {
          ok: true,
          ...result,
          href: changeId
            ? `/accounting/changes?change=${encodeURIComponent(changeId)}`
            : "/manufacturing/work-orders",
        };
      });
    },
  }),
  definition({
    name: "propose_bom_revision",
    title: "Propose BOM Revision",
    description:
      "Save an effective-dated manufacturing bill-of-materials revision with exact component quantities, by-products and routing operation sequences. Read the current BOM first to copy expectedVersion; manufacturing revisions enter the governed approval flow.",
    inputSchema: z.object({
      assemblyItemId: UUID("Assembly item id from item reads"),
      expectedVersion: z
        .string()
        .nullable()
        .describe("Current version from inspect_manufacturing_bom, or null for the first recipe."),
      reason: z
        .string()
        .max(1000)
        .describe(
          "Reason for the recipe change; manufacturing revisions require an approval reason.",
        ),
      subsidiaryId: UUID("Booking legal-entity id from manufacturing options").optional(),
      components: z
        .array(
          z
            .object({
              componentItemId: UUID("Component item id from item reads"),
              quantityPer: DECIMAL.describe("Exact component quantity for the selected basis."),
              quantityBasis: z
                .enum(["per_unit", "per_batch", "per_formula"])
                .optional()
                .describe("How the component quantity scales."),
              formulaOutputQuantity: DECIMAL.optional().describe(
                "Output quantity used when quantityBasis is per_formula.",
              ),
              effectiveFrom: DATE.nullable()
                .optional()
                .describe("First date this line is effective, or null for open-ended history."),
              effectiveTo: DATE.nullable()
                .optional()
                .describe("Exclusive end date, or null for open-ended."),
              operationSeq: z
                .number()
                .int()
                .positive()
                .nullable()
                .optional()
                .describe(
                  "Routing operation sequence that consumes the line, or null when unassigned.",
                ),
              scrapPct: DECIMAL.nullable()
                .optional()
                .describe("Expected scrap percentage as an exact decimal string."),
              outputCostWeight: DECIMAL.nullable()
                .optional()
                .describe("By-product joint-cost weight, when applicable."),
              isByproduct: z
                .boolean()
                .optional()
                .describe("Whether the line is a by-product rather than a consumed component."),
            })
            .describe("One effective-dated component or by-product line."),
        )
        .max(500)
        .describe("Complete target recipe for the new revision."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage") && authz.allowedSubsidiaryIds === null,
    authorizeReplay: (context) => {
      assertBomManage(context);
    },
    featureKey: "inventory",
    execute: async (context, input) => {
      assertBomManage(context);
      return runBom(async () => {
        const orgId = context.authz.user.orgId;
        const payload: BomPolicyInput = {
          assemblyItemId: input.assemblyItemId,
          expectedVersion: input.expectedVersion,
          reason: input.reason,
          subsidiaryId: input.subsidiaryId,
          requestKey: nativeIdempotencyKey(input.idempotencyKey),
          components: input.components.map((line, index) => ({
            componentItemId: line.componentItemId,
            quantityPer: line.quantityPer,
            quantityBasis: line.quantityBasis,
            formulaOutputQuantity: line.formulaOutputQuantity,
            sortOrder: index,
            effectiveFrom: line.effectiveFrom ?? null,
            effectiveTo: line.effectiveTo ?? null,
            operationSeq: line.operationSeq ?? null,
            scrapPct: line.scrapPct ?? null,
            outputCostWeight: line.outputCostWeight ?? null,
            isByproduct: line.isByproduct ?? false,
          })),
        };
        const result = await withOrgTransaction(orgId, () =>
          saveBomPolicy(db, orgId, context.authz.user.id, payload),
        );
        return {
          ok: true,
          ...result,
          href: `/inventory/bom?assemblyItemId=${encodeURIComponent(input.assemblyItemId)}`,
        };
      });
    },
  }),
];
