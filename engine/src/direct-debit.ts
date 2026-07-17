import { sql } from "drizzle-orm";
import { db, schema } from "./db.ts";
import { sum } from "./money.ts";
import { cancelPaymentRun, createPaymentDocument, nextNumber, PaymentError, updateDraftPayment, type AllocationInput } from "./payments.ts";

/** Build an inbound collection run from open invoices backed by active mandates. */
export async function createDirectDebitRun(opts: {
  orgId: string;
  createdBy: string;
  paymentBankProfileId: string;
  invoiceDocumentIds: string[];
  scheduledFor?: string | null;
}): Promise<{ id: string; runNumber: string }> {
  if (!opts.invoiceDocumentIds.length) throw new PaymentError("select at least one invoice to collect");
  const profileResult = (await db.execute(sql`
    select p.id, p.bank_account_id, p.subsidiary_id, p.currency, f.rail, f.direction
      from payment_bank_profiles p join payment_formats f on f.id = p.payment_format_id and f.is_active
      join accounts a on a.id = p.bank_account_id and a.org_id = p.org_id and a.type = 'asset_bank' and a.is_active and not a.is_summary
     where p.id = ${opts.paymentBankProfileId} and p.org_id = ${opts.orgId} and p.is_active
  `)) as unknown as { rows: Array<{ id: string; bank_account_id: string; subsidiary_id: string | null; currency: string; rail: string; direction: string }> };
  const profile = profileResult.rows[0];
  if (!profile || profile.direction === "credit" || !["nacha_debit", "sepa_debit", "custom"].includes(profile.rail)) {
    throw new PaymentError("select an active direct-debit bank profile");
  }
  const result = (await db.execute(sql`
    select d.id as document_id, d.party_id, d.currency, d.fx_rate, d.subsidiary_id,
           jl.id as open_line_id, jl.account_id as control_account_id,
           abs(jl.amount) - coalesce(ap.applied, 0) as open_base,
           round((abs(jl.amount) - coalesce(ap.applied, 0)) / d.fx_rate, 4) as open,
           m.id as mandate_id, m.party_bank_account_id
      from documents d join journal_entries je on je.id = d.posted_entry_id and je.status = 'posted'
      join journal_lines jl on jl.entry_id = je.id and jl.is_open_item and jl.amount > 0
      left join lateral (select sum(a.amount) as applied from applications a where a.to_line_id = jl.id and a.unapplied_at is null) ap on true
      join lateral (select pm.id, pm.party_bank_account_id from payment_mandates pm where pm.org_id = d.org_id and pm.party_id = d.party_id and pm.status = 'active' and (pm.valid_from is null or pm.valid_from <= coalesce(${opts.scheduledFor ?? null}::date, current_date)) and (pm.expires_on is null or pm.expires_on >= coalesce(${opts.scheduledFor ?? null}::date, current_date)) order by pm.signed_on desc nulls last, pm.created_at desc limit 1) m on true
     where d.id in ${opts.invoiceDocumentIds} and d.org_id = ${opts.orgId} and d.kind = 'customer_invoice' and d.status = 'posted'
       and d.currency = ${profile.currency} and (${profile.subsidiary_id}::uuid is null or d.subsidiary_id = ${profile.subsidiary_id})
       and abs(jl.amount) - coalesce(ap.applied, 0) > 0
  `)) as unknown as { rows: Array<{ document_id: string; party_id: string; currency: string; fx_rate: string; subsidiary_id: string | null; open_line_id: string; control_account_id: string; open_base: string; open: string; mandate_id: string; party_bank_account_id: string }> };
  const found = new Set(result.rows.map((r) => r.document_id));
  if (opts.invoiceDocumentIds.some((id) => !found.has(id))) throw new PaymentError("some invoices are closed, outside the profile scope, or have no active debit mandate");
  const groups = new Map<string, typeof result.rows>();
  for (const row of result.rows) {
    const key = `${row.party_id}:${row.subsidiary_id ?? ""}:${row.control_account_id}:${row.fx_rate}:${row.mandate_id}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const runNumber = await nextNumber(opts.orgId, "payment_run", "COLL-");
  const [run] = await db.insert(schema.paymentRuns).values({ orgId: opts.orgId, runNumber, bankAccountId: profile.bank_account_id, paymentBankProfileId: profile.id, subsidiaryId: profile.subsidiary_id, method: "direct_debit", direction: "inbound", purpose: "customer_collections", currency: profile.currency, status: "draft", scheduledFor: opts.scheduledFor ?? null, createdBy: opts.createdBy }).returning({ id: schema.paymentRuns.id, runNumber: schema.paymentRuns.runNumber });
  const createdReceiptIds: string[] = [];
  try {
    for (const invoices of groups.values()) {
      const first = invoices[0]!;
      const allocations: AllocationInput[] = invoices.map((i) => ({ openLineId: i.open_line_id, amount: i.open, baseAmount: i.open_base }));
      const total = sum(allocations.map((a) => a.amount));
      const receipt = await createPaymentDocument({ orgId: opts.orgId, kind: "customer_payment", createdBy: opts.createdBy, partyId: first.party_id, bankAccountId: profile.bank_account_id, subsidiaryId: first.subsidiary_id, currency: profile.currency, fxRate: first.fx_rate, memo: `Collection run ${runNumber}` });
      createdReceiptIds.push(receipt.id);
      await updateDraftPayment(receipt.id, { partyId: first.party_id, bankAccountId: profile.bank_account_id, allocations, controlAccountId: first.control_account_id }, opts.createdBy);
      const [instruction] = await db.insert(schema.paymentInstructions).values({ orgId: opts.orgId, paymentRunId: run.id, payeePartyId: first.party_id, payeeBankAccountId: first.party_bank_account_id, mandateId: first.mandate_id, amount: total, currency: profile.currency, paymentDocumentId: receipt.id, status: "pending", createdBy: opts.createdBy }).returning({ id: schema.paymentInstructions.id });
      await db.insert(schema.paymentRunItems).values(invoices.map((i) => ({ orgId: opts.orgId, paymentRunId: run.id, paymentInstructionId: instruction.id, sourceDocumentId: i.document_id, sourceOpenLineId: i.open_line_id, kind: "receivable" as const, grossAmount: i.open, discountAmount: "0", creditAmount: "0", paymentAmount: i.open, currency: i.currency, fxRate: i.fx_rate, status: "selected" as const, createdBy: opts.createdBy })));
    }
    await db.execute(sql`update payment_runs r set payment_count = x.n, total_amount = x.total, updated_at = now(), updated_by = ${opts.createdBy} from (select payment_run_id, count(*)::int as n, coalesce(sum(amount), 0) as total from payment_instructions where payment_run_id = ${run.id} group by payment_run_id) x where r.id = x.payment_run_id`);
    await db.insert(schema.paymentEvents).values({ orgId: opts.orgId, paymentRunId: run.id, eventType: "run_created", toStatus: "draft", details: { paymentBankProfileId: profile.id, sourceCount: result.rows.length, direction: "inbound" }, actorId: opts.createdBy });
  } catch (error) {
    await cancelPaymentRun(run.id, opts.orgId);
    if (createdReceiptIds.length > 0) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`delete from document_lines dl using documents d where dl.document_id = d.id and d.id in ${createdReceiptIds} and d.org_id = ${opts.orgId} and d.status = 'draft'`);
        await tx.execute(sql`delete from documents where id in ${createdReceiptIds} and org_id = ${opts.orgId} and status = 'draft'`);
      });
    }
    await db.insert(schema.paymentEvents).values({ orgId: opts.orgId, paymentRunId: run.id, eventType: "run_creation_failed", fromStatus: "draft", toStatus: "cancelled", details: { error: error instanceof Error ? error.message : String(error), direction: "inbound" }, actorId: opts.createdBy });
    throw error;
  }
  return run;
}
