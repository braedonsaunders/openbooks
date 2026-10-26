import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { BUILTIN_PROJECT_TYPES } from "@openbooks/schema";
import { installEngineSeams } from "../composition/install.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { postDocument } from "../ledger/posting-document.ts";
import {
  createSubcontract,
  addSubcontractSovLine,
  submitSubcontract,
  createVendorPayApplication,
  updateVendorPayApplicationLines,
  submitVendorPayApplication,
  generateVendorPayApplicationBill,
  releaseVendorRetainage,
} from "../projects/subcontracts.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
  grantScratchPermissions,
} from "../testing/fixtures.ts";
import { errorChainMatches } from "../testing/error-chain.ts";
import type { TableInfo } from "./catalog.ts";
import {
  generateCopySql,
  validateVendorRetainageSourceAllocations,
  type CloneOptions,
} from "./clone.ts";
import { createSandbox, deleteSandbox } from "./lifecycle.ts";

const sourceBill = "7f3dbb90-113c-4129-8270-e7a13879ed26";
const coordinates = [
  {
    documentId: sourceBill,
    held: "10000000000000.0000",
    previousAmount: "0.1250",
    amount: "9007199254740.1250",
  },
];
const options: CloneOptions = {
  productionOrgId: "65fa9dc7-228f-4e19-8bf1-17d52efeb78d",
  sandboxOrgId: "47df30a3-4fd1-4570-bb67-09641053ee3b",
  seed: "42b3d7dd-9674-4f3c-8d6a-8ba5d2308130",
  tier: "full",
  masked: false,
};

test("retainage allocation validation preserves exact coordinates and refuses malformed or unscoped source evidence", () => {
  const before = structuredClone(coordinates);
  const validate = (
    value: unknown,
    amount = coordinates[0]!.amount,
    bills = new Set([sourceBill]),
  ) => validateVendorRetainageSourceAllocations(value, amount, bills, "Retainage release");
  validate(coordinates);
  validate([{ ...coordinates[0], documentId: sourceBill.toUpperCase() }]);
  validate(null);
  assert.deepEqual(coordinates, before);
  for (const value of [
    undefined,
    {},
    [],
    [null],
    [{ documentId: sourceBill }],
    [{ ...coordinates[0], documentId: "unknown" }],
    [{ ...coordinates[0], held: 1 }],
    [{ ...coordinates[0], amount: "1e3" }],
    [{ ...coordinates[0], previousAmount: "-1" }],
    [{ ...coordinates[0], amount: "0.0000" }],
    [{ ...coordinates[0], previousAmount: coordinates[0]!.held }],
    [{ ...coordinates[0], extraDocumentId: sourceBill }],
    [coordinates[0], coordinates[0]],
  ]) {
    assert.throws(() => validate(value), /sandbox clone: Retainage release:/);
  }
  assert.throws(
    () => validate(coordinates, "9007199254740.1249"),
    /source amounts do not equal the release amount/,
  );
  assert.throws(
    () => validate(coordinates, coordinates[0]!.amount, new Set()),
    /no scoped counterpart/,
  );
});

