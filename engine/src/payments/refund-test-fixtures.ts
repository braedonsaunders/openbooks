import { decideGate } from "../flows/gates.ts";
import assert from "node:assert/strict";
import { utcDateFromParts } from "../platform/civil-date.ts";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { sealJson, sealSecret } from "../platform/secrets.ts";
import { handleProviderWebhook } from "./acceptance.ts";
import { postDocument } from "../ledger/posting-document.ts";
import {
  createScratchOrg,
  createScratchUser,
  grantScratchPermissions,
  seedApprovalFlow,
} from "../testing/fixtures.ts";

function signedStripeBody(
  secret: string,
  event: unknown,
): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex");
  return { body, headers: { "stripe-signature": `t=${t},v1=${v1}` } };
}

export async function ensureOpenPeriod(orgId: string, periodId: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const [year, month] = today.split("-").map(Number) as [number, number, number];
  await db.execute(sql`
    insert into accounting_periods
      (org_id, fiscal_calendar_id, fiscal_year, period_number, name,
       starts_on, ends_on, is_adjustment)
    select ${orgId}, fiscal_calendar_id, ${year}, ${month}, ${today.slice(0, 7)},
           ${`${year}-${String(month).padStart(2, "0")}-01`},
           ${utcDateFromParts(year, month, 0).toISOString().slice(0, 10)}, false
      from accounting_periods
     where id = ${periodId}
    -- A repeated fixture retains the existing month in the same fiscal calendar.
    on conflict (org_id, fiscal_calendar_id, fiscal_year, period_number) do nothing
  `);
}

export async function makeAccount(
  orgId: string,
  number: string,
  name: string,
  type: string,
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${id}, ${orgId}, ${number}, ${name}, ${type}, false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
  return id;
}

export type Harness = {
  orgId: string;
  userId: string;
  invoiceId: string;
  linkToken: string;
  intentId: string;
  sessionId: string;
  attemptId: string;
  secret: string;
  fire: (event: unknown) => ReturnType<typeof handleProviderWebhook>;
};

export async function settleHarness(
  org: Awaited<ReturnType<typeof createScratchOrg>>,
  opts: {
    invoiceTotal?: string;
    invoiceFxRate?: string;
    currency?: string;
    reviewFlow?: boolean;
    disputeAccounts?: boolean;
  } = {},
): Promise<Harness> {
  const { installEngineSeams } = await import("../composition/install.ts");
  installEngineSeams();
  const total = opts.invoiceTotal ?? "100";
  const currency = opts.currency ?? "CAD";
  const userId = await createScratchUser(org.orgId, "Refund Tester", "admin");
  await grantScratchPermissions(org.orgId, userId, ["banking.reconcile", "ar.pay"]);
  await db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"onlinePayments":true,"banking":true,"flows":true}'::jsonb) where id = ${org.orgId}`);
  await ensureOpenPeriod(org.orgId, org.periodId);

  const invoiceId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id,
       document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', ${`INV-${randomUUID().slice(0, 8)}`},
            ${org.subsidiaryId}, ${org.customerId}, ${org.date}, ${currency}, ${opts.invoiceFxRate ?? "1"},
            ${total}, '0', ${total}, ${userId})`);
  await db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
    values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', ${total}, ${total}, '0', '0')`);
  await db.execute(
    sql`update documents set status = 'approved', updated_at = now() where id = ${invoiceId} and org_id = ${org.orgId}`,
  );
  await postDocument(invoiceId, {
    control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
  });

  const secret = `whsec_auto_${randomUUID()}`;
  await db.execute(sql`
    insert into psp_provider_configs
      (org_id, provider, display_name, is_enabled, acceptance_enabled,
       default_bank_account_id, secrets, created_by, updated_by)
    values (${org.orgId}, 'stripe', 'Stripe', true, true,
            ${org.accounts.bank}, ${sealJson({ apiKey: "sk_test_auto", webhookSecret: secret }, { orgId: org.orgId, purpose: "payment.provider.secrets" })}, ${userId}, ${userId})`);
  if (opts.reviewFlow) await seedProviderReviewFlow(org.orgId, userId);
  if (opts.disputeAccounts) {
    const disputedFunds = await makeAccount(
      org.orgId,
      "1150",
      "Disputed Funds Clearing",
      "asset_current_other",
    );
    const loss = await makeAccount(org.orgId, "7020", "Chargeback Losses", "expense");
    const fee = await makeAccount(org.orgId, "7030", "Dispute Fees", "expense");
    await db.execute(sql`
      update psp_provider_configs
         set default_disputed_funds_account_id = ${disputedFunds},
             default_chargeback_loss_account_id = ${loss},
             default_dispute_fee_account_id = ${fee}
       where org_id = ${org.orgId} and provider = 'stripe'`);
  }
  const linkId = randomUUID(),
    linkToken = `auto-link-${randomUUID()}`;
  const sessionId = `cs_test_auto_${randomUUID().slice(0, 8)}`;
  const intentId = `pi_auto_${randomUUID().slice(0, 8)}`;
  await db.execute(sql`
    insert into payment_links
      (id, org_id, token_hash, token_sealed, document_id, party_id, subsidiary_id, provider,
       bank_account_id, amount, surcharge_amount, currency, created_by, updated_by)
    values (${linkId}, ${org.orgId}, ${createHash("sha256").update(linkToken, "utf8").digest("hex")}, ${sealSecret(linkToken, { orgId: org.orgId, purpose: "payment.link.token" })}, ${invoiceId}, ${org.customerId},
            ${org.subsidiaryId}, 'stripe', ${org.accounts.bank}, ${total}, '0', ${currency},
            ${userId}, ${userId})`);
  const attemptId = randomUUID();
  await db.execute(sql`
    insert into payment_attempts (id, org_id, link_id, provider, external_ref, status, amount, surcharge_amount)
    values (${attemptId}, ${org.orgId}, ${linkId}, 'stripe', ${sessionId}, 'initiated', ${total}, '0')`);
  const fire = (event: unknown) => {
    const signed = signedStripeBody(secret, event);
    return handleProviderWebhook("stripe", signed.headers, signed.body);
  };
  return {
    orgId: org.orgId,
    userId,
    invoiceId,
    linkToken,
    intentId,
    sessionId,
    attemptId,
    secret,
    fire,
  };
}

