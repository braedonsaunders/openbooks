import "server-only";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { db } from "@openbooks/engine/platform/db";
import { normalizeMoney } from "@openbooks/engine/money/money";
import { allocateDocumentNumber } from "@openbooks/engine/records/numbering";
import { canonicalDecimal } from "../exact-decimal";
import { decimalNullRefusal, moneyRefusal } from "../payroll-decimal-refusal";
import { isFeatureEnabled } from "../features";
import { isUuid } from "../list-params";
import { getTranslations } from "next-intl/server";
import { claimSetupCreate, SetupCreateConflict } from "../api/idempotency";
import { draftDocumentId } from "../order-cycle";
import { crmOpportunityScope } from "../crm-scope";
import { isDocKindEnabled } from "../documents";
import { notFound } from "../api/responses";
import type { Authz } from "../authz";

const INVENTORY_ITEM_KINDS = new Set(["inventory", "assembly", "kit"]);

/** Map the application idempotency key into the UUID contract used by the HTTP route. */
export function crmOpportunityEstimateKey(idempotencyKey: string): string {
  const bytes = createHash("sha256").update(idempotencyKey).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

class EstimateInputRefusalError extends Error {
  readonly name = "EstimateInputRefusalError";
}

/** Persist estimate money through exact decimal then ledger money. Fail closed. */
function persistEstimateAmount(field: string, value: unknown): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) throw new EstimateInputRefusalError(moneyRefusal(field, value));
  try {
    return normalizeMoney(exact);
  } catch {
    throw new EstimateInputRefusalError(moneyRefusal(field, value));
  }
}

function persistEstimateQuantity(value: unknown): string {
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

/** Create the quote from the opportunity using the route's tenant and lifecycle rules. */
export async function createCrmOpportunityEstimate(
  authz: Authz,
  opportunityId: string,
  idempotencyKey: string,
): Promise<NextResponse> {
  const { user } = authz;
  if (!(await isDocKindEnabled(user.orgId, "quote"))) return notFound("record");
  if (!isUuid(opportunityId)) return notFound("record");
  const t = await getTranslations("crm");
  if (!isUuid(idempotencyKey)) {
    return NextResponse.json({ error: t("opportunities.estimateKeyRequired") }, { status: 400 });
  }
  const draftId = draftDocumentId(user.orgId, `${opportunityId}:${idempotencyKey}`);
  if (!(await isFeatureEnabled(user.orgId, "inventory"))) {
    const lineItems = await db.execute<{ kind: string }>(
      sql`
        select i.kind
          from crm_opportunity_lines line
          join items i on i.id = line.item_id and i.org_id = line.org_id
         where line.org_id = ${user.orgId} and line.opportunity_id = ${opportunityId}`,
      "objects",
    );
    if (lineItems.some((row) => INVENTORY_ITEM_KINDS.has(row.kind))) return notFound("record");
  }
  const today = await businessToday(user.orgId);
  const result = await db
    .transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${draftId}, 0))`);
      const opportunity = await tx.execute(
        sql`
        select o.* from crm_opportunities o
         where o.id = ${opportunityId} and o.org_id = ${user.orgId} and o.is_active${crmOpportunityScope(authz.allowedSubsidiaryIds)}
         for update of o`,
        "objects",
      );
      const op = opportunity[0];
      if (!op) return notFound("record");
      if (!op.party_id) {
        return NextResponse.json(
          { error: t("opportunities.estimateNeedsAccount") },
          { status: 422 },
        );
      }
      const match = {
        opportunity_id: opportunityId,
        opportunity_revision: String(op.revision_seq ?? ""),
      };
      const claim = await claimSetupCreate(tx, {
        orgId: user.orgId,
        table: "documents",
        key: draftId,
        match,
      });
      if (claim.kind === "replay") {
        const live = await tx.execute<{ id: string; document_number: string }>(
          sql`select id, document_number from documents where id = ${draftId} and org_id = ${user.orgId}`,
          "objects",
        );
        if (live[0])
          return { replay: true as const, id: live[0].id, documentNumber: live[0].document_number };
      }
      const lines = await tx.execute(
        sql`select * from crm_opportunity_lines where org_id = ${user.orgId} and opportunity_id = ${opportunityId} order by line_number`,
        "objects",
      );
      if (!lines.length)
        return NextResponse.json({ error: t("opportunities.estimateNeedsLines") }, { status: 422 });
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
      const projected = persistEstimateAmount("Projected amount", op.projected_amount ?? "0");
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
      const docId = document[0]?.id;
      if (!docId) throw new Error("The quote draft was not created.");
      for (const line of lines) {
        await tx.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, item_id, account_id, description, quantity, unit, unit_price,
           amount, tax_amount, created_by, updated_by)
        select ${user.orgId}, ${docId}, ${line.line_number}, ${line.item_id}, i.income_account_id,
               ${line.description}, ${persistEstimateQuantity(line.quantity)}, ${line.unit},
               ${persistEstimateAmount("Line unit price", line.unit_price)},
               ${persistEstimateAmount("Line amount", line.amount)}, 0, ${user.id}, ${user.id}
          from items i where i.id = ${line.item_id} and i.org_id = ${user.orgId}`);
      }
      await tx.execute(sql`
        insert into crm_opportunity_documents (org_id, opportunity_id, document_id, created_by, updated_by)
        values (${user.orgId}, ${opportunityId}, ${docId}, ${user.id}, ${user.id})`);
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values (${user.orgId}, 'documents', ${docId}, 'insert', ${JSON.stringify({ match })}::jsonb, ${user.id}, ${draftId})`);
      return { replay: false as const, id: docId, documentNumber: number };
    })
    .catch((error: unknown) => {
      if (error instanceof SetupCreateConflict)
        return NextResponse.json(
          { error: t("opportunities.estimateKeyConflict") },
          { status: error.status },
        );
      if (error instanceof EstimateInputRefusalError)
        return NextResponse.json({ error: error.message }, { status: 422 });
      return NextResponse.json({ error: t("opportunities.estimateFailed") }, { status: 500 });
    });
  if (result instanceof NextResponse) return result;
  return NextResponse.json(
    { id: result.id, documentNumber: result.documentNumber },
    { status: result.replay ? 200 : 201 },
  );
}
