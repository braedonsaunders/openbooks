import { seedApprovedBankAccountFixture } from "../testing/bank-accounts.ts";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "../platform/db.ts";
import { encryptAccountNumber } from "../payments-core/rail-settings.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  grantScratchPermissions,
} from "../testing/fixtures.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { createPaymentRun } from "./run-creation.ts";
import {
  createPaymentBankProfile,
  ensureBuiltInPaymentFormats,
  generatePaymentFileArtifact,
  recordPaymentFileDownload,
  submitPaymentRun,
  updatePaymentBankProfile,
} from "./operations.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const NOW = new Date("2026-07-19T12:00:00Z");
const ORIGINATOR = {
  clientNumber: "0123456789",
  originatorLongName: "Boreal-Ridge Builders, Ltd.",
  originatorShortName: "BOREAL-RIDGE",
  transactionCode: "460",
  serviceCurrency: "CAD",
  transmission: "file_transfer_legacy",
  environment: "production",
};

async function fixture(org: Awaited<ReturnType<typeof createScratchOrg>>) {
  const actorId = await withBypassContext(() =>
    createScratchUser(org.orgId, "AP treasury operator", "ap_treasury"),
  );
  await withBypassContext(() =>
    grantScratchPermissions(org.orgId, actorId, ["ap.pay", "admin.setup.manage", "parties.manage"]),
  );
  await withOrgContext(org.orgId, () => ensureBuiltInPaymentFormats(org.orgId, actorId));
  const formatId = (
    await withOrgContext(org.orgId, () =>
      db.execute<{ id: string }>(
        sql`
    select id from payment_formats where org_id=${org.orgId} and code='RBC-STD152'`,
        "objects",
      ),
    )
  )[0]!.id;
  const profile = await withOrgContext(org.orgId, () =>
    createPaymentBankProfile(org.orgId, actorId, {
      name: "RBC Canadian vendor payments",
      bankAccountId: org.accounts.bank,
      subsidiaryId: org.subsidiaryId,
      paymentFormatId: formatId,
      currency: "CAD",
      country: "CA",
      originatorSecrets: ORIGINATOR,
    }),
  );
  await withOrgContext(org.orgId, () =>
    updatePaymentBankProfile(profile.id, org.orgId, actorId, {
      originatorSecrets: { originatorShortName: "Boreal's AP" },
    }),
  );
  const bankId = randomUUID();
  const billId = randomUUID();
  await withBypassContext(async () => {
    await db.execute(
      sql`update parties set display_name='O’Neil-Smith Supply, Ltd.' where org_id=${org.orgId} and id=${org.vendorId}`,
    );
    await db.execute(sql`insert into vendor_roles (org_id,party_id,ap_account_id,is_active,created_by)
      values (${org.orgId},${org.vendorId},${org.accounts.ap},true,${actorId}) on conflict (party_id) do update set is_active=true`);
    await seedApprovedBankAccountFixture({
      id: bankId,
      orgId: org.orgId,
      actorId,
      partyId: org.vendorId,
      bankName: "Canadian vendor bank",
      country: "CA",
      currency: "CAD",
      routing: { institution: "003", transit: "00212" },
      sealedAccount: encryptAccountNumber("000123456789", { orgId: org.orgId }),
      lastFour: "6789",
    });
    await db.execute(sql`insert into documents (id,org_id,kind,status,document_number,subsidiary_id,party_id,
      document_date,currency,fx_rate,subtotal,tax_total,total,created_by)
      values (${billId},${org.orgId},'vendor_bill','draft','BILL-00427',${org.subsidiaryId},${org.vendorId},
        ${org.date},'CAD','1','1234.56','0','1234.56',${actorId})`);
    await db.execute(sql`insert into document_lines (org_id,document_id,line_number,account_id,quantity,unit_price,amount,tax_amount)
      values (${org.orgId},${billId},1,${org.accounts.cogs},'1','1234.56','1234.56','0')`);
    await db.execute(
      sql`update documents set status='approved' where org_id=${org.orgId} and id=${billId}`,
    );
  });
  await withOrgContext(org.orgId, () =>
    postDocument(billId, {
      control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
    }),
  );
  const run = await withOrgContext(org.orgId, () =>
    createPaymentRun({
      orgId: org.orgId,
      createdBy: actorId,
      paymentBankProfileId: profile.id,
      billDocumentIds: [billId],
      scheduledFor: "2026-07-21",
      allowedSubsidiaryIds: null,
    }),
  );
  const generate = (extra = {}) =>
    withOrgContext(org.orgId, () =>
      generatePaymentFileArtifact(run.id, org.orgId, actorId, { now: NOW, ...extra }),
    );
  const download = (fileId: string) =>
    withOrgContext(org.orgId, () => recordPaymentFileDownload(fileId, org.orgId, actorId));
  return {
    actorId,
    profileId: profile.id,
    formatId,
    runId: run.id,
    bankId,
    billId,
    generate,
    download,
  };
}