test("retainage INSERT rebases only source bill identities and requires documents in the copy plan", () => {
  const table: TableInfo = {
    name: "vendor_retainage_releases",
    hasId: true,
    hasOrgId: true,
    columns: ["id", "org_id", "amount", "source_bill_allocations"].map((name) => ({
      name,
      isUuid: name === "id" || name === "org_id",
      isNullable: name === "source_bill_allocations",
      udtName:
        name === "source_bill_allocations" ? "jsonb" : name === "amount" ? "numeric" : "uuid",
    })),
    fks: {},
    hardFks: {},
    fkDeleteRules: {},
    forceRebase: new Set(),
  };
  const rebase = new Set(["documents", table.name]);
  for (const masked of [false, true]) {
    const copy = generateCopySql(
      table,
      { ...options, masked },
      rebase,
      new Set(),
      new Map(),
      null,
    )!;
    assert.match(copy, /jsonb_set\(a.value, '\{documentId\}'/);
    assert.match(copy, /ob_rebase\(\(a.value->>'documentId'\)::uuid/);
    assert.match(copy, /order by a.ord/);
    assert.match(copy, /case when "source_bill_allocations" is null then null/);
    assert.ok(copy.includes(', "amount", (case'));
    assert.ok(!copy.includes("a.value->>'amount'"), "financial coordinates copy verbatim");
  }
  assert.throws(
    () => generateCopySql(table, options, new Set([table.name]), new Set(), new Map(), null),
    /require documents in the copy plan/,
  );
  assert.throws(
    () =>
      generateCopySql(
        table,
        { ...options, onlyTables: new Set([table.name]) },
        rebase,
        new Set(),
        new Map(),
        null,
      ),
    /require documents in the copy plan/,
  );
});

test(
  "sandbox copy stores cloned retainage source bills with exact historical financial coordinates",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await createScratchOrg();
    let failure: unknown;
    try {
      installEngineSeams();
      const actorId = await createScratchUser(org.orgId, "Retainage sandbox owner", "admin");
      await grantScratchPermissions(org.orgId, actorId, ["ap.create"]);
      const projectId = randomUUID(),
        typeId = randomUUID();
      const profile = BUILTIN_PROJECT_TYPES.find((row) => row.key === "schedule_of_values")!;
      await db.execute(sql`update orgs set settings=jsonb_set(
      jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"projects":true,"subcontracts":true}'::jsonb),
      '{controlAccounts}',coalesce(settings->'controlAccounts','{}'::jsonb)||jsonb_build_object('retainagePayable',${org.accounts.deferred}::text)) where id=${org.orgId}`);
      await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
      values(${typeId},${org.orgId},'retainage_copy','Retainage copy','fixed_price',${JSON.stringify(profile.invoicingProfile)}::jsonb,${JSON.stringify(profile.backupProfile)}::jsonb)`);
      await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
      values(${org.orgId},${typeId},'2000-01-01',${JSON.stringify(profile.financialProfile)}::jsonb,'Retainage copy policy')`);
      await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status)
      values(${projectId},${org.orgId},${org.subsidiaryId},'RETAINAGE-COPY','Recorded subcontract',${org.customerId},${typeId},'active')`);
      await db.execute(
        sql`insert into vendor_roles(org_id,party_id) values(${org.orgId},${org.vendorId})`,
      );
      const transact = <T>(work: () => Promise<T>) => withOrgTransaction(org.orgId, work);
      const { id: subcontractId } = await transact(() =>
        createSubcontract({
          orgId: org.orgId,
          userId: actorId,
          projectId,
          vendorId: org.vendorId,
          number: "SC-COPY",
          title: "Recorded subcontract",
          originalCommitment: "100000000000001.25",
        }),
      );
      const { id: sovLineId } = await transact(() =>
        addSubcontractSovLine({
          orgId: org.orgId,
          userId: actorId,
          subcontractId,
          description: "Work",
          scheduledValue: "100000000000001.25",
          expenseAccountId: org.accounts.cogs,
        }),
      );
      await transact(() => submitSubcontract(org.orgId, actorId, subcontractId));
      const postBill = async (id: string) => {
        await transact(async () => {
          assert.equal(
            (await submitAndReleaseIfUngated("vendor_bill", id, actorId)).autoApproved,
            true,
          );
          await postDocument(
            id,
            { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } },
            { audit: { actorId, source: "test" } },
          );
        });
      };
      const bills: string[] = [];
      for (const [date, work] of [
        [org.date, "100000000000000.00"],
        ["2026-07-16", "1.25"],
      ] as const) {
        const app = await transact(() =>
          createVendorPayApplication({
            orgId: org.orgId,
            userId: actorId,
            subcontractId,
            periodEnd: date,
          }),
        );
        await transact(() =>
          updateVendorPayApplicationLines({
            orgId: org.orgId,
            userId: actorId,
            payApplicationId: app.id,
            expectedRevision: 1,
            lines: [{ sovLineId, workCompletedThisPeriod: work, materialsStoredCurrent: "0" }],
          }),
        );
        await transact(() => submitVendorPayApplication(org.orgId, actorId, app.id));
        const generated = await transact(() =>
          generateVendorPayApplicationBill(org.orgId, actorId, app.id),
        );
        await postBill(generated.vendorBillDocumentId);
        bills.push(generated.vendorBillDocumentId);
      }
      for (const amount of ["0.13", "9999999999999.99"])
        await transact(() =>
          releaseVendorRetainage({
            orgId: org.orgId,
            userId: actorId,
            subcontractId,
            periodEnd: "2026-07-17",
            amount,
          }),
        );
      type Allocation = {
        documentId: string;
        held: string;
        previousAmount: string;
        amount: string;
      };
      const expected = await db.execute<{ amount: string; sources: Allocation[] }>(
        sql`select amount::text as amount,
      source_bill_allocations as sources from vendor_retainage_releases where org_id=${org.orgId} order by amount desc`,
        "objects",
      );
      assert.equal(expected.length, 2);
      assert.deepEqual(expected[0], {
        amount: "9999999999999.9900",
        sources: [
          {
            documentId: bills[0]!,
            held: "10000000000000.0000",
            previousAmount: "0.1300",
            amount: "9999999999999.8700",
          },
          { documentId: bills[1]!, held: "0.1300", previousAmount: "0.0000", amount: "0.1200" },
        ],
      });
      const original = await db.execute(
        sql`select to_jsonb(r) as row from vendor_retainage_releases r where org_id=${org.orgId} order by id`,
        "objects",
      );
      const sandbox = await createSandbox({
        productionOrgId: org.orgId,
        name: "Retainage coordinate copy",
        tier: "full",
        masked: false,
        createdBy: actorId,
        lifecycleAuthority: { actorId },
      });
      const copied = await db.execute<{ amount: string; sources: Allocation[] }>(
        sql`
      select amount::text as amount,source_bill_allocations as sources from vendor_retainage_releases where org_id=${sandbox.sandboxOrgId} order by amount desc`,
        "objects",
      );
      assert.equal(copied.length, 2);
      const sourceToTarget = new Map(
        (
          await db.execute<{ source_id: string; target_id: string }>(
            sql`
      select source.id as source_id, copied.id as target_id from documents source join orgs target on target.id=${sandbox.sandboxOrgId}
      join documents copied on copied.org_id=target.id and copied.id=ob_rebase(source.id,target.sandbox_seed)
      where source.org_id=${org.orgId} and source.id in (${bills[0]!},${bills[1]!})`,
            "objects",
          )
        ).map((row) => [row.source_id, row.target_id]),
      );
      assert.equal(
        sourceToTarget.size,
        2,
        "both referenced bills have native sandbox counterparts",
      );
      assert.deepEqual(
        copied,
        expected.map((row) => ({
          ...row,
          sources: row.sources.map((source) => ({
            ...source,
            documentId: sourceToTarget.get(source.documentId.toLowerCase())!,
          })),
        })),
      );
      await assert.rejects(
        () =>
          db.execute(sql`update vendor_retainage_releases set source_bill_allocations='[]'::jsonb
      where org_id=${sandbox.sandboxOrgId}`),
        (error) => errorChainMatches(error, /Retainage source allocations are immutable/),
      );
      assert.deepEqual(
        await db.execute(
          sql`select to_jsonb(r) as row from vendor_retainage_releases r where org_id=${org.orgId} order by id`,
          "objects",
        ),
        original,
      );
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      try {
        for (const sandbox of await db.execute<{ id: string }>(
          sql`select id from sandboxes where production_org_id=${org.orgId}`,
          "objects",
        )) {
          await deleteSandbox(sandbox.id, { systemReason: "Remove retainage coordinate fixture" });
        }
        await dropScratchOrgReporting(org.orgId);
      } catch (cleanupError) {
        if (failure)
          throw new AggregateError(
            [failure, cleanupError],
            "Retainage coordinates and cleanup both failed",
            { cause: failure },
          );
        throw cleanupError;
      }
    }
  },
);
