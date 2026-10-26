import assert from "node:assert/strict";
import test from "node:test";
import { saveOpeningBalances } from "./opening-balances.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { db, withBypassContext, withOrgContext } from "../platform/db.ts";
import { sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { payRunStaleness } from "./readiness.ts";
import {
  payRunCalculationSource,
  payRunCalculationSourceDigest,
} from "./run-calculation-evidence.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import {
  dropScratchOrgReporting,
  seedPayrollSettings,
  grantScratchPermissions,
} from "../testing/fixtures.ts";
import { calculatedRun, seedAdoption, type AdoptionFixture } from "./filing-test-fixtures.ts";
import {
  qualifyOpeningEmployerAuthority,
  readOpeningEmployerContext,
} from "./opening-employer-authority.ts";
import {
  qualifyOpeningLevySourceAuthority,
  readOpeningLevySourceContext,
  type OpeningLevySourceAllocationInput,
} from "./opening-levy-source-authority.ts";
import { readEmployeeOpeningLevySources } from "./opening-levy-source-reader.ts";
import { employeeYtd } from "./canada/compute-statutory.ts";

async function qualifyCanadianOpening(fx: AdoptionFixture, amounts: Record<string, string>) {
  const allocations: OpeningLevySourceAllocationInput[] = [
    ...["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"].map(
      (region) => ({ programKey: "ca_wcb" as const, region, federalAccountId: null, amount: "0" }),
    ),
    ...["BC", "MB", "NL", "ON"].map((region) => ({
      programKey: "ca_eht" as const,
      region,
      federalAccountId: null,
      amount: "0",
    })),
    { programKey: "ca_cnt", region: "QC", federalAccountId: null, amount: "0" },
  ];
  const facts = {
    originalCountry: "CA",
    originalCurrency: "CAD",
    coverageStart: "2026-01-01",
    coverageEnd: "2026-06-30",
    coverageComplete: true as const,
  };
  const folderId = randomUUID(),
    sourceFileId = randomUUID(),
    sourceVersionId = randomUUID();
  const bytes = Buffer.from(
    JSON.stringify({
      employeePartyId: fx.employeeId,
      subsidiaryId: fx.subsidiaryId,
      taxYear: 2026,
      amounts,
      ...facts,
      allocations,
    }),
  );
  const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
  assert.equal(
    (
      await db.execute(
        sql`insert into folders(id,org_id,name,is_private,owner_id,created_by,updated_by)
    values(${folderId},${fx.orgId},'Original Canadian opening report',true,${fx.actorId},${fx.actorId},${fx.actorId}) returning id`,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`insert into files(id,org_id,folder_id,name,content_type,size_bytes,created_by,updated_by)
    values(${sourceFileId},${fx.orgId},${folderId},'original-opening.json','application/json',${bytes.length},${fx.actorId},${fx.actorId}) returning id`,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`insert into file_versions(id,file_id,version_number,size_bytes,content_type,content_hash,created_by)
    values(${sourceVersionId},${sourceFileId},1,${bytes.length},'application/json',${sourceSha256},${fx.actorId}) returning id`,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`insert into file_blobs(version_id,bytes)
    values(${sourceVersionId},${bytes}) returning version_id`,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`update files set current_version_id=${sourceVersionId}
    where org_id=${fx.orgId} and id=${sourceFileId} returning id`,
        "objects",
      )
    ).length,
    1,
  );
  const contextInput = {
    orgId: fx.orgId,
    actorId: fx.actorId,
    employeePartyId: fx.employeeId,
    taxYear: 2026,
    sourceFileId,
    allowedSubsidiaryIds: null,
  };
  const employer = await readOpeningEmployerContext(contextInput);
  const levy = await readOpeningLevySourceContext(contextInput);
  assert.ok(employer.record);
  assert.ok(levy.record);
  assert.ok(employer.source);
  assert.ok(levy.source);
  assert.equal(employer.record.id, levy.record.openingBalanceId);
  assert.equal(employer.source.sha256, sourceSha256);
  assert.equal(levy.source.versionId, sourceVersionId);
  const packet = {
    orgId: fx.orgId,
    actorId: fx.actorId,
    openingBalanceId: employer.record.id,
    expectedOpeningSha256: employer.record.openingSha256,
    expectedOpeningChildrenSha256: levy.record.openingChildrenSha256,
    sourceFileId,
    sourceVersionId,
    sourceSha256,
    ...facts,
    allocations,
    sourceReference: "Complete original Canadian statutory year-to-date report",
    reason: "Retain the original legal employer and complete statutory coverage",
    allowedSubsidiaryIds: null,
  };
  const employerAuthority = await qualifyOpeningEmployerAuthority({
    ...packet,
    subsidiaryId: fx.subsidiaryId,
  });
  const levyAuthority = await qualifyOpeningLevySourceAuthority(packet);
  return {
    ...packet,
    employerAuthorityId: employerAuthority.id,
    levyAuthorityId: levyAuthority.id,
  };
}

