import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { createDirectDebitRun } from "./direct-debit.ts";
import { generatePaymentFileArtifact, submitPaymentRun } from "./operations.ts";
import { paymentRunReadiness } from "./run-readiness.ts";
import { encryptAccountNumber } from "./rail-settings.ts";
import { sealJson } from "../platform/secrets.ts";
import { db, withBypass, withOrgContext } from "../platform/db.ts";
import { postDocument } from "../ledger/posting-document.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
} from "../testing/fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

// ---------------------------------------------------------------------------
// SEPA direct-debit export must fail closed on bank evidence.
//
// Baseline defect: `generatePaymentFileArtifact` for rail `sepa_debit` renders
// from `loadFormatContext`, whose party_bank_accounts LEFT JOIN silently NULLs
// unapproved/inactive rows while debtor IBANs are never checksum-checked, so
// generation STORES a pain.008 carrying an empty/invalid <IBAN> and flips the
// run to `generated` while `paymentRunReadiness` stays green.
// ---------------------------------------------------------------------------

const ORIGINATOR_SECRETS = {
  originatorName: "Originator Co",
  originatorIban: "NL91ABNA0417164300",
  originatorBic: "ABNANL2AXXX",
  creditorId: "DE98ZZZ09999999999",
};

/** Regex-valid but mod-97-invalid: the single-digit typo the baseline stored. */
const TYPO_IBAN = "DE89370400440532013001";
const VALID_IBAN = "DE89370400440532013000";
const VALID_BIC = "COBADEFFXXX";

interface DebitFixture {
  actorId: string;
  runId: string;
  instructionId: string;
  accountId: string;
}

async function seedSepaDebitRun(
  org: Awaited<ReturnType<typeof createScratchOrg>>,
  bank: {
    routing: Record<string, string>;
    account: string | null;
    approved: boolean;
    active: boolean;
  },
): Promise<DebitFixture> {
  // Phase 1 (committed before phase 2): the run builder opens its own
  // transaction on a separate connection, so the profile, mandate, and posted
  // invoice must be committed — never siblings in one uncommitted seed tx.
  const seeded = await withBypass(async () => {
    const actorId = await createScratchUser(org.orgId, "Collection Operator", "accountant");
    const formatId = randomUUID();
    const profileId = randomUUID();
    const accountId = randomUUID();
    const mandateId = randomUUID();
    const invoiceId = randomUUID();

    await db.execute(sql`
      insert into payment_formats
        (id, org_id, code, name, rail, direction, country, currency, created_by, updated_by)
      values
        (${formatId}, ${org.orgId}, ${`SEPA-DD-BE-${formatId.slice(0, 8)}`}, 'SEPA debit bank evidence',
         'sepa_debit', 'debit', 'DE', 'EUR', ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into payment_bank_profiles
        (id, org_id, name, bank_account_id, subsidiary_id, payment_format_id,
         currency, country, originator_secrets_encrypted,
         require_run_approval, require_file_approval, is_active, created_by, updated_by)
      values
        (${profileId}, ${org.orgId}, 'SEPA collection profile', ${org.accounts.bank},
         ${org.subsidiaryId}, ${formatId}, 'CAD', 'DE', ${sealJson(ORIGINATOR_SECRETS)},
         false, false, true, ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into party_bank_accounts
        (id, org_id, party_id, bank_name, country, currency, routing,
         account_number_encrypted, account_last_four,
         approval_status, is_active, approved_at, approved_by,
         created_by, updated_by)
      values
        (${accountId}, ${org.orgId}, ${org.customerId}, 'Customer bank',
         'DE', 'CAD', ${JSON.stringify(bank.routing)}::jsonb,
         ${bank.account === null ? null : encryptAccountNumber(bank.account)},
         ${bank.account === null ? null : bank.account.slice(-4)},
         ${bank.approved ? "approved" : "pending"}, ${bank.active},
         ${bank.approved ? org.date : null}, ${bank.approved ? actorId : null},
         ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into payment_mandates
        (id, org_id, party_id, party_bank_account_id, scheme, mandate_reference,
         status, signed_on, valid_from, created_by, updated_by)
      values
        (${mandateId}, ${org.orgId}, ${org.customerId}, ${accountId},
         'sepa', 'MANDATE-SEPA-DEBIT', 'active', ${org.date}, ${org.date},
         ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values
        (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', ${`INV-SEPA-${invoiceId.slice(0, 8)}`},
         ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'CAD', '1',
         '100', '0', '100', ${actorId})`);
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price,
         amount, tax_amount, tax_input_amount)
      values
        (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', '100',
         '100', '0', '100')`);
    await db.execute(sql`
      update documents set status = 'approved', updated_at = now()
       where id = ${invoiceId} and org_id = ${org.orgId}`);
    await postDocument(invoiceId, {
      control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
    });

    return { actorId, profileId, accountId, invoiceId };
  });

  // Phase 2: build and approve the collection run against committed fixtures.
  const run = await withOrgContext(org.orgId, () =>
    createDirectDebitRun({
      orgId: org.orgId,
      createdBy: seeded.actorId,
      paymentBankProfileId: seeded.profileId,
      invoiceDocumentIds: [seeded.invoiceId],
      scheduledFor: org.date,
    }),
  );
  // No run approval required: submission moves the run straight to approved,
  // the only state the exporter accepts.
  await submitPaymentRun(run.id, org.orgId, seeded.actorId);

  const instructionId = (
    await withBypass(() =>
      db.execute<{ id: string }>(sql`
        select id from payment_instructions
         where payment_run_id = ${run.id} and org_id = ${org.orgId}`),
    )
  ).rows[0]!.id;
  return { actorId: seeded.actorId, runId: run.id, instructionId, accountId: seeded.accountId };
}

async function runState(orgId: string, runId: string) {
  return (
    await withBypass(() =>
      db.execute<{ status: string; files: number; events: number; exportedFileRef: string | null }>(sql`
        select r.status,
               (select count(*)::int from payment_files f
                 where f.payment_run_id = r.id and f.org_id = r.org_id) as files,
               (select count(*)::int from payment_events e
                 where e.payment_run_id = r.id and e.org_id = r.org_id) as events,
               r.exported_file_ref as "exportedFileRef"
          from payment_runs r where r.id = ${runId} and r.org_id = ${orgId}`),
    )
  ).rows[0]!;
}

/**
 * This suite's own artifact rows must be cleared before the generic teardown
 * reaches them in FK-hostile order (same contract as bank-evidence suite).
 */
async function dropScratchOrgWithPaymentArtifacts(orgId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      select set_config('openbooks.amend', 'on', true),
             set_config('openbooks.sandbox_wipe', 'on', true),
             set_config('app.bypass_rls', 'on', true)`);
    await tx.execute(sql`update orgs set env_kind = 'sandbox' where id = ${orgId} and name like 'Scratch %'`);
    await tx.execute(sql`delete from payment_file_deliveries where org_id = ${orgId}`);
    await tx.execute(sql`delete from payment_events where org_id = ${orgId}`);
    await tx.execute(sql`delete from payment_files where org_id = ${orgId}`);
  });
  await dropScratchOrgReporting(orgId);
}

