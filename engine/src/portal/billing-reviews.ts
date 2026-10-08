import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";

/**
 * Customer review of pre-billing worksheets, as the customer portal sees it.
 *
 * A supplier sends an approved worksheet to its customer before invoicing.
 * The customer sees exactly the lines that will be billed — never cost,
 * internal adjustments or held work — and either accepts the package or
 * disputes individual lines. Every read is filtered to the session party: a
 * worksheet belongs to the customer on its project, and another customer's
 * worksheet is indistinguishable from a missing one.
 *
 * The review digest fingerprints what the customer was shown. It is computed
 * when the worksheet is sent and again when the customer decides; an
 * acceptance only lands when both agree, so a customer can never accept
 * content that changed after the page was rendered.
 */

export type PortalBillingReviewLine = {
  id: string;
  lineNumber: number;
  sourceDate: string;
  description: string | null;
  quantity: string;
  unit: string | null;
  amount: string;
  disputeNote: string | null;
};

export type PortalBillingReviewSummary = {
  id: string;
  worksheetNumber: string;
  projectName: string;
  periodStart: string | null;
  periodEnd: string;
  currency: string;
  total: string;
  status: string;
  sentAt: string | null;
  decision: "accepted" | "disputed" | null;
  decidedAt: string | null;
};

export type PortalBillingReview = PortalBillingReviewSummary & {
  projectReference: string | null;
  purchaseOrderNumber: string | null;
  digest: string;
  lines: PortalBillingReviewLine[];
};

type DigestLine = { id: string; amount: string; quantity: string; description: string | null };

/** Canonical fingerprint of a worksheet's billable content. Pure. */
export function billingReviewDigest(input: {
  id: string;
  periodEnd: string;
  total: string;
  lines: DigestLine[];
}): string {
  const canonical = JSON.stringify([
    input.id,
    input.periodEnd,
    input.total,
    input.lines.map((line) => [line.id, line.amount, line.quantity, line.description ?? ""]),
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Recompute the digest of a worksheet's current billable lines. */
export async function currentBillingReviewDigest(
  orgId: string,
  prebillId: string,
  runner: SqlExecutor = db,
): Promise<string | null> {
  const header = (await runner.execute<{ period_end: string; total: string }>(sql`
    select period_end::text as period_end, proposed_bill_amount::text as total
      from wip_prebills where org_id = ${orgId} and id = ${prebillId}
  `)).rows[0];
  if (!header) return null;
  const lines = (await runner.execute<DigestLine>(sql`
    select id, proposed_bill_amount::text as amount, quantity::text as quantity, description
      from wip_prebill_lines
     where org_id = ${orgId} and prebill_id = ${prebillId} and disposition = 'bill'
     order by line_number
  `)).rows;
  return billingReviewDigest({ id: prebillId, periodEnd: header.period_end, total: header.total, lines });
}

/** Pre-billing reviews are visible only while the supplier has pre-billing on. */
async function reviewsEnabled(orgId: string): Promise<boolean> {
  const [projects, prebilling] = await Promise.all([
    orgFeatureEnabled(orgId, "projects"),
    orgFeatureEnabled(orgId, "wipBilling"),
  ]);
  return projects && prebilling;
}

/**
 * Worksheets a customer has been asked to review: those awaiting a decision
 * first, then the most recent decisions so the customer can see what they
 * accepted or disputed.
 */
export async function portalBillingReviews(
  orgId: string,
  partyId: string,
  runner: SqlExecutor = db,
): Promise<PortalBillingReviewSummary[]> {
  if (!(await reviewsEnabled(orgId))) return [];
  return (await runner.execute<PortalBillingReviewSummary>(sql`
    select w.id, w.worksheet_number as "worksheetNumber", p.name as "projectName",
           w.period_start::text as "periodStart", w.period_end::text as "periodEnd",
           coalesce(s.base_currency, o.base_currency) as currency,
           w.proposed_bill_amount::text as total, w.status,
           w.customer_review_sent_at::text as "sentAt",
           w.customer_decision as decision, w.customer_decided_at::text as "decidedAt"
      from wip_prebills w
      join projects p on p.org_id = w.org_id and p.id = w.project_id
      join orgs o on o.id = w.org_id
      left join subsidiaries s on s.org_id = p.org_id and s.id = p.subsidiary_id
     where w.org_id = ${orgId} and p.customer_id = ${partyId}
       and w.customer_review_sent_at is not null
       and w.status <> 'void'
     order by (w.status = 'customer_review') desc, w.customer_review_sent_at desc
     limit 50
  `)).rows;
}

/** One worksheet as the customer sees it, or null when it is not theirs. */
export async function portalBillingReview(
  orgId: string,
  partyId: string,
  prebillId: string,
  runner: SqlExecutor = db,
): Promise<PortalBillingReview | null> {
  if (!(await reviewsEnabled(orgId))) return null;
  const header = (await runner.execute<PortalBillingReviewSummary & {
    projectReference: string | null;
    purchaseOrderNumber: string | null;
  }>(sql`
    select w.id, w.worksheet_number as "worksheetNumber", p.name as "projectName",
           p.code as "projectReference",
           coalesce(w.customer_po_number, p.customer_po_number) as "purchaseOrderNumber",
           w.period_start::text as "periodStart", w.period_end::text as "periodEnd",
           coalesce(s.base_currency, o.base_currency) as currency,
           w.proposed_bill_amount::text as total, w.status,
           w.customer_review_sent_at::text as "sentAt",
           w.customer_decision as decision, w.customer_decided_at::text as "decidedAt"
      from wip_prebills w
      join projects p on p.org_id = w.org_id and p.id = w.project_id
      join orgs o on o.id = w.org_id
      left join subsidiaries s on s.org_id = p.org_id and s.id = p.subsidiary_id
     where w.org_id = ${orgId} and w.id = ${prebillId} and p.customer_id = ${partyId}
       and w.customer_review_sent_at is not null and w.status <> 'void'
  `)).rows[0];
  if (!header) return null;
  const lines = (await runner.execute<PortalBillingReviewLine>(sql`
    select id, line_number as "lineNumber", source_date::text as "sourceDate", description,
           quantity::text as quantity, unit, proposed_bill_amount::text as amount,
           customer_dispute_note as "disputeNote"
      from wip_prebill_lines
     where org_id = ${orgId} and prebill_id = ${prebillId} and disposition = 'bill'
     order by line_number
  `)).rows;
  const digest = billingReviewDigest({
    id: header.id,
    periodEnd: header.periodEnd,
    total: header.total,
    lines: lines.map((line) => ({ id: line.id, amount: line.amount, quantity: line.quantity, description: line.description })),
  });
  return { ...header, digest, lines };
}
