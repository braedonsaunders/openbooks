import { apiErrorResponse } from "@/lib/api/error-response";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { startReconciliation } from "@openbooks/engine/banking/banking";
import { listReconciliationRouteRows } from "@openbooks/engine/banking/reconciliation-queries";
import { normalizeMoney } from "@openbooks/engine/money/money";
import { isUuid } from "@/lib/list-params";
import { canonicalDecimal } from "@/lib/exact-decimal";
import { moneyRefusal } from "@/lib/payroll-decimal-refusal";
const POSTBodySchema1 = z.object({
  accountId: uuidString(),
  throughDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  statementBalance: z.string(),
});

export const runtime = "nodejs";

/** List reconciliation sessions, optionally for one account. */
export const GET = defineRoute({
  permission: "banking.read",
  feature: "banking",
  handler: async ({ request: req, authz: routeAuthz }) => {
    const gate = routeAuthz;
    const { user } = gate;
    const accountId = new URL(req.url).searchParams.get("accountId");
    if (accountId && !isUuid(accountId)) {
      return NextResponse.json({ error: "invalid accountId" }, { status: 400 });
    }
    const rows = await listReconciliationRouteRows({
      orgId: user.orgId,
      accountId,
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
    });
    return NextResponse.json({ reconciliations: rows });
  },
});

/** Start a reconciliation session (one open session per account). */
export const POST = defineRoute({
  permission: "banking.reconcile",
  feature: "banking",
  body: POSTBodySchema1,
  handler: async ({ request: _req, authz: routeAuthz, body: routeBody }) => {
    const gate = routeAuthz;
    const { user } = gate;

    const body = routeBody as {
      accountId?: string;
      throughDate?: string;
      statementBalance?: string;
    };
    if (
      !body.accountId ||
      !body.throughDate ||
      body.statementBalance == null ||
      body.statementBalance === ""
    ) {
      return NextResponse.json(
        { error: "accountId, throughDate and statementBalance are required" },
        { status: 400 },
      );
    }
    if (!isUuid(body.accountId)) {
      return NextResponse.json({ error: "invalid accountId" }, { status: 400 });
    }
    const statementBalanceRaw = canonicalDecimal(body.statementBalance, 4);
    if (statementBalanceRaw === null) {
      return NextResponse.json(
        { error: moneyRefusal("Statement balance", body.statementBalance) },
        { status: 422 },
      );
    }
    let statementBalance: string;
    try {
      statementBalance = normalizeMoney(statementBalanceRaw);
    } catch {
      return NextResponse.json(
        { error: "Statement balance is out of range for the ledger" },
        { status: 422 },
      );
    }
    try {
      const { id } = await startReconciliation(
        {
          accountId: body.accountId,
          throughDate: body.throughDate,
          statementBalance,
        },
        { orgId: user.orgId, userId: user.id, allowedSubsidiaryIds: gate.allowedSubsidiaryIds },
      );
      return NextResponse.json({ id });
    } catch (e) {
      return apiErrorResponse(e);
    }
  },
});