async function numbered(orgId: string) {
  return await withOrgContext(orgId, () =>
    db.execute<{ document_kind: string; next_number: number }>(
      sql`
    select document_kind,next_number from number_sequences where org_id=${orgId} and document_kind like 'rbc_std152:%' order by document_kind`,
      "objects",
    ),
  );
}

async function stored(orgId: string, fileId: string) {
  return (
    await withOrgContext(orgId, () =>
      db.execute<{
        content_hash: string;
        bytes: Buffer;
        status: string;
        sequence_number: number;
        total_amount: string;
        payment_count: number;
        currency: string;
      }>(
        sql`
    select pf.content_hash,fb.bytes,pf.status,pf.sequence_number,pf.total_amount::text as total_amount,pf.payment_count,pf.currency
      from payment_files pf join file_versions fv on fv.id=pf.file_version_id
      join files fi on fi.id=fv.file_id and fi.org_id=pf.org_id join file_blobs fb on fb.version_id=fv.id
      where pf.org_id=${orgId} and pf.id=${fileId}`,
        "objects",
      ),
    )
  )[0]!;
}

async function removeFixture(orgId: string) {
  // Dispose only this scratch tenant's artifacts before their cabinet versions.
  await withBypassContext(() =>
    db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('openbooks.amend','on',true),set_config('openbooks.sandbox_wipe','on',true)`,
      );
      const owner = (
        await tx.execute(
          sql`update orgs set env_kind='sandbox' where id=${orgId} and name like 'Scratch %' returning id`,
          "objects",
        )
      )[0];
      assert.ok(owner, "artifact teardown must retain disposable tenant ownership");
      await tx.execute(sql`delete from payment_file_deliveries where org_id=${orgId}`);
      await tx.execute(sql`delete from payment_events where org_id=${orgId}`);
      await tx.execute(sql`delete from payment_files where org_id=${orgId}`);
    }),
  );
  await dropScratchOrg(orgId);
}

test(
  "native RBC AP generation stores its approved CAD artifact and re-download keeps bytes, references and numbering unchanged",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const f = await fixture(org);
      await assert.rejects(f.generate(), /approve the payment run/);
      assert.deepEqual(await numbered(org.orgId), []);
      const submitted = await withOrgContext(org.orgId, () =>
        submitPaymentRun(f.runId, org.orgId, f.actorId),
      );
      assert.deepEqual(submitted, { status: "approved", gated: false });
      const first = await f.generate();
      assert.equal(first.contentType, "text/plain; charset=us-ascii");
      const original = await stored(org.orgId, first.id);
      assert.deepEqual(original.bytes, first.content);
      assert.equal(original.status, "approved");
      assert.equal(original.currency, "CAD");
      assert.equal(original.total_amount, "1234.5600");
      assert.equal(original.payment_count, 1);
      assert.equal(
        createHash("sha256").update(original.bytes).digest("hex"),
        original.content_hash,
      );
      const text = original.bytes.toString("ascii");
      assert.equal(Buffer.from(text, "ascii").equals(original.bytes), true);
      assert.equal(text.endsWith("\r\n"), true);
      assert.equal(text.replaceAll("\r\n", "").includes("\n"), false);
      const [envelope, header, credit, trailer] = text.slice(0, -2).split("\r\n");
      assert.equal(envelope, "$$AAPDSTD0152[PROD[NL$$".padEnd(94));
      for (const record of [header!, credit!, trailer!]) assert.equal(record.length, 152);
      assert.equal(header!.slice(0, 20), "000001AHDR0123456789");
      assert.equal(header!.slice(20, 50), "BOREAL RIDGE BUILDERS LTD".padEnd(30));
      assert.equal(header!.slice(50, 64), "00012026200CAD");
      assert.equal(credit!.slice(6, 10), "C460");
      assert.equal(credit!.slice(43, 51), "00300212");
      assert.equal(credit!.slice(51, 69), "000123456789".padEnd(18));
      assert.equal(credit!.slice(70, 80), "0000123456");
      assert.equal(credit!.slice(86, 93), "2026202");
      assert.equal(credit!.slice(93, 123), "O NEIL SMITH SUPPLY LTD".padEnd(30));
      assert.equal(credit!.slice(125, 140), "BOREAL S AP".padEnd(15));
      assert.equal(credit!.slice(140, 143), "CAD");
      assert.equal(trailer!.slice(6, 20), "ZTRL0123456789");
      assert.equal(trailer!.slice(20, 26), "000001");
      assert.equal(trailer!.slice(26, 40), "00000000123456");
      const payment = (
        await withOrgContext(org.orgId, () =>
          db.execute<{ document_number: string; status: string }>(
            sql`
      select d.document_number,d.status from payment_instructions i join documents d on d.org_id=i.org_id and d.id=i.payment_document_id
      where i.org_id=${org.orgId} and i.payment_run_id=${f.runId}`,
            "objects",
          ),
        )
      )[0]!;
      assert.equal(credit!.slice(21, 40), payment.document_number.replaceAll("-", " ").padEnd(19));
      assert.equal(payment.status, "draft");
      const sequence = await numbered(org.orgId);
      assert.equal(sequence[0]!.next_number, 1);
      await f.download(first.id);
      await f.download(first.id);
      assert.deepEqual((await stored(org.orgId, first.id)).bytes, original.bytes);
      assert.deepEqual(await numbered(org.orgId), sequence);
      const retry = await f.generate({ now: new Date("2026-07-20T12:00:00Z") });
      assert.equal(retry.id, first.id);
      assert.deepEqual(retry.content, original.bytes);
      assert.deepEqual(await numbered(org.orgId), sequence);
      const second = await f.generate({
        reprocessFileId: first.id,
        now: new Date("2026-07-20T12:00:00Z"),
      });
      const replacement = await stored(org.orgId, second.id);
      assert.equal(replacement.sequence_number, 2);
      assert.equal(replacement.status, "approved");
      assert.equal(
        replacement.bytes.toString("ascii").split("\r\n")[1]!.slice(50, 64),
        "00022026200CAD",
      );
      assert.equal((await stored(org.orgId, first.id)).status, "superseded");
      await assert.rejects(f.download(first.id), /not approved for delivery/);
      const replacementNumber = await numbered(org.orgId);
      assert.equal(replacementNumber[0]!.next_number, 2);
      assert.equal((await f.generate({ reprocessFileId: first.id })).id, second.id);
      await f.download(second.id);
      assert.deepEqual(await numbered(org.orgId), replacementNumber);
      const originals = (
        await withOrgContext(org.orgId, () =>
          db.execute<{ name: string; bill: string }>(
            sql`
      select p.display_name as name,d.document_number as bill from documents d join parties p on p.id=d.party_id and p.org_id=d.org_id
      where d.org_id=${org.orgId} and d.id=${f.billId}`,
            "objects",
          ),
        )
      )[0]!;
      assert.deepEqual(originals, { name: "O’Neil-Smith Supply, Ltd.", bill: "BILL-00427" });
      const events = await withOrgContext(org.orgId, () =>
        db.execute<{ actor_id: string; event_type: string }>(
          sql`
      select actor_id,event_type from payment_events where org_id=${org.orgId} and payment_run_id=${f.runId}`,
          "objects",
        ),
      );
      assert.equal(
        events.filter((event) => event.event_type === "rbc_file_number_allocated").length,
        2,
      );
      assert.equal(events.filter((event) => event.event_type === "file_downloaded").length, 3);
      assert.ok(events.every((event) => event.actor_id === f.actorId));
    } finally {
      await removeFixture(org.orgId);
    }
  },
);

test(
  "native RBC AP refuses revoked duty, current role scope, disabled banking and invalid profile configuration before artifact mutation",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const f = await fixture(org);
      await withOrgContext(org.orgId, () => submitPaymentRun(f.runId, org.orgId, f.actorId));
      const deny = (permission: string) =>
        withBypassContext(() =>
          db.execute(sql`update user_permission_overrides set effect='deny'
      where org_id=${org.orgId} and user_id=${f.actorId} and permission=${permission}`),
        );
      await withBypassContext(() => grantScratchPermissions(org.orgId, f.actorId, ["ar.pay"]));
      await deny("ap.pay");
      await assert.rejects(f.generate(), ScopeNotFoundError);
      assert.deepEqual(await numbered(org.orgId), []);
      await withBypassContext(() => grantScratchPermissions(org.orgId, f.actorId, ["ap.pay"]));
      await assert.rejects(f.generate({ allowedSubsidiaryIds: new Set() }), ScopeNotFoundError);
      await assert.rejects(
        withOrgContext(org.orgId, () =>
          createPaymentBankProfile(org.orgId, f.actorId, {
            name: "Incomplete RBC originator",
            bankAccountId: org.accounts.bank,
            subsidiaryId: org.subsidiaryId,
            paymentFormatId: f.formatId,
            currency: "CAD",
            country: "CA",
            originatorSecrets: {},
          }),
        ),
        /clientNumber/,
      );
      assert.equal(
        (
          await withOrgContext(org.orgId, () =>
            db.execute<{ n: number }>(
              sql`
      select count(*)::int as n from payment_bank_profiles where org_id=${org.orgId}`,
              "objects",
            ),
          )
        )[0]!.n,
        1,
      );
      await assert.rejects(
        withOrgContext(org.orgId, () =>
          updatePaymentBankProfile(f.profileId, org.orgId, f.actorId, {
            originatorSecrets: { clientNumber: "" },
          }),
        ),
        /clientNumber/,
      );
      assert.deepEqual(await numbered(org.orgId), []);
      const first = await f.generate();
      const identity = await numbered(org.orgId);
      await deny("ap.pay");
      await assert.rejects(f.download(first.id), ScopeNotFoundError);
      await assert.rejects(f.generate({ reprocessFileId: first.id }), ScopeNotFoundError);
      await withBypassContext(() => grantScratchPermissions(org.orgId, f.actorId, ["ap.pay"]));
      await withBypassContext(() =>
        db.execute(sql`update app_roles set subsidiary_restriction='{"mode":"list","subsidiaryIds":[]}'::jsonb
      where org_id=${org.orgId} and key='ap_treasury'`),
      );
      await assert.rejects(f.download(first.id), ScopeNotFoundError);
      await assert.rejects(f.generate(), ScopeNotFoundError);
      await withBypassContext(() =>
        db.execute(
          sql`update app_roles set subsidiary_restriction='{"mode":"all"}'::jsonb where org_id=${org.orgId} and key='ap_treasury'`,
        ),
      );
      await withBypassContext(() =>
        db.execute(
          sql`update orgs set settings=jsonb_set(settings,'{features,banking}','false'::jsonb) where id=${org.orgId}`,
        ),
      );
      await assert.rejects(f.download(first.id), /Enable Banking/);
      await assert.rejects(f.generate({ reprocessFileId: first.id }), /Enable Banking/);
      assert.deepEqual(await numbered(org.orgId), identity);
      assert.equal((await stored(org.orgId, first.id)).status, "approved");
      assert.equal(
        (
          await withOrgContext(org.orgId, () =>
            db.execute<{ n: number }>(
              sql`
      select count(*)::int as n from payment_file_deliveries where org_id=${org.orgId} and payment_file_id=${first.id}`,
              "objects",
            ),
          )
        )[0]!.n,
        0,
      );
      await withBypassContext(() =>
        db.execute(
          sql`update orgs set settings=jsonb_set(settings,'{features,banking}','true'::jsonb) where id=${org.orgId}`,
        ),
      );
      await deny("admin.setup.manage");
      await assert.rejects(
        withOrgContext(org.orgId, () =>
          updatePaymentBankProfile(f.profileId, org.orgId, f.actorId, {
            name: "Unauthorized treasury edit",
          }),
        ),
        ScopeNotFoundError,
      );
      await f.download(first.id);
      assert.deepEqual(await numbered(org.orgId), identity);
    } finally {
      await removeFixture(org.orgId);
    }
  },
);
