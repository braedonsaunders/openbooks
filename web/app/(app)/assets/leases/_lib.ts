import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { subsidiaryVisibleFilter } from "@/lib/subsidiaries";
export type LeaseDisplay = {
  id: string;
  lease_number: string;
  description: string | null;
  status: string;
  subsidiary_id: string;
  commencement_on: string;
  term_periods: number;
  payment_frequency: "monthly" | "quarterly" | "annual";
  payment_timing: "advance" | "arrears";
  payment_amount: string;
  annual_discount_rate_percent: string;
  classification: string;
  initial_liability: string | null;
  initial_rou_asset: string | null;
  revision: number;
  classification_inputs: Record<string, unknown>;
};
export async function loadLease(
  orgId: string,
  id: string,
  allowed: Set<string> | null,
) {
  const lease = (
    await db.execute<LeaseDisplay>(sql`select id,lease_number,description,status,subsidiary_id,
    commencement_on::text,term_periods,payment_frequency,payment_timing,payment_amount::text,annual_discount_rate_percent::text,
    classification,initial_liability::text,initial_rou_asset::text,revision,classification_inputs
    from lease_agreements la where org_id=${orgId} and id=${id} ${subsidiaryVisibleFilter(sql`la.subsidiary_id`, allowed)}`)
  ).rows[0];
  if (!lease) return null;
  const schedule = (
    await db.execute<{
      id: string;
      sequence: number;
      revision: number;
      due_on: string;
      period_end: string;
      payment: string;
      interest: string;
      amortization: string | null;
      single_cost: string | null;
      payment_posted: boolean;
      accrual_posted: boolean;
      superseded: boolean;
    }>(sql`
    select id,sequence,revision,due_on::text,period_end::text,payment::text,interest::text,amortization::text,single_cost::text,
      payment_posted_at is not null as payment_posted,accrual_posted_at is not null as accrual_posted,
      superseded_by_change_id is not null as superseded
    from lease_agreement_schedule_lines where org_id=${orgId} and lease_id=${id} order by sequence`)
  ).rows;
  const changes = (
    await db.execute<{
      id: string;
      operation: string;
      effective_on: string;
      reason: string;
      status: string;
    }>(sql`
    select id,operation,effective_on::text,reason,status from financial_changes
    where org_id=${orgId} and subject_id=${id} and domain='lease' order by created_at desc`)
  ).rows;
  return { lease, schedule, changes };
}
export type LeasePayload = NonNullable<Awaited<ReturnType<typeof loadLease>>>;
