import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext } from "./db.ts";
import {
  nachaOriginator,
  recordPaymentSettlement,
  sepaOriginator,
} from "./payment-operations.ts";
import {
  createPaymentDocument,
  PaymentError,
  postPaymentWithApplications,
  sameCurrencyAllocation,
  updateDraftPayment,
} from "./payments.ts";
import { postDocument } from "./posting.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "./test-fixtures.ts";

const paymentOperationsSource = readFileSync(new URL("./payment-operations.ts", import.meta.url), "utf8");
const DB = Boolean(process.env.OPENBOOKS_DB_URL);

function postgresFailure(error: unknown): { code?: string; constraint?: string } | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: string; constraint?: string; cause?: unknown };
    if (candidate.code) return candidate;
    current = candidate.cause;
  }
  return null;
}

test("settlement upserts pin the known tenant on the payment_instruction_id conflict write", () => {
  assert.match(
    paymentOperationsSource,
    /insert into payment_settlements[\s\S]*?on conflict \(payment_instruction_id\) do update set[\s\S]*?where payment_settlements\.org_id = \$\{opts\.orgId\}/,
  );
});

test(
  "a failed bank-return settlement rolls its payment reversal back atomically",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const actorId = await withBypass(() =>
        createScratchUser(org.orgId, "Settlement operator", "admin"),
      );
      const seeded = await withOrgContext(org.orgId, async () => {
        const invoiceId = randomUUID();
        await db.execute(sql`
          insert into documents
            (id, org_id, kind, status, document_number, subsidiary_id, party_id,
             document_date, currency, subtotal, tax_total, total, created_by)
          values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'approved',
                  ${`INV-RETURN-${invoiceId}`}, ${org.subsidiaryId}, ${org.customerId},
                  ${org.date}, 'CAD', '100', '0', '100', ${actorId})
        `);
        await db.execute(sql`
          insert into document_lines
            (org_id, document_id, line_number, account_id, quantity, unit_price,
             amount, tax_amount, tax_input_amount)
          values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1',
                  '100', '100', '0', '100')
        `);
        const invoiceEntryId = await postDocument(invoiceId, {
          control: {
            ar: org.accounts.ar,
            ap: org.accounts.ap,
            bank: org.accounts.bank,
          },
        });
        const invoiceControl = await db.execute<{ id: string }>(sql`
          select id
            from journal_lines
           where entry_id = ${invoiceEntryId} and account_id = ${org.accounts.ar}
        `);

        const payment = await createPaymentDocument({
          orgId: org.orgId,
          kind: "customer_payment",
          createdBy: actorId,
          partyId: org.customerId,
          bankAccountId: org.accounts.bank,
          subsidiaryId: org.subsidiaryId,
          documentDate: org.date,
          currency: "CAD",
        });
        await updateDraftPayment(
          payment.id,
          {
            allocations: [sameCurrencyAllocation(invoiceControl.rows[0]!.id, "100")],
            bankAccountId: org.accounts.bank,
          },
          actorId,
          org.orgId,
        );
        await db.execute(sql`
          update documents
             set status = 'approved', submitted_by = ${actorId}, submitted_at = now()
           where id = ${payment.id} and org_id = ${org.orgId}
        `);
        const paymentPosting = await postPaymentWithApplications(
          payment.id,
          undefined,
          actorId,
          "ui",
          { deferEffects: true },
        );

        const runId = randomUUID();
        const instructionId = randomUUID();
        await db.execute(sql`
          insert into payment_runs
            (id, org_id, run_number, bank_account_id, subsidiary_id, method,
             direction, purpose, currency, status, payment_count, total_amount,
             created_by, updated_by)
          values (${runId}, ${org.orgId}, ${`RETURN-${runId}`},
                  ${org.accounts.bank}, ${org.subsidiaryId}, 'direct_debit',
                  'inbound', 'customer_collections', 'CAD', 'confirmed', 1,
                  '100', ${actorId}, ${actorId})
        `);
        await db.execute(sql`
          insert into payment_instructions
            (id, org_id, payment_run_id, payee_party_id, amount, currency,
             payment_document_id, status, created_by, updated_by)
          values (${instructionId}, ${org.orgId}, ${runId}, ${org.customerId},
                  '100', 'CAD', ${payment.id}, 'sent', ${actorId}, ${actorId})
        `);
        return {
          instructionId,
          paymentDocumentId: payment.id,
          paymentEntryId: paymentPosting.entryId,
          runId,
        };
      });

      // This missing bank-statement line is first referenced by the settlement
      // insert, after reversePaymentForReturn has voided the document and
      // created its correcting journal entry inside the same transaction.
      await assert.rejects(
        () =>
          recordPaymentSettlement({
            instructionId: seeded.instructionId,
            orgId: org.orgId,
            userId: actorId,
            status: "returned",
            effectiveOn: org.date,
            bankStatementLineId: randomUUID(),
            returnCode: "NSF",
            returnReason: "Insufficient funds",
          }),
        (error: unknown) => {
          const failure = postgresFailure(error);
          assert.equal(failure?.code, "23503");
          assert.equal(
            failure?.constraint,
            "payment_settlements_bank_statement_line_id_fkey",
          );
          return true;
        },
      );

      const state = await withOrgContext(org.orgId, async () =>
        db.execute<{
          document_status: string;
          document_reversal_entry_id: string | null;
          void_requested: boolean;
          payment_entry_status: string;
          reversal_entries: number;
          live_applications: number;
          unapplied_applications: number;
          instruction_status: string;
          settlements: number;
          run_status: string;
          events: number;
        }>(sql`
          select
            (select status from documents where id = ${seeded.paymentDocumentId}) as document_status,
            (select reversal_entry_id from documents where id = ${seeded.paymentDocumentId}) as document_reversal_entry_id,
            (select void_requested_at is not null from documents where id = ${seeded.paymentDocumentId}) as void_requested,
            (select status from journal_entries where id = ${seeded.paymentEntryId}) as payment_entry_status,
            (select count(*)::int from journal_entries where reverses_entry_id = ${seeded.paymentEntryId}) as reversal_entries,
            (select count(*)::int
               from applications
              where org_id = ${org.orgId}
                and from_line_id in (
                  select id from journal_lines where entry_id = ${seeded.paymentEntryId}
                )
                and unapplied_at is null) as live_applications,
            (select count(*)::int
               from applications
              where org_id = ${org.orgId}
                and from_line_id in (
                  select id from journal_lines where entry_id = ${seeded.paymentEntryId}
                )
                and unapplied_at is not null) as unapplied_applications,
            (select status from payment_instructions where id = ${seeded.instructionId}) as instruction_status,
            (select count(*)::int from payment_settlements where payment_instruction_id = ${seeded.instructionId}) as settlements,
            (select status from payment_runs where id = ${seeded.runId}) as run_status,
            (select count(*)::int from payment_events where payment_instruction_id = ${seeded.instructionId}) as events
        `),
      );
      assert.deepEqual(state.rows[0], {
        document_status: "posted",
        document_reversal_entry_id: null,
        void_requested: false,
        payment_entry_status: "posted",
        reversal_entries: 0,
        live_applications: 1,
        unapplied_applications: 0,
        instruction_status: "sent",
        settlements: 0,
        run_status: "confirmed",
        events: 0,
      });
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test("built-in payment format upserts pin the known tenant on the org_id/code conflict write", () => {
  assert.match(
    paymentOperationsSource,
    /insert into payment_formats[\s\S]*?on conflict \(org_id, code\) do update set[\s\S]*?where payment_formats\.org_id = \$\{orgId\}/,
  );
});

/**
 * A debit profile's originator settings arrive as decrypted tenant JSON, so the
 * debit rails have to hold the same line the credit rails hold in
 * `validateNachaSettings`: nothing is a string until it is shown to be one, an
 * unfinished profile is a named refusal, and the ODFI routing is exactly nine
 * digits before the writer slices it to eight.
 */

const NACHA_ORIGINATOR = {
  odfiRouting: "021000021",
  immediateDestination: " 021000021",
  immediateOrigin: "1234567890",
  destinationName: "BANK OF EXAMPLE",
  originName: "EXAMPLE CONSTRUCTION",
  companyName: "EXAMPLE CONST",
  companyId: "1123456789",
};

test("a complete NACHA debit originator parses, trimmed, with the corporate SEC default", () => {
  const settings = nachaOriginator({ ...NACHA_ORIGINATOR, companyName: "  EXAMPLE CONST  " });
  assert.equal(settings.odfiRouting, "021000021");
  assert.equal(settings.companyName, "EXAMPLE CONST");
  assert.equal(settings.entryClassCode, undefined);
  assert.equal(settings.entryDescription, undefined);
});

test("an unfinished NACHA debit profile is named, never written into a file", () => {
  assert.throws(
    () => nachaOriginator({ ...NACHA_ORIGINATOR, companyId: "FILL-ME" }),
    (error: Error) => error instanceof PaymentError && error.message.includes("companyId"),
  );
});

test("a NACHA debit field that is not a string counts as missing rather than stringifying", () => {
  assert.throws(
    () => nachaOriginator({ ...NACHA_ORIGINATOR, originName: { toString: () => "EXAMPLE" } }),
    (error: Error) => error instanceof PaymentError && error.message.includes("originName"),
  );
});

test("an over-long odfiRouting is refused rather than truncated to the wrong institution", () => {
  // The writer slices odfiRouting to 8 characters for the batch and file
  // trailers, so 13 digits would still produce a well-formed 94-character file
  // — addressed to an originating bank the tenant never named.
  assert.throws(
    () => nachaOriginator({ ...NACHA_ORIGINATOR, odfiRouting: "0210000219999" }),
    (error: Error) => error instanceof PaymentError && error.message.includes("9-digit"),
  );
  assert.throws(
    () => nachaOriginator({ ...NACHA_ORIGINATOR, odfiRouting: "02100" }),
    (error: Error) => error instanceof PaymentError && error.message.includes("9-digit"),
  );
});

test("an unrecognised SEC code falls back to CCD instead of reaching the 3-character field", () => {
  assert.equal(nachaOriginator({ ...NACHA_ORIGINATOR, entryClassCode: "WEB" }).entryClassCode, undefined);
  assert.equal(nachaOriginator({ ...NACHA_ORIGINATOR, entryClassCode: "PPD" }).entryClassCode, "PPD");
});

const SEPA_ORIGINATOR = {
  originatorName: "EXAMPLE CONSTRUCTION",
  originatorIban: "DE89370400440532013000",
  originatorBic: "COBADEFFXXX",
  creditorId: "DE98ZZZ09999999999",
};

test("a complete SEPA debit originator parses, trimmed", () => {
  const settings = sepaOriginator({ ...SEPA_ORIGINATOR, originatorBic: " COBADEFFXXX " });
  assert.equal(settings.originatorBic, "COBADEFFXXX");
  assert.equal(settings.creditorId, "DE98ZZZ09999999999");
});

test("an unfinished SEPA debit profile is named, never collected against", () => {
  assert.throws(
    () => sepaOriginator({ ...SEPA_ORIGINATOR, creditorId: "FILL-ME" }),
    (error: Error) => error instanceof PaymentError && error.message.includes("creditorId"),
  );
  assert.throws(
    () => sepaOriginator({ ...SEPA_ORIGINATOR, originatorIban: "   " }),
    (error: Error) => error instanceof PaymentError && error.message.includes("originatorIban"),
  );
});