export async function settle(h: Harness, minor: number, currency = "cad"): Promise<void> {
  const event = {
    id: `evt_settle_${randomUUID().slice(0, 8)}`,
    type: "checkout.session.completed",
    data: {
      object: {
        id: h.sessionId,
        client_reference_id: h.linkToken,
        payment_intent: h.intentId,
        amount_total: minor,
        currency,
        payment_status: "paid",
      },
    },
  };
  const outcome = await h.fire(event);
  assert.equal(outcome?.status, "settled");
}

export async function invoiceOpen(orgId: string, invoiceId: string): Promise<string> {
  const row = (
    await db.execute<{ open_balance: string }>(
      sql`
    select open_balance::text from documents where id = ${invoiceId} and org_id = ${orgId}`,
      "objects",
    )
  )[0];
  return row!.open_balance;
}

export async function disputeRows(
  orgId: string,
): Promise<{ id: string; kind: string; status: string; documents_posted: unknown }[]> {
  return await db.execute<{ id: string; kind: string; status: string; documents_posted: unknown }>(
    sql`
    select id, kind, status, documents_posted from payment_disputes where org_id = ${orgId} order by created_at`,
    "objects",
  );
}

/** The tenant explicitly permits this fixture operator to review its own submitted return. */
export async function seedProviderReviewFlow(orgId: string, actorId: string) {
  return seedApprovalFlow(orgId, {
    subjectKind: "payment_dispute_review",
    assignees: [{ type: "user", userId: actorId }],
    mode: "all",
    preventSelfApproval: false,
  });
}

/** Drive the same gate decision as the native review drawer and read its financial result. */
export async function decideProviderReview(
  orgId: string,
  id: string,
  actorId: string,
  decision: "approved" | "rejected",
  comment?: string,
) {
  const gates = await db.execute<{ id: string }>(
    sql`select id from flow_gates where org_id=${orgId}
    and subject_kind='payment_dispute_review' and subject_id=${id} and status='pending'`,
    "objects",
  );
  assert.equal(gates.length, 1, "the declared return review policy must create one native gate");
  await decideGate({ gateId: gates[0]!.id, userId: actorId, decision, comment });
  const row = (
    await db.execute<{ status: string }>(
      sql`select status from payment_disputes where org_id=${orgId} and id=${id}`,
      "objects",
    )
  )[0];
  assert.ok(row, "native return decisions must remain visible");
  return row;
}
