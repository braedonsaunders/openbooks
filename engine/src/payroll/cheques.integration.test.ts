import { sealJson } from "../platform/secrets.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { grantScratchPermissions, seedPayrollSettings } from "../testing/fixtures.ts";
import {
  issuePayRunCheques,
  payRunCheques,
  issuedChequeBank,
  lockIssuedChequePrint,
  assertIssuedChequeFunding,
} from "./cheques.ts";
import { commitPayRun } from "./run-commit.ts";
import { calculatedRun, seedAdoption } from "./filing-test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

const originalDataKey = process.env.OPENBOOKS_DATA_KEY;
test.before(() => {
  if (DB) process.env.OPENBOOKS_DATA_KEY = "00".repeat(32);
});
test.after(() => {
  if (originalDataKey === undefined) delete process.env.OPENBOOKS_DATA_KEY;
  else process.env.OPENBOOKS_DATA_KEY = originalDataKey;
});
async function seedChequeBank(fx: { orgId: string; actorId: string; subsidiaryId: string }) {
  const format = randomUUID(),
    profile = randomUUID();
  const bank = (
    await db.execute<{ id: string }>(
      sql`select id from accounts where org_id=${fx.orgId} and type='asset_bank' and is_active and not is_summary order by number limit 1`,
      "objects",
    )
  )[0]!;
  await db.execute(
    sql`insert into payment_formats(id,org_id,code,name,rail,direction,created_by,updated_by) values(${format},${fx.orgId},'CHEQUE','Cheque register','cheque','credit',${fx.actorId},${fx.actorId})`,
  );
  await db.execute(
    sql`insert into payment_bank_profiles(id,org_id,name,bank_account_id,payment_format_id,subsidiary_id,currency,created_by,updated_by) values(${profile},${fx.orgId},'Preprinted cheque stock',${bank.id},${format},${fx.subsidiaryId},'CAD',${fx.actorId},${fx.actorId})`,
  );
}

/**
 * Cheque stock is physical: a number that has left the printer cannot be
 * recalled. Issuing for a run the caller only partly owns would put
 * negotiable instruments for out-of-scope employees into the world, so a
 * scoped caller must own the complete population — the same opacity every
 * other run action enforces.
 */
