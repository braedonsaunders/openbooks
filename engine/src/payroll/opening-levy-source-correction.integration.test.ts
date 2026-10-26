import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "../platform/db.ts";
import {
  dropScratchOrgReporting,
  seedPayrollSettings,
  grantScratchPermissions,
} from "../testing/fixtures.ts";
import { errorChainMatches } from "../testing/error-chain.ts";
import {
  calculatedRun,
  seedAdoption,
  seedUsEinAccount,
  type AdoptionFixture,
} from "./filing-test-fixtures.ts";
import { saveOpeningBalances } from "./opening-balances.ts";
import {
  qualifyOpeningEmployerAuthority,
  readOpeningEmployerContext,
} from "./opening-employer-authority.ts";
import {
  qualifyOpeningLevySourceAuthority,
  readOpeningLevySourceContext,
  type OpeningLevySourceAllocationInput,
} from "./opening-levy-source-authority.ts";
import { correctOpeningLevySourceAuthority } from "./opening-levy-source-correction.ts";
import { readEmployeeOpeningLevySources } from "./opening-levy-source-reader.ts";
import {
  qualifyCanadianOpeningReportingSource,
  readCanadianOpeningReportingSourceContext,
} from "./canada/opening-reporting-authority.ts";
import { readEmployeeCanadianOpeningReportingSource } from "./canada/opening-reporting-reader.ts";
import { commitPayRun } from "./run-commit.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { payRunCalculationSource } from "./run-calculation-evidence.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { requestDocumentVoid } from "../ledger/document-void.ts";
import { filingArtifact, filingSubmissions, recordFilingIssue } from "./yearend-amendments.ts";
import { t4Slips } from "./yearend.ts";
import { sealSecret } from "../platform/secrets.ts";

const skip = !process.env.OPENBOOKS_DB_URL;
const facts = {
  originalCountry: "US",
  originalCurrency: "USD",
  coverageStart: "2026-01-01",
  coverageEnd: "2026-06-30",
  coverageComplete: true,
} as const;

async function setup(country: "US" | "CA" = "US") {
  const f = await seedAdoption();
  await seedPayrollSettings(f.orgId, { features: { payroll: true } });
  await grantScratchPermissions(f.orgId, f.actorId, ["payroll.read", "payroll.run"]);
  if (country === "US")
    await db.execute(
      sql`update subsidiaries set country='US',base_currency='USD' where org_id=${f.orgId} and id=${f.subsidiaryId}`,
    );
  return f;
}

async function sourcePacket(
  f: AdoptionFixture,
  allocations: readonly OpeningLevySourceAllocationInput[],
  sourceFacts: {
    originalCountry: "US" | "CA";
    originalCurrency: "USD" | "CAD";
    coverageStart: string;
    coverageEnd: string;
    coverageComplete: true;
  } = facts,
) {
  const sourceFileId = randomUUID(),
    sourceVersionId = randomUUID(),
    folderId = randomUUID();
  const bytes = Buffer.from(
    JSON.stringify({
      employeePartyId: f.employeeId,
      subsidiaryId: f.subsidiaryId,
      taxYear: 2026,
      taxableYtd: "12000.0000",
      taxYtd: "125.0000",
      ...sourceFacts,
      allocations,
    }),
  );
  const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
  await db.execute(sql`insert into folders(id,org_id,name,is_private,owner_id,created_by,updated_by)
    values(${folderId},${f.orgId},'Original source evidence',true,${f.actorId},${f.actorId},${f.actorId})`);
  await db.execute(sql`insert into files(id,org_id,folder_id,name,content_type,size_bytes,created_by,updated_by)
    values(${sourceFileId},${f.orgId},${folderId},'original-source.json','application/json',${bytes.length},${f.actorId},${f.actorId})`);
  await db.execute(sql`insert into file_versions(id,file_id,version_number,size_bytes,content_type,content_hash,created_by)
    values(${sourceVersionId},${sourceFileId},1,${bytes.length},'application/json',${sourceSha256},${f.actorId})`);
  assert.equal(
    (
      await db.execute(
        sql`insert into file_blobs(version_id,bytes) values(${sourceVersionId},${bytes}) returning version_id`,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`update files set current_version_id=${sourceVersionId}
    where org_id=${f.orgId} and id=${sourceFileId} returning id`,
        "objects",
      )
    ).length,
    1,
  );
  const context = {
    orgId: f.orgId,
    actorId: f.actorId,
    employeePartyId: f.employeeId,
    taxYear: 2026,
    sourceFileId,
    allowedSubsidiaryIds: null,
  };
  const employer = await readOpeningEmployerContext(context);
  const levy = await readOpeningLevySourceContext(context);
  assert.ok(employer.record);
  assert.ok(levy.record);
  return {
    orgId: f.orgId,
    actorId: f.actorId,
    openingBalanceId: employer.record.id,
    expectedOpeningSha256: employer.record.openingSha256,
    expectedOpeningChildrenSha256: levy.record.openingChildrenSha256,
    sourceFileId,
    sourceVersionId,
    sourceSha256,
    ...sourceFacts,
    allocations,
    sourceReference: "Source-confirmed original statutory allocation",
    reason: "Retain the exact original statutory source",
    allowedSubsidiaryIds: null,
  };
}

