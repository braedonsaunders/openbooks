import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { crmOpportunityScope } from "@/lib/crm-scope";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { db } from "@openbooks/engine/platform/db";
import { normalizeMoney } from "@openbooks/engine/money/money";
import { allocateDocumentNumber } from "@openbooks/engine/records/numbering";
import { isDocKindEnabled } from "@/lib/documents.ts";
import { guardPermission } from "@/lib/authz";
import { canonicalDecimal } from "@/lib/exact-decimal";
import { decimalNullRefusal, moneyRefusal } from "@/lib/payroll-decimal-refusal";
import { isFeatureEnabled } from "@/lib/features";
import { isUuid } from "@/lib/list-params";
import { getTranslations } from "next-intl/server";
import { claimSetupCreate, SetupCreateConflict } from "@/lib/api/idempotency";
import { draftDocumentId } from "@/lib/order-cycle";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

const INVENTORY_ITEM_KINDS = new Set(["inventory", "assembly", "kit"]);

class EstimateInputRefusalError extends Error {
  readonly name = "EstimateInputRefusalError";
}

async function authorizeEstimate() {
  const gate = await guardPermission("crm.opportunities.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "crm"))) return notFound("route");
  const receivables = await guardPermission("ar.create");
  return receivables instanceof NextResponse ? receivables : gate;
}

/** Persist leftover estimate projected amount through exact decimal then ledger money. Fail closed. */
function persistEstimateProjectedAmount(value: unknown): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) throw new EstimateInputRefusalError(moneyRefusal("Projected amount", value));
  try {
    return normalizeMoney(exact);
  } catch {
    throw new EstimateInputRefusalError(moneyRefusal("Projected amount", value));
  }
}

/** Persist leftover estimate line amount through exact decimal then ledger money. Fail closed. */
function persistEstimateLineAmount(value: unknown): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) throw new EstimateInputRefusalError(moneyRefusal("Line amount", value));
  try {
    return normalizeMoney(exact);
  } catch {
    throw new EstimateInputRefusalError(moneyRefusal("Line amount", value));
  }
}

/** Persist leftover estimate line quantity through exact decimal then ledger money. Fail closed. */
function persistEstimateLineQuantity(value: unknown): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null)
    throw new EstimateInputRefusalError(
      decimalNullRefusal("Line quantity", "a quantity", value, 4),
    );
  try {
    return normalizeMoney(exact);
  } catch {
    throw new EstimateInputRefusalError("Line quantity is out of range for the ledger");
  }
}

/** Persist leftover estimate line unit price through exact decimal then ledger money. Fail closed. */
function persistEstimateLineUnitPrice(value: unknown): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) throw new EstimateInputRefusalError(moneyRefusal("Line unit price", value));
  try {
    return normalizeMoney(exact);
  } catch {
    throw new EstimateInputRefusalError(moneyRefusal("Line unit price", value));
  }
}