test(
  "cheque issue refuses a run carrying employees outside the caller's subsidiary scope",
  { skip: !DB },
  async () => {
    const fx = await seedAdoption();
    await seedChequeBank(fx);
    await grantScratchPermissions(fx.orgId, fx.actorId, ["payroll.run"]);
    await seedPayrollSettings(fx.orgId, { features: { payroll: true } });
    await db.execute(sql`update parties set subsidiary_id = ${fx.subsidiaryId}
      where org_id = ${fx.orgId} and id = ${fx.employeeId}`);
    const { input } = await calculatedRun(fx);
    await commitPayRun(input);
    // The fixture hire holds no bank details, so the stub settles on paper.
    assert.equal((await payRunCheques(fx.orgId, input.documentId)).cheques.length, 1);

    const hidden = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      values (${hidden}, ${fx.orgId}, ${fx.subsidiaryId}, 'Hidden cheque employer', 'CAD', 'CA')`);
    await db.execute(sql`update parties set subsidiary_id = ${hidden}
      where org_id = ${fx.orgId} and id = ${fx.employeeId}`);

    const scoped = new Set([fx.subsidiaryId]);
    await assert.rejects(
      issuePayRunCheques({
        orgId: fx.orgId,
        documentId: input.documentId,
        actorId: fx.actorId,
        allowedSubsidiaryIds: scoped,
      }),
      /pay run not found/,
    );
    const stamped = (
      await db.execute<{ count: string }>(
        sql`
      select count(*) as count from pay_stubs
       where org_id = ${fx.orgId} and pay_run_document_id = ${input.documentId}
         and cheque_number is not null`,
        "objects",
      )
    )[0]!.count;
    assert.equal(stamped, "0", "a refused issue must not burn cheque stock");
    // Unrestricted payroll still issues the complete batch.
    assert.equal(
      (
        await issuePayRunCheques({
          orgId: fx.orgId,
          documentId: input.documentId,
          actorId: fx.actorId,
        })
      ).issued,
      1,
    );
  },
);

test(
  "cheque issuance and reprints keep numbering stable, record audit and refuse revoked authority",
  { skip: !DB },
  async () => {
    const fx = await seedAdoption();
    await seedChequeBank(fx);
    await grantScratchPermissions(fx.orgId, fx.actorId, ["payroll.run"]);
    await seedPayrollSettings(fx.orgId, { features: { payroll: true } });
    const { input } = await calculatedRun(fx);
    await commitPayRun(input);
    const request = { orgId: fx.orgId, documentId: input.documentId, actorId: fx.actorId };
    const issued = await issuePayRunCheques(request);
    assert.equal(issued.issued, 1);
    const reprint = await issuePayRunCheques(request);
    assert.equal(reprint.issued, 0);
    assert.deepEqual(reprint.cheques, issued.cheques);
    const audits = await db.execute<{ n: string }>(
      sql`select count(*)::text n from audit_log where org_id=${fx.orgId} and row_id=${issued.cheques[0]!.stubId} and changes->>'event'='cheque_issued'`,
      "objects",
    );
    assert.equal(audits[0]!.n, "1");
    await db.execute(
      sql`update users set is_active=false where org_id=${fx.orgId} and id=${fx.actorId}`,
    );
    await assert.rejects(issuePayRunCheques(request));
    await db.execute(
      sql`update users set is_active=true where org_id=${fx.orgId} and id=${fx.actorId}`,
    );
    await seedPayrollSettings(fx.orgId, { features: { payroll: false } });
    await assert.rejects(issuePayRunCheques(request), /Payroll is switched off/);
    assert.deepEqual((await payRunCheques(fx.orgId, input.documentId)).cheques, issued.cheques);
  },
);

test(
  "cheque bank identity is frozen at issuance and live print authority refuses voided payroll",
  { skip: !DB },
  async () => {
    const priorKey = process.env.OPENBOOKS_DATA_KEY;
    process.env.OPENBOOKS_DATA_KEY = "00".repeat(32);
    try {
      const fx = await seedAdoption();
      await grantScratchPermissions(fx.orgId, fx.actorId, ["payroll.run", "admin.setup.manage"]);
      await seedPayrollSettings(fx.orgId, { features: { payroll: true } });
      const format = { id: randomUUID() };
      await db.execute(
        sql`insert into payment_formats(id,org_id,code,name,rail,direction,created_by,updated_by) values(${format.id},${fx.orgId},'CHEQUE','Cheque register','cheque','credit',${fx.actorId},${fx.actorId})`,
      );
      const bank = (
        await db.execute<{ id: string }>(
          sql`select id from accounts where org_id=${fx.orgId} and type='asset_bank' and is_active and not is_summary order by number limit 1`,
          "objects",
        )
      )[0]!;
      const specification = {
        bankName: "Sample bank",
        branchAddress: "1 Sample Street",
        institution: "003",
        transit: "01234",
        accountEncoding: "0012-345",
        effectiveFrom: "2026-01-01",
      };
      const profile = { id: randomUUID() };
      await db.execute(
        sql`insert into payment_bank_profiles(id,org_id,name,bank_account_id,payment_format_id,subsidiary_id,currency,country,originator_secrets_encrypted,created_by,updated_by) values(${profile.id},${fx.orgId},'Cheque stock bank',${bank.id},${format.id},${fx.subsidiaryId},'CAD','CA',${sealJson(specification, { orgId: fx.orgId, purpose: "payment.originator.secrets" })},${fx.actorId},${fx.actorId})`,
      );
      const { input } = await calculatedRun(fx);
      await commitPayRun(input);
      await db.execute(
        sql`insert into number_sequences(org_id,document_kind,subsidiary_id,prefix,next_number,padding) values(${fx.orgId},'payroll_cheque',null,'',41,6)`,
      );
      const request = {
        orgId: fx.orgId,
        documentId: input.documentId,
        actorId: fx.actorId,
        bankProfileId: profile.id,
        printMicr: true,
      };
      const first = await issuePayRunCheques(request);
      assert.equal(first.cheques[0]!.chequeNumber, "000042");
      await db.transaction((tx) =>
        assertIssuedChequeFunding(tx, fx.orgId, input.documentId, bank.id),
      );
      await assert.rejects(
        db.transaction((tx) =>
          assertIssuedChequeFunding(tx, fx.orgId, input.documentId, randomUUID()),
        ),
        /bank account bound/,
      );
      await db.execute(
        sql`update payment_bank_profiles set originator_secrets_encrypted=${sealJson({ ...specification, accountEncoding: "0099-999" }, { orgId: fx.orgId, purpose: "payment.originator.secrets" })},is_active=false where org_id=${fx.orgId} and id=${profile.id}`,
      );
      await db.execute(
        sql`update parties set display_name='Renamed after cheque issuance' where org_id=${fx.orgId} and id=${first.cheques[0]!.employeePartyId}`,
      );
      const reprint = await issuePayRunCheques(request);
      assert.equal(reprint.issued, 0);
      assert.equal(reprint.cheques[0]!.employeeName, first.cheques[0]!.employeeName);
      assert.equal(
        (await payRunCheques(fx.orgId, input.documentId)).cheques[0]!.employeeName,
        first.cheques[0]!.employeeName,
      );
      assert.equal(
        (await issuedChequeBank(fx.orgId, first.cheques[0]!.stubId))!.bank!.accountEncoding,
        "0012-345",
      );
      await assert.rejects(
        issuePayRunCheques({ ...request, bankProfileId: randomUUID() }),
        /original cheque bank profile/,
      );
      const audit = (
        await db.execute<{ changes: Record<string, unknown> }>(
          sql`select changes from audit_log where org_id=${fx.orgId} and row_id=${first.cheques[0]!.stubId} and changes->>'event'='cheque_issued'`,
          "objects",
        )
      )[0]!;
      assert.ok(
        !JSON.stringify(audit.changes).includes("0012-345"),
        "bank details stay encrypted in audit evidence",
      );
      await db.execute(
        sql`update pay_runs set run_status='voided' where org_id=${fx.orgId} and document_id=${input.documentId}`,
      );
      await assert.rejects(
        db.transaction((tx) =>
          lockIssuedChequePrint(tx, {
            orgId: fx.orgId,
            stubId: first.cheques[0]!.stubId,
            actorId: fx.actorId,
          }),
        ),
        /committed payroll/,
      );
    } finally {
      if (priorKey === undefined) delete process.env.OPENBOOKS_DATA_KEY;
      else process.env.OPENBOOKS_DATA_KEY = priorKey;
    }
  },
);