async function qualify(f: AdoptionFixture) {
  assert.deepEqual(
    (
      await saveOpeningBalances({
        orgId: f.orgId,
        actorId: f.actorId,
        taxYear: 2026,
        rows: [{ employeePartyId: f.employeeId, amounts: { taxableYtd: "12000", taxYtd: "125" } }],
      })
    ).errors,
    [],
  );
  const ein = await seedUsEinAccount(f.orgId, f.actorId, f.subsidiaryId, "12-3456789");
  const allocations = [
    {
      programKey: "us_futa",
      region: "US",
      filingAccountId: ein,
      federalAccountId: ein,
      amount: "0",
    },
  ];
  const packet = await sourcePacket(f, allocations);
  await qualifyOpeningEmployerAuthority({ ...packet, subsidiaryId: f.subsidiaryId });
  const original = await qualifyOpeningLevySourceAuthority(packet);
  return { packet, original, allocations };
}

const canadianFacts = { ...facts, originalCountry: "CA", originalCurrency: "CAD" } as const;
const canadianAllocations: OpeningLevySourceAllocationInput[] = [
  ...["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"].map(
    (region) => ({ programKey: "ca_wcb", region, federalAccountId: null, amount: "0" }),
  ),
  ...["BC", "MB", "NL", "ON"].map((region) => ({
    programKey: "ca_eht",
    region,
    federalAccountId: null,
    amount: "0",
  })),
  { programKey: "ca_cnt", region: "QC", federalAccountId: null, amount: "0" },
];

