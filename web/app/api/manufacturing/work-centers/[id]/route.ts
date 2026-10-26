import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { db } from "@openbooks/engine/platform/db";
import {
  deactivateWorkCenter,
  getWorkCenter,
  reactivateWorkCenter,
  updateWorkCenter,
  type WorkCenterInput,
} from "@openbooks/engine/manufacturing/work-centers";
import { guardSubsidiaryScope } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { manufacturingTransaction } from "../../_transaction";

const Params = z.object({ id: uuidString() });
const Patch = z
  .object({
    code: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional(),
    subsidiaryId: uuidString().nullable().optional(),
    kind: z.enum(["machine", "labor", "cell"]).optional(),
    capacityHoursPerDay: z.string().optional(),
    efficiencyPct: z.string().optional(),
    departmentId: uuidString().nullable().optional(),
    absorbsOverhead: z.boolean().optional(),
    calendarId: uuidString().nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0);

export const GET = defineRoute({
  permission: "manufacturing.read",
  feature: "manufacturing",
  params: Params,
  handler: async ({ authz, params }) =>
    manufacturingTransaction(authz.user.orgId, async () => {
      const row = await getWorkCenter(db, authz.user.orgId, params.id);
      if (!row) return notFound("work center");
      const denied = guardSubsidiaryScope(authz, row.subsidiaryId as string | null);
      return denied ?? Response.json(row);
    }),
});

export const PATCH = defineRoute({
  permission: "manufacturing.manage",
  feature: "manufacturing",
  params: Params,
  body: Patch,
  handler: async ({ authz, params, body }) =>
    manufacturingTransaction(authz.user.orgId, async () => {
      const current = await getWorkCenter(db, authz.user.orgId, params.id);
      if (!current) return notFound("work center");
      const { isActive, ...patch } = body;
      const targetSubsidiaryId =
        patch.subsidiaryId === undefined
          ? (current.subsidiaryId as string | null)
          : patch.subsidiaryId;
      const denied =
        guardSubsidiaryScope(authz, current.subsidiaryId as string | null) ??
        guardSubsidiaryScope(authz, targetSubsidiaryId);
      if (denied) return denied;
      let updated = current;
      if (Object.keys(patch).length)
        updated = await updateWorkCenter(
          db,
          authz.user.orgId,
          authz.user.id,
          params.id,
          patch as Partial<WorkCenterInput>,
        );
      if (isActive === true && current.isActive !== true)
        updated = await reactivateWorkCenter(db, authz.user.orgId, authz.user.id, params.id);
      if (isActive === false && current.isActive !== false)
        updated = await deactivateWorkCenter(db, authz.user.orgId, authz.user.id, params.id);
      return Response.json(updated);
    }),
});
