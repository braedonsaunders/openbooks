import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { guardUnrestrictedScope } from "../../../../../lib/authz";
import { isUuid } from "../../../../../lib/list-params";
import { notFound } from "@/lib/api/responses";
import {
  BankMatchRuleManagementError,
  deleteBankMatchRule,
} from "../../../../../lib/banking-rule-management";

export const runtime = "nodejs";

export const DELETE = defineRoute({
  permission: "banking.reconcile",
  feature: "banking",
  handler: async ({ authz: routeAuthz, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const unrestricted = guardUnrestrictedScope(gate);
    if (unrestricted) return unrestricted;
    const { id } = await params;
    if (!isUuid(id)) return notFound("record");
    try {
      await deleteBankMatchRule(gate.user.orgId, gate.user.id, id);
      return NextResponse.json({ ok: true });
    } catch (error) {
      if (error instanceof BankMatchRuleManagementError && error.status === 404)
        return notFound("record");
      if (error instanceof BankMatchRuleManagementError)
        return NextResponse.json({ error: error.message }, { status: error.status });
      throw error;
    }
  },
});