async function qualifyCanadian(f: AdoptionFixture) {
  assert.deepEqual(
    (
      await saveOpeningBalances({
        orgId: f.orgId,
        actorId: f.actorId,
        taxYear: 2026,
        rows: [{ employeePartyId: f.employeeId, amounts: { taxableYtd: "12000", taxYtd: "125" } }],
      })
    ).errors,
    [],
  );
  const accountId = randomUUID();
  assert.equal(
    (
      await db.execute(
        sql`insert into payroll_filing_accounts
    (id,org_id,country,program_type,account_number,name,subsidiary_id,created_by,updated_by)
    values(${accountId},${f.orgId},'CA','ca_rp','123456789RP0001','Original payroll account',
      ${f.subsidiaryId},${f.actorId},${f.actorId}) returning id`,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`update employee_payroll_profiles set filing_account_id=${accountId},
    sin_encrypted=${sealSecret("046454286", { orgId: f.orgId, purpose: "payroll.employee.sin" })}
    where org_id=${f.orgId} and employee_party_id=${f.employeeId} returning employee_party_id`,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`update orgs set settings=jsonb_set(settings,'{payroll,t4Transmitter}',
    ${JSON.stringify({
      bn: "123456789RP0001",
      transmitterNumber: "MM555555",
      name: "Original Employer",
      contactName: "Payroll Controller",
      contactEmail: "payroll@example.test",
      contactPhone: "5555550100",
    })}::jsonb)
    where id=${f.orgId} returning id`,
        "objects",
      )
    ).length,
    1,
  );
  const packet = await sourcePacket(f, canadianAllocations, canadianFacts);
  await qualifyOpeningEmployerAuthority({ ...packet, subsidiaryId: f.subsidiaryId });
  const original = await qualifyOpeningLevySourceAuthority(packet);
  const contextInput = {
    orgId: f.orgId,
    actorId: f.actorId,
    employeePartyId: f.employeeId,
    taxYear: 2026,
    sourceFileId: packet.sourceFileId,
    allowedSubsidiaryIds: null,
  };
  const context = await readCanadianOpeningReportingSourceContext(contextInput);
  assert.ok(context.original.children);
  assert.deepEqual(Object.keys(context.original.children).sort(), [
    "accountBases",
    "components",
    "programBases",
    "suiStates",
  ]);
  const reporting = {
    ...packet,
    requestId: randomUUID(),
    expectedLevyAuthorityId: original.id,
    expectedLevyAllocationSha256: original.allocationSha256,
    allocations: [
      {
        sourceOrdinal: 1,
        firstCoveredPayDate: "2026-01-15",
        filingAccountId: accountId,
        province: "ON",
        annualAmounts: context.original.annualAmounts,
        reportableBases: { ei: "0", cpp: "0", qpip: "0" },
        children: context.original.children,
      },
    ],
    sourceReference: "Original RP and Ontario annual reporting allocation",
    reason: "Retain the complete original reporting allocation",
  };
  const reportingAuthority = await qualifyCanadianOpeningReportingSource(reporting);
  return { packet, original, reporting, reportingAuthority, contextInput };
}

async function retainedSourceHistory(f: AdoptionFixture, originalId: string, reportingId: string) {
  const result = await db.execute<{ history: unknown }>(
    sql`select jsonb_build_object(
    'opening',to_jsonb(b),'children',public.payroll_opening_source_children(b.org_id,b.id,b.employee_party_id,b.tax_year),
    'employer',to_jsonb(e),'levy',to_jsonb(h),'reporting',to_jsonb(r),
    'levyAllocations',(select jsonb_agg(to_jsonb(a) order by a.id) from payroll_opening_levy_source_allocations a
      where a.org_id=h.org_id and a.authority_id=h.id),
    'reportingAllocations',(select jsonb_agg(to_jsonb(a) order by a.id) from payroll_ca_opening_reporting_allocations a
      where a.org_id=r.org_id and a.authority_id=r.id),
    'audit',(select jsonb_agg(to_jsonb(a) order by a.at,a.id) from audit_log a where a.org_id=b.org_id
      and a.row_id in (b.id,e.id,h.id,r.id))) as history
    from payroll_opening_levy_source_authorities h
    join payroll_opening_balances b on b.org_id=h.org_id and b.id=h.opening_balance_id
    join payroll_opening_employer_authorities e on e.org_id=h.org_id and e.id=h.employer_authority_id
    join payroll_ca_opening_reporting_authorities r on r.org_id=h.org_id and r.id=${reportingId}
    where h.org_id=${f.orgId} and h.id=${originalId}`,
    "objects",
  );
  assert.equal(result.length, 1);
  return result[0]!.history;
}

async function commitAndPost(f: AdoptionFixture) {
  const { input, entryId } = await calculatedRun(f);
  const source = await payRunCalculationSource(f.orgId, input.documentId);
  assert.ok(source);
  await commitPayRun(input);
  const approved = (
    await db.execute<{ status: string }>(
      sql`select status from documents where org_id=${f.orgId} and id=${input.documentId}`,
      "objects",
    )
  )[0];
  assert.equal(
    approved?.status,
    "approved",
    "native payroll commitment retains its zero-gate approval release",
  );
  const accounts = await db.execute<{ id: string; type: string }>(
    sql`select id,type from accounts where org_id=${f.orgId}`,
    "objects",
  );
  const account = (type: string) => {
    const id = accounts.find((row) => row.type === type)?.id;
    assert.ok(id, `Native posting control ${type} must exist`);
    return id;
  };
  const postedEntryId = await postDocument(input.documentId, {
    control: {
      ar: account("asset_receivable"),
      ap: account("liability_payable"),
      bank: account("asset_bank"),
    },
  });
  return { input, entryId, source, postedEntryId };
}

