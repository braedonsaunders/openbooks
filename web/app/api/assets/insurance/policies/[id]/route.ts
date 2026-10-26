import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import {
  removeInsuranceCoverage,
  renewInsurancePolicy,
  setInsuranceCoverage,
  updateInsurancePolicy,
} from "@openbooks/engine/assets/asset-insurance";
import { calendarDate, id, money, optionalMoney, reasonText, scopeOf } from "../../../_depth";
import { policyFields } from "../../_fields";

export const runtime = "nodejs";

const params = z.object({ id });

/** Change a policy's terms or cancel it; the revision guards against concurrent edits. */
export const PATCH = defineRoute({
  permission: "assets.maintain",
  feature: "assetInsurance",
  params,
  body: z.strictObject({
    ...policyFields,
    status: z.enum(["active", "cancelled"]),
    expectedUpdatedAt: z.string().min(1),
  }),
  invalidBodyStatus: 422,
  handler: async ({ authz: gate, params: routeParams, body: input }) => {
    const { id: policyId } = await routeParams;
    return NextResponse.json(
      await updateInsurancePolicy(gate.user.orgId, policyId, input, {
        actorId: gate.user.id,
        allowedSubsidiaryIds: scopeOf(gate),
      }),
    );
  },
});

const action = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("set_coverage"),
    assetId: id,
    insuredValue: money("insuredValue"),
    replacementValue: optionalMoney("replacementValue"),
  }),
  z.strictObject({ action: z.literal("remove_coverage"), assetId: id, reason: reasonText }),
  z.strictObject({
    action: z.literal("renew"),
    policyNumber: z.string().trim().max(120).nullable().optional(),
    coverageStartsOn: calendarDate("coverageStartsOn"),
    coverageEndsOn: calendarDate("coverageEndsOn"),
    premium: optionalMoney("premium"),
    deductible: optionalMoney("deductible"),
  }),
]);

/** Add or change a covered asset, remove one, or renew the policy into a new period. */
export const POST = defineRoute({
  permission: "assets.maintain",
  feature: "assetInsurance",
  params,
  body: action,
  invalidBodyStatus: 422,
  handler: async ({ authz: gate, params: routeParams, body: input }) => {
    const { id: policyId } = await routeParams;
    const common = { policyId, actorId: gate.user.id, allowedSubsidiaryIds: scopeOf(gate) };
    switch (input.action) {
      case "set_coverage":
        return NextResponse.json(
          await setInsuranceCoverage(gate.user.orgId, {
            ...common,
            assetId: input.assetId,
            insuredValue: input.insuredValue,
            replacementValue: input.replacementValue ?? null,
          }),
        );
      case "remove_coverage":
        await removeInsuranceCoverage(gate.user.orgId, {
          ...common,
          assetId: input.assetId,
          reason: input.reason,
        });
        return NextResponse.json({ ok: true });
      case "renew":
        return NextResponse.json(
          await renewInsurancePolicy(gate.user.orgId, {
            ...common,
            policyNumber: input.policyNumber ?? null,
            coverageStartsOn: input.coverageStartsOn,
            coverageEndsOn: input.coverageEndsOn,
            premium: input.premium ?? null,
            deductible: input.deductible ?? null,
          }),
          { status: 201 },
        );
    }
  },
});