test("an approved typo-checksum IBAN refuses generation, stores nothing, and blocks readiness", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const fixture = await seedSepaDebitRun(org, {
      routing: { iban: TYPO_IBAN, bic: VALID_BIC },
      account: TYPO_IBAN,
      approved: true,
      active: true,
    });
    const before = await runState(org.orgId, fixture.runId);

    await assert.rejects(
      () => generatePaymentFileArtifact(fixture.runId, org.orgId, fixture.actorId),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /IBAN/i);
        return true;
      },
    );

    const after = await runState(org.orgId, fixture.runId);
    assert.equal(after.files, 0, "refusal must persist zero payment files");
    assert.equal(after.events, before.events, "refusal must write zero payment events");
    assert.equal(after.status, "approved", "refusal must not flip the run to generated");
    assert.equal(after.exportedFileRef, null);

    const readiness = await paymentRunReadiness(fixture.runId, org.orgId);
    const blocker = readiness.blockers.find((b) => b.instructionId === fixture.instructionId);
    assert.ok(blocker, "readiness must flag the checksum-invalid debtor IBAN");
    assert.match(blocker.reason, /IBAN/i);
    assert.equal(blocker.source, "bank");
  } finally {
    await dropScratchOrgWithPaymentArtifacts(org.orgId);
  }
});

test("an absent debtor IBAN refuses generation and stores nothing", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const fixture = await seedSepaDebitRun(org, {
      routing: {},
      account: null,
      approved: true,
      active: true,
    });

    await assert.rejects(
      () => generatePaymentFileArtifact(fixture.runId, org.orgId, fixture.actorId),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /IBAN|account number|approved bank account/i);
        return true;
      },
    );

    const after = await runState(org.orgId, fixture.runId);
    assert.equal(after.files, 0);
    assert.equal(after.status, "approved");
    assert.equal(after.exportedFileRef, null);
  } finally {
    await dropScratchOrgWithPaymentArtifacts(org.orgId);
  }
});

test("an inactive/unapproved bank at generation refuses and stores nothing", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const fixture = await seedSepaDebitRun(org, {
      routing: { iban: VALID_IBAN, bic: VALID_BIC },
      account: VALID_IBAN,
      approved: true,
      active: true,
    });
    // The exact material-edit write the bank-account flow performs: new
    // revision re-enters approval as pending + inactive.
    await withBypass(() =>
      db.execute(sql`
        update party_bank_accounts set
          approval_status = 'pending', is_active = false, approved_at = null, approved_by = null,
          updated_at = now(), updated_by = ${fixture.actorId}
         where id = ${fixture.accountId} and org_id = ${org.orgId}`),
    );

    await assert.rejects(
      () => generatePaymentFileArtifact(fixture.runId, org.orgId, fixture.actorId),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /not approved|inactive/i);
        return true;
      },
    );

    const after = await runState(org.orgId, fixture.runId);
    assert.equal(after.files, 0);
    assert.equal(after.status, "approved");
    assert.equal(after.exportedFileRef, null);
  } finally {
    await dropScratchOrgWithPaymentArtifacts(org.orgId);
  }
});

test("a valid SEPA debit run still generates its pain.008 artifact", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const fixture = await seedSepaDebitRun(org, {
      routing: { iban: VALID_IBAN, bic: VALID_BIC },
      account: VALID_IBAN,
      approved: true,
      active: true,
    });

    const readiness = await paymentRunReadiness(fixture.runId, org.orgId);
    assert.deepEqual(
      readiness.blockers.filter((b) => b.source === "bank"),
      [],
      "a fully evidenced run must have no bank blockers",
    );

    const artifact = await generatePaymentFileArtifact(fixture.runId, org.orgId, fixture.actorId);
    const content = artifact.content.toString("utf8");
    assert.match(content, /pain\.008/);
    assert.ok(content.includes(VALID_IBAN), "the file must carry the approved debtor IBAN");
    assert.ok(!content.includes(TYPO_IBAN));

    const after = await runState(org.orgId, fixture.runId);
    assert.equal(after.files, 1);
    assert.equal(after.status, "generated");
  } finally {
    await dropScratchOrgWithPaymentArtifacts(org.orgId);
  }
});