async function nativeVoid(f: AdoptionFixture, run: Awaited<ReturnType<typeof commitAndPost>>) {
  const reason = "Reverse the original payroll before reviewing its retained source";
  const result = await requestDocumentVoid({
    ...run.input,
    reason,
    reversalDate: "2026-07-31",
    allowedSubsidiaryIds: null,
  });
  assert.equal(result.status, "voided");
  assert.ok(result.reversalEntryId);
  assert.deepEqual(
    await db.execute<{ status: string; runStatus: string; reversalEntryId: string }>(
      sql`
    select d.status,r.run_status as "runStatus",d.reversal_entry_id as "reversalEntryId"
    from documents d join pay_runs r on r.org_id=d.org_id and r.document_id=d.id
    where d.org_id=${f.orgId} and d.id=${run.input.documentId}`,
      "objects",
    ),
    [{ status: "voided", runStatus: "voided", reversalEntryId: result.reversalEntryId }],
  );
  assert.equal(
    (
      await db.execute(
        sql`select id from journal_entries where org_id=${f.orgId}
    and id=${result.reversalEntryId} and reverses_entry_id=${run.postedEntryId}`,
        "objects",
      )
    ).length,
    1,
  );
  assert.deepEqual(
    await db.execute<{ balanced: boolean; exactReversal: boolean }>(
      sql`select
    (select sum(amount)=0 from journal_lines where org_id=${f.orgId} and entry_id=${result.reversalEntryId}) as balanced,
    not exists (select account_id,sum(amount)::numeric from journal_lines
      where org_id=${f.orgId} and entry_id=${run.postedEntryId} group by account_id
      except select account_id,-sum(amount)::numeric from journal_lines
      where org_id=${f.orgId} and entry_id=${result.reversalEntryId} group by account_id) as "exactReversal"`,
      "objects",
    ),
    [{ balanced: true, exactReversal: true }],
  );
  const audit = await db.execute<{
    actorId: string;
    changes: {
      source: string;
      reason: string;
      before: { document: { status: string } };
      after: { document: { status: string } };
    };
  }>(
    sql`
    select actor_id as "actorId",changes from audit_log where org_id=${f.orgId}
      and row_id=${run.input.documentId} and changes->>'mode'='transaction_void'`,
    "objects",
  );
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.actorId, f.actorId);
  assert.equal(audit[0]!.changes.source, "controlled_void");
  assert.equal(audit[0]!.changes.reason, reason);
  assert.equal(audit[0]!.changes.before.document.status, "posted");
  assert.equal(audit[0]!.changes.after.document.status, "voided");
  assert.deepEqual(
    await db.execute<{ batch: string | null }>(
      sql`select payroll_batch_ref as batch from time_entries
    where org_id=${f.orgId} and id=${run.entryId}`,
      "objects",
    ),
    [{ batch: null }],
  );
}

