import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { guardUnrestrictedScope } from "../../../../lib/authz";
import { notFound } from "@/lib/api/responses";
import {
  BankMatchRuleManagementError,
  createBankMatchRule,
  updateBankMatchRule,
} from "../../../../lib/banking-rule-management";
const ruleFields = {
  name: z.string().trim().min(1).max(200),
  criteria: z.object({
    version: z.literal(2),
    match: z.json(),
    accountScope: z.array(uuidString()).optional(),
  }),
  outcome: z.json(),
  priority: z.number().int().optional(),
  isActive: z.boolean().optional(),
};
const PATCHBodySchema1 = z.object({ id: uuidString(), ...ruleFields });

const POSTBodySchema1 = z.object(ruleFields);

export const runtime = "nodejs";

export const POST = defineRoute({
  permission: "banking.reconcile",
  feature: "banking",
  body: POSTBodySchema1,
  handler: async ({ authz: routeAuthz, body }) => {
    const gate = routeAuthz;
    const unrestricted = guardUnrestrictedScope(gate);
    if (unrestricted) return unrestricted;
    try {
      const created = await createBankMatchRule(gate.user.orgId, gate.user.id, body);
      return NextResponse.json({ id: created.id });
    } catch (error) {
      if (error instanceof BankMatchRuleManagementError)
        return error.status === 404
          ? notFound("record")
          : NextResponse.json({ error: error.message }, { status: error.status });
      throw error;
    }
  },
});

export const PATCH = defineRoute({
  permission: "banking.reconcile",
  feature: "banking",
  body: PATCHBodySchema1,
  handler: async ({ authz: routeAuthz, body }) => {
    const gate = routeAuthz;
    const unrestricted = guardUnrestrictedScope(gate);
    if (unrestricted) return unrestricted;
    try {
      const { id, ...fields } = body;
      await updateBankMatchRule(gate.user.orgId, gate.user.id, id, fields);
      return NextResponse.json({ ok: true });
    } catch (error) {
      if (error instanceof BankMatchRuleManagementError)
        return error.status === 404
          ? notFound("record")
          : NextResponse.json({ error: error.message }, { status: error.status });
      throw error;
    }
  },
});