export const POST = defineRoute({
  authorize: authorizeEstimate,
  feature: "crm",
  params: z.object({ id: z.string() }),
  handler: async ({ request: req, authz: gate, params: routeParams }) => {
    const params = Promise.resolve(routeParams);
    const { user } = gate;
    if (!(await isDocKindEnabled(user.orgId, "quote"))) {
      return notFound("record");
    }
    const { id } = await params;
    if (!isUuid(id)) return notFound("record");
    // A retry or double click must not mint a second quote. The caller sends
    // one Idempotency-Key per estimate action (the house draft-route pattern):
    // same key replays the first quote, a changed payload conflicts, and a
    // fresh key deliberately starts a new revision.
    const t = await getTranslations("crm");
    const idempotencyKey = req.headers.get("Idempotency-Key")?.trim() ?? "";
    if (!isUuid(idempotencyKey)) {
      return NextResponse.json({ error: t("opportunities.estimateKeyRequired") }, { status: 400 });
    }
    const draftId = draftDocumentId(user.orgId, `${id}:${idempotencyKey}`);
    // Opportunity lines stay as stored. Turning Inventory off must 404 a new
    // estimate that would copy inventory / assembly / kit onto a quote.
    if (!(await isFeatureEnabled(user.orgId, "inventory"))) {
      const lineItems = await db.execute<{ kind: string }>(
        sql`
        select i.kind
          from crm_opportunity_lines line
          join items i on i.id = line.item_id and i.org_id = line.org_id
         where line.org_id = ${user.orgId} and line.opportunity_id = ${id}`,
        "objects",
      );
      if (lineItems.some((row) => INVENTORY_ITEM_KINDS.has(row.kind))) {
        return notFound("record");
      }
    }
    const today = await businessToday(user.orgId);
    const result = await db
      .transaction(async (tx) => {
        // Serialize concurrent retries on the key so the loser replays instead
        // of racing past the claim and dying on the insert conflict.
        await tx.execute(sql`
        select pg_advisory_xact_lock(hashtextextended(${draftId}, 0))`);
        const opportunity = await tx.execute(
          sql`
        select o.* from crm_opportunities o where o.id = ${id} and o.org_id = ${user.orgId} and o.is_active${crmOpportunityScope(gate.allowedSubsidiaryIds)} for update of o`,
          "objects",
        );
        const op = opportunity[0];
        if (!op) return notFound("record");
        if (!op?.party_id) {
          return NextResponse.json(
            { error: t("opportunities.estimateNeedsAccount") },
            { status: 422 },
          );
        }
        // The revision pins the conversion inputs: an identical retry replays
        // the first quote, while a reused key over an edited opportunity
        // conflicts instead of returning a stale quote as though it matched.
        const match = { opportunity_id: id, opportunity_revision: String(op.revision_seq ?? "") };
        const claim = await claimSetupCreate(tx, {
          orgId: user.orgId,
          table: "documents",
          key: draftId,
          match,
        });
        if (claim.kind === "replay") {
          const live = (
            await tx.execute<{ id: string; document_number: string }>(
              sql`
          select id, document_number from documents where id = ${draftId} and org_id = ${user.orgId}`,
              "objects",
            )
          )[0];
          if (live)
            return { replay: true as const, id: live.id, documentNumber: live.document_number };
        }
        // Every source line must be represented on the quote: document lines
        // require an item or an account (doc_lines_target), and opportunity
        // lines carry no account, so an itemless line has nowhere to post —
        // inventing an account would be a silent financial fallback. Refuse by
        // name, listing the lines, before the number is consumed or anything is
        // written. (A non-null item_id always joins: the line FK is composite on
        // (org_id, item_id), so the item exists in this org by construction.)
        const lines = await tx.execute(
          sql`
        select * from crm_opportunity_lines
         where org_id = ${user.orgId} and opportunity_id = ${id}
         order by line_number`,
          "objects",
        );
        if (!lines.length) {
          return NextResponse.json(
            { error: t("opportunities.estimateNeedsLines") },
            { status: 422 },
          );
        }
        const itemless = lines.filter((line) => line.item_id === null);
        if (itemless.length) {
          return NextResponse.json(
            {
              error: t("opportunities.estimateItemlessLines", {
                lines: itemless.map((row) => String(row.line_number)).join(", "),
              }),
            },
            { status: 422 },
          );
        }
        const number = await allocateDocumentNumber(tx, user.orgId, "quote", "EST-");
        const projected = persistEstimateProjectedAmount(op.projected_amount ?? "0");
        const document = await tx.execute<{ id: string }>(
          sql`
        insert into documents
          (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, due_date, currency,
           status, department_id, location_id, class_id, extra_dims, memo, subtotal, tax_total, total,
           created_by, updated_by)
        values (${draftId}, ${user.orgId}, 'quote', ${number}, ${op.party_id}, ${op.subsidiary_id}, ${today},
                ${op.expected_close_date}, ${op.currency}, 'draft', ${op.department_id}, ${op.location_id},
                ${op.class_id}, ${JSON.stringify(op.extra_dims ?? {})}::jsonb, ${op.title}, ${projected},
                0, ${projected}, ${user.id}, ${user.id}) returning id`,
          "objects",
        );
        const docId = document[0]!.id;
        for (const line of lines)
          await tx.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, item_id, account_id, description, quantity, unit, unit_price,
           amount, tax_amount, created_by, updated_by)
        select ${user.orgId}, ${docId}, ${line.line_number}, ${line.item_id}, i.income_account_id,
               ${line.description}, ${persistEstimateLineQuantity(line.quantity)}, ${line.unit}, ${persistEstimateLineUnitPrice(line.unit_price)},
               ${persistEstimateLineAmount(line.amount)}, 0, ${user.id}, ${user.id}
          from items i where i.id = ${line.item_id} and i.org_id = ${user.orgId}`);
        await tx.execute(sql`
        insert into crm_opportunity_documents (org_id, opportunity_id, document_id, created_by, updated_by)
        values (${user.orgId}, ${id}, ${docId}, ${user.id}, ${user.id})`);
        // The replay lookup reads this row's match image: without it a retry
        // could never replay and every key would conflict.
        await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values (${user.orgId}, 'documents', ${docId}, 'insert', ${JSON.stringify({ match })}::jsonb, ${user.id}, ${draftId})`);
        return { replay: false as const, id: docId, documentNumber: number };
      })
      .catch((error: unknown) => {
        if (error instanceof SetupCreateConflict) {
          return NextResponse.json(
            { error: t("opportunities.estimateKeyConflict") },
            { status: error.status },
          );
        }
        if (error instanceof EstimateInputRefusalError) {
          return { refusal: error.message };
        }
        return { error: t("opportunities.estimateFailed") };
      });
    if (result instanceof NextResponse) return result;
    if ("refusal" in result) return NextResponse.json({ error: result.refusal }, { status: 422 });
    if ("error" in result) return NextResponse.json({ error: result.error }, { status: 500 });
    return NextResponse.json(
      { id: result.id, documentNumber: result.documentNumber },
      { status: result.replay ? 200 : 201 },
    );
  },
});