test(
  "source correction appends explicit new EIN evidence without altering original amounts, certificate or audit",
  { skip },
  async () => {
    const f = await withBypassContext(setup);
    try {
      await withOrgContext(f.orgId, async () => {
        const { original, allocations } = await qualify(f);
        const retained = (
          await db.execute<{ source: unknown }>(
            sql`select to_jsonb(h) as source from payroll_opening_levy_source_authorities h
      where h.org_id=${f.orgId} and h.id=${original.id}`,
            "objects",
          )
        )[0]!.source;
        const before = await readEmployeeOpeningLevySources(db, {
          orgId: f.orgId,
          employeePartyId: f.employeeId,
          taxYear: 2026,
        });
        const addedEin = await seedUsEinAccount(f.orgId, f.actorId, f.subsidiaryId, "98-7654321");
        const correction = {
          ...(await sourcePacket(f, [
            ...allocations,
            {
              programKey: "us_futa",
              region: "US",
              filingAccountId: addedEin,
              federalAccountId: addedEin,
              amount: "0",
            },
          ])),
          requestId: randomUUID(),
          expectedAuthorityId: original.id,
          expectedAllocationSha256: original.allocationSha256,
          reason: "The retained source confirms an additional original EIN with no FUTA wages",
        };
        const successor = await correctOpeningLevySourceAuthority(correction);
        assert.notEqual(successor.id, original.id);
        assert.deepEqual(await correctOpeningLevySourceAuthority(correction), successor);
        const after = await readEmployeeOpeningLevySources(db, {
          orgId: f.orgId,
          employeePartyId: f.employeeId,
          taxYear: 2026,
        });
        assert.equal(after.authority?.authorityId, successor.id);
        assert.equal(after.allocations.length, 2);
        assert.deepEqual(after.openingSnapshot, before.openingSnapshot);
        assert.deepEqual(after.openingChildren, before.openingChildren);
        assert.equal(after.authority?.employerAuthorityId, before.authority?.employerAuthorityId);
        assert.equal(after.authority?.openingSha256, before.authority?.openingSha256);
        assert.deepEqual(
          (
            await db.execute<{ source: unknown }>(
              sql`select to_jsonb(h) as source from payroll_opening_levy_source_authorities h
      where h.org_id=${f.orgId} and h.id=${original.id}`,
              "objects",
            )
          )[0]!.source,
          retained,
        );
        const audit = await db.execute<{
          changes: { before: { id: string }; after: { id: string }; reason: string };
        }>(
          sql`
      select changes from audit_log where org_id=${f.orgId} and table_name='payroll_opening_levy_source_authorities' and row_id=${successor.id}
    `,
          "objects",
        );
        assert.equal(audit.length, 1);
        assert.equal(audit[0]!.changes.before.id, original.id);
        assert.equal(audit[0]!.changes.after.id, successor.id);
        assert.equal(audit[0]!.changes.reason, correction.reason);
        await assert.rejects(
          correctOpeningLevySourceAuthority({ ...correction, reason: "Different evidence" }),
          /request already preserves different evidence/,
        );
        await assert.rejects(
          correctOpeningLevySourceAuthority({ ...correction, requestId: randomUUID() }),
          /certificate changed/,
        );
        await assert.rejects(
          correctOpeningLevySourceAuthority({ ...correction, allowedSubsidiaryIds: new Set() }),
          /outside your payroll authority/,
        );
        await assert.rejects(
          correctOpeningLevySourceAuthority({
            ...correction,
            expectedOpeningChildrenSha256: "f".repeat(64),
          }),
          /amounts changed/,
        );
        assert.equal(
          (
            await db.execute(
              sql`update user_permission_overrides set effect='deny'
      where org_id=${f.orgId} and user_id=${f.actorId} and permission='payroll.manage' returning user_id`,
              "objects",
            )
          ).length,
          1,
        );
        await assert.rejects(
          correctOpeningLevySourceAuthority(correction),
          /Payroll manage permission/,
        );
        assert.equal(
          (
            await db.execute(
              sql`update user_permission_overrides set effect='grant'
      where org_id=${f.orgId} and user_id=${f.actorId} and permission='payroll.manage' returning user_id`,
              "objects",
            )
          ).length,
          1,
        );
        assert.equal(
          (
            await db.execute(
              sql`update folders set owner_id=null where org_id=${f.orgId}
      and id=(select folder_id from files where org_id=${f.orgId} and id=${correction.sourceFileId}) returning id`,
              "objects",
            )
          ).length,
          1,
        );
        await assert.rejects(correctOpeningLevySourceAuthority(correction), (error) =>
          errorChainMatches(error, /Source file is unavailable to this operator/),
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);

test(
  "concurrent source corrections cannot fork the same reviewed sealed certificate",
  { skip },
  async () => {
    const f = await withBypassContext(setup);
    try {
      await withOrgContext(f.orgId, async () => {
        const { original, allocations } = await qualify(f);
        const packet = await sourcePacket(f, allocations);
        const candidate = {
          ...packet,
          expectedAuthorityId: original.id,
          expectedAllocationSha256: original.allocationSha256,
          reason: "Correct the original source reference with retained evidence",
        };
        const results = await Promise.allSettled([
          correctOpeningLevySourceAuthority({ ...candidate, requestId: randomUUID() }),
          correctOpeningLevySourceAuthority({ ...candidate, requestId: randomUUID() }),
        ]);
        assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
        const refusal = results.find((result) => result.status === "rejected");
        assert.ok(refusal && refusal.status === "rejected");
        assert.match(String(refusal.reason), /certificate changed/);
        assert.equal(
          (
            await db.execute(
              sql`select id from payroll_opening_levy_source_authorities
      where org_id=${f.orgId} and supersedes_authority_id=${original.id}`,
              "objects",
            )
          ).length,
          1,
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);

test(
  "native committed use refuses source correction until governed void releases it and replacement uses the successor",
  { skip },
  async () => {
    const f = await withBypassContext(() => setup("CA"));
    try {
      await withOrgContext(f.orgId, async () => {
        const { original, reporting, reportingAuthority } = await qualifyCanadian(f);
        const history = await retainedSourceHistory(f, original.id, reportingAuthority.id);
        const before = await readEmployeeOpeningLevySources(db, {
          orgId: f.orgId,
          employeePartyId: f.employeeId,
          taxYear: 2026,
        });
        const run = await commitAndPost(f);
        assert.equal(run.source.openingLevySourceAuthorities?.[0]?.id, original.id);
        const stubHistory = await db.execute<{ history: unknown }>(
          sql`select jsonb_build_object(
      'stub',to_jsonb(s),'lines',(select jsonb_agg(to_jsonb(l) order by l.id) from pay_stub_lines l
        where l.org_id=s.org_id and l.stub_id=s.id)) as history from pay_stubs s
      where s.org_id=${f.orgId} and s.pay_run_document_id=${run.input.documentId} order by s.id`,
          "objects",
        );
        assert.equal(stubHistory.length, 1);
        const correction = {
          ...(await sourcePacket(f, canadianAllocations, canadianFacts)),
          requestId: randomUUID(),
          expectedAuthorityId: original.id,
          expectedAllocationSha256: original.allocationSha256,
          sourceReference: "Reviewed exact original statutory report",
          reason: "Correct the retained original source reference",
        };
        await assert.rejects(
          correctOpeningLevySourceAuthority(correction),
          /Committed payroll retains this opening source/,
        );
        assert.equal(
          (
            await db.execute(
              sql`select id from payroll_opening_levy_source_authorities
      where org_id=${f.orgId} and supersedes_authority_id=${original.id}`,
              "objects",
            )
          ).length,
          0,
        );
        await nativeVoid(f, run);
        const successor = await correctOpeningLevySourceAuthority(correction);
        const after = await readEmployeeOpeningLevySources(db, {
          orgId: f.orgId,
          employeePartyId: f.employeeId,
          taxYear: 2026,
        });
        assert.equal(after.authority?.authorityId, successor.id);
        assert.equal(after.authority?.subsidiaryId, before.authority?.subsidiaryId);
        assert.equal(after.authority?.employerAuthorityId, before.authority?.employerAuthorityId);
        assert.equal(after.authority?.sourceVersionId, correction.sourceVersionId);
        assert.deepEqual(after.openingSnapshot, before.openingSnapshot);
        assert.deepEqual(after.openingChildren, before.openingChildren);
        assert.deepEqual(after.allocations, before.allocations);
        assert.deepEqual(
          await retainedSourceHistory(f, original.id, reportingAuthority.id),
          history,
        );
        assert.deepEqual(
          await db.execute<{ history: unknown }>(
            sql`select jsonb_build_object(
      'stub',to_jsonb(s),'lines',(select jsonb_agg(to_jsonb(l) order by l.id) from pay_stub_lines l
        where l.org_id=s.org_id and l.stub_id=s.id)) as history from pay_stubs s
      where s.org_id=${f.orgId} and s.pay_run_document_id=${run.input.documentId} order by s.id`,
            "objects",
          ),
          stubHistory,
        );
        await assert.rejects(
          readEmployeeCanadianOpeningReportingSource(db, {
            orgId: f.orgId,
            employeePartyId: f.employeeId,
            taxYear: 2026,
          }),
          /current Canadian original reporting source is missing/,
        );
        await qualifyCanadianOpeningReportingSource({
          ...reporting,
          requestId: randomUUID(),
          expectedLevyAuthorityId: successor.id,
          expectedLevyAllocationSha256: successor.allocationSha256,
        });
        const replacement = await createPayRun({
          orgId: f.orgId,
          actorId: f.actorId,
          payScheduleId: f.scheduleId,
          periodStart: "2026-07-05",
          periodEnd: "2026-07-18",
        });
        const input = { orgId: f.orgId, actorId: f.actorId, documentId: replacement.documentId };
        assert.deepEqual((await calculatePayRun(input)).errors, []);
        const replacementSource = await payRunCalculationSource(f.orgId, replacement.documentId);
        assert.equal(replacementSource?.openingLevySourceAuthorities?.[0]?.id, successor.id);
        assert.equal(
          replacementSource?.openingLevySourceAuthorities?.[0]?.sourceVersionId,
          correction.sourceVersionId,
        );
        assert.equal(
          replacementSource?.openingLevySourceAuthorities?.[0]?.openingSha256,
          correction.expectedOpeningSha256,
        );
        assert.equal(
          replacementSource?.openingLevySourceAuthorities?.[0]?.openingChildrenSha256,
          correction.expectedOpeningChildrenSha256,
        );
        await commitPayRun(input);
        await assert.rejects(
          correctOpeningLevySourceAuthority({
            ...correction,
            requestId: randomUUID(),
            expectedAuthorityId: successor.id,
            expectedAllocationSha256: successor.allocationSha256,
          }),
          /Committed payroll retains this opening source/,
        );
        assert.deepEqual(
          await retainedSourceHistory(f, original.id, reportingAuthority.id),
          history,
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);

test(
  "native filing issue permanently preserves its source after governed payroll void and statutory cancellation",
  { skip },
  async () => {
    const f = await withBypassContext(() => setup("CA"));
    try {
      await withOrgContext(f.orgId, async () => {
        const { original, reportingAuthority } = await qualifyCanadian(f);
        const history = await retainedSourceHistory(f, original.id, reportingAuthority.id);
        const run = await commitAndPost(f);
        const issued = await recordFilingIssue({
          orgId: f.orgId,
          actorId: f.actorId,
          country: "CA",
          filingKey: "t4",
          taxYear: 2026,
          revision: "original",
        });
        assert.ok(issued.file);
        assert.equal(issued.submission.slips.length, 1);
        const artifact = await filingArtifact(f.orgId, issued.submission.id);
        assert.deepEqual(artifact, issued.file);
        const correction = {
          ...(await sourcePacket(f, canadianAllocations, canadianFacts)),
          requestId: randomUUID(),
          expectedAuthorityId: original.id,
          expectedAllocationSha256: original.allocationSha256,
          reason: "Review the original source reference after reversing payroll",
        };
        await nativeVoid(f, run);
        await assert.rejects(
          correctOpeningLevySourceAuthority(correction),
          /An issued payroll filing retains history for this tax year/,
        );
        const cancelled = await recordFilingIssue({
          orgId: f.orgId,
          actorId: f.actorId,
          country: "CA",
          filingKey: "t4",
          taxYear: 2026,
          revision: "cancelled",
          rowIds: issued.submission.slips.map((slip) => slip.rowId),
          reason: "Withdraw the original slip while the payroll period is being reviewed",
        });
        assert.equal(cancelled.submission.supersedesId, issued.submission.id);
        assert.equal(cancelled.submission.revision, "cancelled");
        assert.ok(cancelled.file);
        assert.match(cancelled.file.body, /<RPT_TCD>C<\/RPT_TCD>/);
        assert.deepEqual(
          cancelled.submission.slips[0]!.reported,
          issued.submission.slips[0]!.reported,
        );
        const submissions = await filingSubmissions(f.orgId, "CA", "t4", 2026);
        assert.equal(submissions.length, 2);
        const cancelledArtifact = await filingArtifact(f.orgId, cancelled.submission.id);
        await assert.rejects(
          correctOpeningLevySourceAuthority(correction),
          /An issued payroll filing retains history for this tax year/,
        );
        assert.deepEqual(await filingSubmissions(f.orgId, "CA", "t4", 2026), submissions);
        assert.deepEqual(await filingArtifact(f.orgId, issued.submission.id), artifact);
        assert.deepEqual(await filingArtifact(f.orgId, cancelled.submission.id), cancelledArtifact);
        assert.deepEqual(
          await retainedSourceHistory(f, original.id, reportingAuthority.id),
          history,
        );
        assert.equal(
          (
            await db.execute(
              sql`select id from payroll_opening_levy_source_authorities
      where org_id=${f.orgId} and supersedes_authority_id=${original.id}`,
              "objects",
            )
          ).length,
          0,
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);

test(
  "native filing issue and source correction serialize without an artifact based on a replaced reporting certificate",
  { skip },
  async () => {
    const f = await withBypassContext(() => setup("CA"));
    try {
      await withOrgContext(f.orgId, async () => {
        const { original, reporting, reportingAuthority } = await qualifyCanadian(f);
        const history = await retainedSourceHistory(f, original.id, reportingAuthority.id);
        const slips = await t4Slips(f.orgId, 2026);
        assert.equal(slips.length, 1);
        assert.equal(slips[0]!.box14EmploymentIncome, "12000.0000");
        const correction = {
          ...(await sourcePacket(f, canadianAllocations, canadianFacts)),
          requestId: randomUUID(),
          expectedAuthorityId: original.id,
          expectedAllocationSha256: original.allocationSha256,
          reason: "Review the original Cabinet reference before filing",
        };
        const [corrected, issued] = await Promise.allSettled([
          correctOpeningLevySourceAuthority(correction),
          recordFilingIssue({
            orgId: f.orgId,
            actorId: f.actorId,
            country: "CA",
            filingKey: "t4",
            taxYear: 2026,
            revision: "original",
          }),
        ]);
        assert.equal(
          [corrected, issued].filter((result) => result.status === "fulfilled").length,
          1,
        );
        if (issued.status === "fulfilled") {
          assert.equal(corrected.status, "rejected");
          if (corrected.status === "rejected")
            assert.match(
              String(corrected.reason),
              /An issued payroll filing retains history for this tax year/,
            );
          assert.ok(issued.value.file);
          assert.match(issued.value.file.body, /<empt_incamt>12000\.00<\/empt_incamt>/);
          assert.equal((await filingSubmissions(f.orgId, "CA", "t4", 2026)).length, 1);
          assert.deepEqual(
            await filingArtifact(f.orgId, issued.value.submission.id),
            issued.value.file,
          );
          assert.equal(
            (
              await readEmployeeOpeningLevySources(db, {
                orgId: f.orgId,
                employeePartyId: f.employeeId,
                taxYear: 2026,
              })
            ).authority?.authorityId,
            original.id,
          );
        } else {
          assert.equal(corrected.status, "fulfilled");
          assert.match(
            String(issued.reason),
            /current Canadian original reporting source is missing/,
          );
          assert.equal((await filingSubmissions(f.orgId, "CA", "t4", 2026)).length, 0);
          if (corrected.status === "fulfilled") {
            await qualifyCanadianOpeningReportingSource({
              ...reporting,
              requestId: randomUUID(),
              expectedLevyAuthorityId: corrected.value.id,
              expectedLevyAllocationSha256: corrected.value.allocationSha256,
            });
            assert.deepEqual(await t4Slips(f.orgId, 2026), slips);
            const freshIssue = await recordFilingIssue({
              orgId: f.orgId,
              actorId: f.actorId,
              country: "CA",
              filingKey: "t4",
              taxYear: 2026,
              revision: "original",
            });
            assert.ok(freshIssue.file);
            assert.match(freshIssue.file.body, /<empt_incamt>12000\.00<\/empt_incamt>/);
            assert.deepEqual(
              await filingArtifact(f.orgId, freshIssue.submission.id),
              freshIssue.file,
            );
          }
        }
        assert.deepEqual(
          await retainedSourceHistory(f, original.id, reportingAuthority.id),
          history,
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);