/**
 * Annual ceilings consume only qualified statutory carry-ins. Saving or
 * qualifying a carry-in after calculation requires fresh source evidence
 * before commit, and committed use preserves the original amounts.
 */
test(
  "a carry-in saved after calculation makes the run stale and refuses commit until recalculated",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fx = await withBypassContext(async () => {
      const fixture = await seedAdoption();
      await seedPayrollSettings(fixture.orgId, { features: { payroll: true } });
      await grantScratchPermissions(fixture.orgId, fixture.actorId, [
        "payroll.read",
        "payroll.run",
      ]);
      return fixture;
    });
    try {
      await withOrgContext(fx.orgId, async () => {
        const { input } = await calculatedRun(fx);
        assert.deepEqual((await payRunStaleness(fx.orgId, input.documentId)).reasons, []);

        const amounts = { pensionableYtd: "60000.00", insurableYtd: "0", cppYtd: "3500.00" };
        const saved = await saveOpeningBalances({
          orgId: fx.orgId,
          actorId: fx.actorId,
          taxYear: 2026,
          rows: [
            {
              employeePartyId: fx.employeeId,
              amounts,
              components: {},
            },
          ],
        });
        assert.deepEqual(saved.errors, []);

        const stale = await payRunStaleness(fx.orgId, input.documentId);
        assert.ok(stale.stale);
        assert.deepEqual(stale.reasons, ["openingBalances"]);
        await assert.rejects(commitPayRun(input), /openingBalances/);

        const refused = await calculatePayRun(input);
        assert.equal(refused.employees, 0);
        assert.equal(refused.errors.length, 1);
        assert.equal(refused.errors[0]!.employeePartyId, fx.employeeId);
        assert.equal(refused.errors[0]!.kind, "refusal");
        assert.match(refused.errors[0]!.message, /opening.*(source|legal-employer|qualif)/i);
        assert.equal(
          (
            await db.execute(
              sql`select id from pay_stubs
          where org_id=${fx.orgId} and pay_run_document_id=${input.documentId}`,
              "objects",
            )
          ).length,
          0,
        );
        await assert.rejects(commitPayRun(input), /refused|no calculated stubs/);
        assert.deepEqual(
          await db.execute<{ status: string }>(
            sql`select run_status as status from pay_runs
          where org_id=${fx.orgId} and document_id=${input.documentId}`,
            "objects",
          ),
          [{ status: "calculated" }],
        );

        const packet = await qualifyCanadianOpening(fx, amounts);
        assert.ok(
          (await payRunStaleness(fx.orgId, input.documentId)).reasons.includes("openingBalances"),
        );
        await assert.rejects(commitPayRun(input), /openingBalances/);
        const original = await readEmployeeOpeningLevySources(db, {
          orgId: fx.orgId,
          employeePartyId: fx.employeeId,
          taxYear: 2026,
          subsidiaryId: fx.subsidiaryId,
        });
        assert.equal(original.authority?.sourceVersionId, packet.sourceVersionId);
        assert.equal(original.authority?.sourceSha256, packet.sourceSha256);
        assert.equal(original.authority?.openingSha256, packet.expectedOpeningSha256);
        assert.equal(original.openingSnapshot?.pensionable_ytd, "60000.0000");
        assert.equal(original.openingSnapshot?.insurable_ytd, "0.0000");
        assert.equal(original.openingSnapshot?.cpp_ytd, "3500.0000");
        const annual = await employeeYtd({
          tx: db,
          orgId: fx.orgId,
          employeePartyId: fx.employeeId,
          taxYear: 2026,
          documentId: input.documentId,
          subsidiaryId: fx.subsidiaryId,
        });
        assert.equal(annual.pensionable, "60000.0000");
        assert.equal(annual.insurable, "0.0000");
        assert.equal(annual.cpp, "3500.0000");

        // Recalculation consumes the original source; commit then locks its carry-in.
        assert.deepEqual((await calculatePayRun(input)).errors, []);
        const calculationSource = await payRunCalculationSource(fx.orgId, input.documentId);
        assert.ok(calculationSource);
        assert.equal(
          calculationSource.openingEmployerAuthorities?.[0]?.id,
          packet.employerAuthorityId,
        );
        assert.equal(
          calculationSource.openingLevySourceAuthorities?.[0]?.id,
          packet.levyAuthorityId,
        );
        assert.equal(
          calculationSource.openingLevySourceAuthorities?.[0]?.sourceVersionId,
          packet.sourceVersionId,
        );
        assert.equal(
          calculationSource.openingLevySourceAuthorities?.[0]?.sourceSha256,
          packet.sourceSha256,
        );
        assert.equal(
          calculationSource.openingLevySourceAuthorities?.[0]?.openingSha256,
          packet.expectedOpeningSha256,
        );
        assert.equal(
          calculationSource.openingLevySourceAuthorities?.[0]?.openingChildrenSha256,
          packet.expectedOpeningChildrenSha256,
        );
        assert.deepEqual((await payRunStaleness(fx.orgId, input.documentId)).reasons, []);
        await commitPayRun(input);

        // The committed run now locks the carry-in it consumed.
        await assert.rejects(
          saveOpeningBalances({
            orgId: fx.orgId,
            actorId: fx.actorId,
            taxYear: 2026,
            rows: [
              {
                employeePartyId: fx.employeeId,
                amounts: { pensionableYtd: "1.00", insurableYtd: "0", cppYtd: "0" },
                components: {},
              },
            ],
          }),
          /already used this carry-in for 2026/,
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(fx.orgId));
    }
  },
);

test(
  "opening-balance save rechecks employee scope after a committed rehome",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fx = await seedAdoption();
    try {
      const movedTo = randomUUID();
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        values (${movedTo}, ${fx.orgId}, ${fx.subsidiaryId}, 'Opening balance rehome target', 'CAD', 'CA')
      `);
      await db.execute(
        sql`update parties set subsidiary_id = ${fx.subsidiaryId} where org_id = ${fx.orgId} and id = ${fx.employeeId}`,
      );
      const precheck = (
        await db.execute<{ subsidiary_id: string | null }>(
          sql`
        select subsidiary_id from parties where org_id = ${fx.orgId} and id = ${fx.employeeId}
      `,
          "objects",
        )
      )[0];
      assert.equal(
        precheck?.subsidiary_id,
        fx.subsidiaryId,
        "the route precheck sees the employee in scope",
      );

      // Both statements autocommit: the move lands after the precheck and
      // before the service's own write transaction, with no outer test txn.
      await db.execute(
        sql`update parties set subsidiary_id = ${movedTo} where org_id = ${fx.orgId} and id = ${fx.employeeId}`,
      );
      await assert.rejects(
        saveOpeningBalances({
          orgId: fx.orgId,
          actorId: fx.actorId,
          taxYear: 2026,
          rows: [
            {
              employeePartyId: fx.employeeId,
              amounts: { pensionableYtd: "60000", insurableYtd: "0" },
            },
          ],
          allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
        }),
        (error: unknown) => error instanceof ScopeNotFoundError,
      );
      const stored = await db.execute(
        sql`
        select 1 from payroll_opening_balances where org_id = ${fx.orgId} and employee_party_id = ${fx.employeeId}
      `,
        "objects",
      );
      assert.equal(stored.length, 0, "the out-of-scope carry-in writes no balance row");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

/**
 * A refused employee has no stub on the run. Correcting the carry-in the
 * refusal names must still make the run stale, or Recalculate never appears
 * and the remedy is unreachable.
 */
test(
  "a carry-in saved for an employee the calculation refused makes the run stale",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fx = await seedAdoption();
    try {
      const { input } = await calculatedRun(fx);
      // The stored outcome of a refused employee: a recorded refusal, no stub.
      await db.execute(sql`
        delete from pay_stub_lines where org_id = ${fx.orgId} and stub_id in (
          select id from pay_stubs where org_id = ${fx.orgId} and pay_run_document_id = ${input.documentId})`);
      const removed = await db.execute(
        sql`
        delete from pay_stubs where org_id = ${fx.orgId} and pay_run_document_id = ${input.documentId} returning id`,
        "objects",
      );
      assert.equal(removed.length, 1);
      await db.execute(sql`
        update pay_runs set calculation_errors = ${JSON.stringify([
          {
            employeePartyId: fx.employeeId,
            employee: "Refused employee",
            kind: "refusal",
            message: "prior insurable wages need a state allocation",
          },
        ])}::jsonb
         where org_id = ${fx.orgId} and document_id = ${input.documentId}`);
      // Re-record the calculation's source evidence for the refused outcome,
      // as the calculation itself does, so only the carry-in can stale it.
      const source = await payRunCalculationSource(fx.orgId, input.documentId);
      assert.ok(source);
      await db.execute(sql`
        update pay_runs set calculation_source_snapshot = ${JSON.stringify(source)}::jsonb,
               calculation_source_digest = ${payRunCalculationSourceDigest(source)}
         where org_id = ${fx.orgId} and document_id = ${input.documentId}`);
      assert.deepEqual((await payRunStaleness(fx.orgId, input.documentId)).reasons, []);

      const saved = await saveOpeningBalances({
        orgId: fx.orgId,
        actorId: fx.actorId,
        taxYear: 2026,
        rows: [
          {
            employeePartyId: fx.employeeId,
            amounts: { pensionableYtd: "60000.00", insurableYtd: "60000.00", cppYtd: "3500.00" },
            components: {},
          },
        ],
      });
      assert.deepEqual(saved.errors, []);
      const stale = await payRunStaleness(fx.orgId, input.documentId);
      assert.ok(stale.stale, "the corrected refusal is recalculable");
      assert.ok(stale.reasons.includes("openingBalances"));
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
