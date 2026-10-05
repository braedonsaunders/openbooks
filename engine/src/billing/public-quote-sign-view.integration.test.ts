import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgContext } from "../platform/db.ts";
import {
  declineQuoteSignature,
  publicQuoteSignView,
  QUOTE_SUBJECT_TABLE,
  requestQuoteSignature,
  signQuoteSignature,
  voidSignatureRequestsForSubject,
} from "./quote-to-cash.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * The hosted signing page's view carries the quoted terms and the open
 * signature request: the customer signs exactly what the sender priced.
 * The typed name is durably observable: signing and declining record the
 * typed name, the tendered consent and the hashed terms in the audit trail
 * while the invited identity stays untouched on the request row — proven
 * below with typed names that differ from the invited name. Tenant work
 * runs inside the org context with a real actor; only fixture
 * create/drop use the privileged path.
 */
test("public signing view renders terms and records typed names", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Signing page prover", "admin");
    async function seedQuote(docNumber: string): Promise<{ quoteId: string; token: string }> {
      return withOrgContext(org.orgId, async () => {
        await db.execute(sql`
          update orgs
             set settings = settings || '{"features":{"quoteToCash":true,"subscriptionBilling":true,"advancedSubscriptions":true,"orders":true}}'::jsonb
           where id = ${org.orgId}
        `);
        const planId = randomUUID();
        await db.execute(sql`
          insert into subscription_plans
            (id, org_id, name, amount, currency_code, interval, interval_count,
             income_account_id, is_active, created_by)
          values (${planId}, ${org.orgId}, 'Quoted plan', '100.0000', 'USD', 'monthly', 1,
                  ${org.accounts.revenue}, true, ${actor})
        `);
        const quoteId = randomUUID();
        await db.execute(sql`
          insert into documents
            (id, org_id, kind, status, document_number, party_id, document_date,
             currency, subtotal, tax_total, total, created_by)
          values (${quoteId}, ${org.orgId}, 'quote', 'draft', ${docNumber}, ${org.customerId}, ${org.date},
                  'USD', '1200.0000', '0', '1200.0000', ${actor})
        `);
        const lineId = randomUUID();
        await db.execute(sql`
          insert into document_lines
            (id, org_id, document_id, line_number, description, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
          values (${lineId}, ${org.orgId}, ${quoteId}, 1, 'Annual subscription', ${org.accounts.revenue},
                  '1', '1200.0000', '1200.0000', '0', '1200.0000')
        `);
        const termId = randomUUID();
        await db.execute(sql`
          insert into quote_subscription_terms
            (id, org_id, quote_id, quote_line_id, plan_id, term_months, start_rule, billing_timing, created_by)
          values (${termId}, ${org.orgId}, ${quoteId}, ${lineId}, ${planId}, 12, 'quote_date', 'advance', ${actor})
        `);
        await db.execute(sql`
          insert into quote_ramp_steps
            (id, org_id, term_id, period_index, starts_after_months, unit_price, quantity, created_by)
          values (${randomUUID()}, ${org.orgId}, ${termId}, 0, 0, '100.00', '1', ${actor})
        `);
        const sent = await requestQuoteSignature({
          orgId: org.orgId,
          actorId: actor,
          quoteId,
          signerName: "Ada Customer",
          signerEmail: "ada@example.com",
        });
        return { quoteId, token: sent.token };
      });
    }
    async function auditAfter(requestId: string): Promise<{ status?: string; signedName?: string; declinedName?: string; consentText?: string; documentHash?: string }> {
      const row = (await db.execute<{ changes: { after: Record<string, string | undefined> } }>(sql`
        select changes from audit_log
         where org_id = ${org.orgId} and table_name = 'signature_requests' and row_id = ${requestId}
         order by at desc limit 1`)).rows[0];
      const after = row?.changes.after ?? {};
      return { status: after.status, signedName: after.signedName, declinedName: after.declinedName, consentText: after.consentText, documentHash: after.documentHash };
    }

    // Terms render off the same preview the drawer shows.
    const deal = await seedQuote("Q-SIGN-1");
    const full = await publicQuoteSignView(deal.token);
    assert.equal(full.quoteNumber, "Q-SIGN-1");
    assert.equal(full.currency, "USD");
    assert.equal(full.terms.length, 1);
    assert.equal(full.terms[0]!.planName, "Quoted plan");
    assert.equal(full.terms[0]!.termMonths, 12);
    assert.equal(full.tcv, "1200.0000");
    assert.equal(full.signature?.signerName, "Ada Customer");
    assert.equal(full.signature?.signerEmail, "ada@example.com");
    assert.ok((full.signature?.consentText ?? "").length > 32);

    // The typed name differs from the invited name: the audit trail carries
    // the typed signature while the row keeps the invite identity.
    const signed = await signQuoteSignature({ token: deal.token, name: "Ada C. Signer", ip: "10.0.0.9" });
    const signedAudit = await withOrgContext(org.orgId, async () => auditAfter(signed.requestId));
    assert.ok(signedAudit.status === "signed");
    assert.ok(signedAudit.signedName === "Ada C. Signer");
    assert.ok((signedAudit.consentText ?? "").length > 32);
    assert.ok((signedAudit.documentHash ?? "").length > 16);
    const signedRow = (await db.execute<{ status: string; signer_name: string }>(sql`
      select status, signer_name from signature_requests where id = ${signed.requestId}`)).rows[0];
    assert.equal(signedRow?.status, "signed");
    assert.equal(signedRow?.signer_name, "Ada Customer");

    // Declining records the decliner the same way, without inventing a
    // sender notice the code never enqueues.
    const refused = await seedQuote("Q-SIGN-2");
    const declined = await declineQuoteSignature({ token: refused.token, name: "Bob D. Decliner" });
    const declinedAudit = await withOrgContext(org.orgId, async () => auditAfter(declined.requestId));
    assert.ok(declinedAudit.status === "declined");
    assert.ok(declinedAudit.declinedName === "Bob D. Decliner");
    const declinedRow = (await db.execute<{ status: string; signer_name: string }>(sql`
      select status, signer_name from signature_requests where id = ${declined.requestId}`)).rows[0];
    assert.equal(declinedRow?.status, "declined");
    assert.equal(declinedRow?.signer_name, "Ada Customer");

    // A voided link still resolves its state so the page can name the
    // remedy — and signing it refuses by name.
    const stale = await seedQuote("Q-SIGN-3");
    await withOrgContext(org.orgId, async () => {
      const { voided } = await voidSignatureRequestsForSubject(db, org.orgId, QUOTE_SUBJECT_TABLE, stale.quoteId);
      assert.equal(voided, 1);
    });
    const voidedView = await publicQuoteSignView(stale.token);
    assert.equal(voidedView.signature?.status, "voided");
    await assert.rejects(signQuoteSignature({ token: stale.token, name: "Ada C. Signer" }), /voided/);
    await assert.rejects(publicQuoteSignView("not-a-token"), /invalid or expired/);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
