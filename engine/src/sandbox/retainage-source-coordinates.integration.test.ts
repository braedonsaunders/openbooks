import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "../testing/fixtures.ts";
import { errorChainMatches } from "../testing/error-chain.ts";
import type { TableInfo } from "./catalog.ts";
import { generateCopySql, validateVendorRetainageSourceAllocations, type CloneOptions } from "./clone.ts";
import { createSandbox, deleteSandbox } from "./lifecycle.ts";

const sourceBill = "7f3dbb90-113c-4129-8270-e7a13879ed26";
const coordinates = [{ documentId: sourceBill, held: "10000000000000.0000", previousAmount: "0.1250", amount: "9007199254740.1250" }];
const options: CloneOptions = {
  productionOrgId: "65fa9dc7-228f-4e19-8bf1-17d52efeb78d", sandboxOrgId: "47df30a3-4fd1-4570-bb67-09641053ee3b",
  seed: "42b3d7dd-9674-4f3c-8d6a-8ba5d2308130", tier: "full", masked: false,
};

test("retainage allocation validation preserves exact coordinates and refuses malformed or unscoped source evidence", () => {
  const before = structuredClone(coordinates);
  const validate = (value: unknown, amount = coordinates[0]!.amount, bills = new Set([sourceBill])) =>
    validateVendorRetainageSourceAllocations(value, amount, bills, "Retainage release");
  validate(coordinates);
  validate([{ ...coordinates[0], documentId: sourceBill.toUpperCase() }]);
  validate(null);
  assert.deepEqual(coordinates, before);
  for (const value of [undefined, {}, [], [null], [{ documentId: sourceBill }],
    [{ ...coordinates[0], documentId: "unknown" }], [{ ...coordinates[0], held: 1 }],
    [{ ...coordinates[0], amount: "1e3" }], [{ ...coordinates[0], previousAmount: "-1" }],
    [{ ...coordinates[0], amount: "0.0000" }], [{ ...coordinates[0], previousAmount: coordinates[0]!.held }],
    [{ ...coordinates[0], extraDocumentId: sourceBill }], [coordinates[0], coordinates[0]]]) {
    assert.throws(() => validate(value), /sandbox clone: Retainage release:/);
  }
  assert.throws(() => validate(coordinates, "9007199254740.1249"), /source amounts do not equal the release amount/);
  assert.throws(() => validate(coordinates, coordinates[0]!.amount, new Set()), /no scoped counterpart/);
});

test("retainage INSERT rebases only source bill identities and requires documents in the copy plan", () => {
  const table: TableInfo = {
    name: "vendor_retainage_releases", hasId: true, hasOrgId: true,
    columns: ["id", "org_id", "amount", "source_bill_allocations"].map(name => ({
      name, isUuid: name === "id" || name === "org_id", isNullable: name === "source_bill_allocations",
      udtName: name === "source_bill_allocations" ? "jsonb" : name === "amount" ? "numeric" : "uuid",
    })), fks: {}, hardFks: {}, fkDeleteRules: {}, forceRebase: new Set(),
  };
  const rebase = new Set(["documents", table.name]);
  for (const masked of [false, true]) {
    const copy = generateCopySql(table, { ...options, masked }, rebase, new Set(), new Map(), null)!;
    assert.match(copy, /jsonb_set\(a.value, '\{documentId\}'/);
    assert.match(copy, /ob_rebase\(\(a.value->>'documentId'\)::uuid/);
    assert.match(copy, /order by a.ord/);
    assert.match(copy, /case when "source_bill_allocations" is null then null/);
    assert.ok(copy.includes(', "amount", (case'));
    assert.ok(!copy.includes("a.value->>'amount'"), "financial coordinates copy verbatim");
  }
  assert.throws(() => generateCopySql(table, options, new Set([table.name]), new Set(), new Map(), null), /require documents in the copy plan/);
  assert.throws(() => generateCopySql(table, { ...options, onlyTables: new Set([table.name]) }, rebase, new Set(), new Map(), null), /require documents in the copy plan/);
});

test("sandbox copy stores cloned retainage source bills with exact historical financial coordinates", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  let failure: unknown;
  try {
    const actorId = await createScratchUser(org.orgId, "Retainage sandbox owner", "admin");
    const projectId = randomUUID(), subcontractId = randomUUID();
    const bills = [randomUUID(), randomUUID()], releaseBill = randomUUID(), legacyBill = randomUUID();
    assert.equal((await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status)
      values(${projectId},${org.orgId},${org.subsidiaryId},'RETAINAGE-COPY','Recorded subcontract',${org.customerId},'active') returning id`)).rows.length, 1);
    assert.equal((await db.execute(sql`insert into subcontracts(id,org_id,project_id,vendor_id,number,title,currency,original_commitment,status)
      values(${subcontractId},${org.orgId},${projectId},${org.vendorId},'SC-COPY','Recorded subcontract','CAD','100000000000001.2490','active') returning id`)).rows.length, 1);
    for (const [index, id] of [...bills, releaseBill, legacyBill].entries()) {
      assert.equal((await db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,currency,status,party_id,project_id,subsidiary_id)
        values(${id},${org.orgId},'vendor_bill',${`COPY-${index}`},${org.date},'CAD','draft',${org.vendorId},${projectId},${org.subsidiaryId}) returning id`)).rows.length, 1);
    }
    for (const [index, bill] of bills.entries()) {
      const gross = index === 0 ? "100000000000000.0000" : "1.2500";
      const held = index === 0 ? "10000000000000.0000" : "0.1250";
      const net = index === 0 ? "90000000000000.0000" : "1.1250";
      assert.equal((await db.execute(sql`insert into vendor_pay_applications(org_id,subcontract_id,application_number,period_end,status,gross_this_period,retainage_this_period,net_due,vendor_bill_document_id)
        values(${org.orgId},${subcontractId},${index + 1},${org.date},'billed',${gross},${held},${net},${bill}) returning id`)).rows.length, 1);
    }
    const sources = [
      { documentId: bills[1]!, held: "0.1250", previousAmount: "0.0000", amount: "0.1249" },
      { documentId: bills[0]!.toUpperCase(), held: "10000000000000.0000", previousAmount: "0.1250", amount: "9007199254740.0001" },
    ];
    assert.equal((await db.execute(sql`insert into vendor_retainage_releases(org_id,subcontract_id,period_end,amount,vendor_bill_document_id,source_bill_allocations)
      values(${org.orgId},${subcontractId},${org.date},'9007199254740.1250',${releaseBill},${JSON.stringify(sources)}::jsonb),
        (${org.orgId},${subcontractId},${org.date},'1.0000',${legacyBill},null) returning id`)).rows.length, 2);
    const original = (await db.execute(sql`select to_jsonb(r) as row from vendor_retainage_releases r where org_id=${org.orgId} order by id`)).rows;
    const sandbox = await createSandbox({ productionOrgId: org.orgId, name: "Retainage coordinate copy", tier: "full", masked: false,
      createdBy: actorId, lifecycleAuthority: { actorId } });
    const copied = (await db.execute<{ amount: string; sources: typeof sources | null }>(sql`
      select amount::text as amount,source_bill_allocations as sources from vendor_retainage_releases where org_id=${sandbox.sandboxOrgId} order by amount desc`)).rows;
    assert.equal(copied.length, 2);
    const sourceToTarget = new Map((await db.execute<{ source_id: string; target_id: string }>(sql`
      select source.id as source_id, copied.id as target_id from documents source join orgs target on target.id=${sandbox.sandboxOrgId}
      join documents copied on copied.org_id=target.id and copied.id=ob_rebase(source.id,target.sandbox_seed)
      where source.org_id=${org.orgId} and source.id in (${bills[0]!},${bills[1]!})`)).rows.map(row => [row.source_id, row.target_id]));
    assert.equal(sourceToTarget.size, 2, "both referenced bills have native sandbox counterparts");
    assert.deepEqual(copied[0], { amount: "9007199254740.1250", sources: sources.map(source => ({ ...source, documentId: sourceToTarget.get(source.documentId.toLowerCase())! })) });
    assert.deepEqual(copied[1], { amount: "1.0000", sources: null });
    await assert.rejects(() => db.execute(sql`update vendor_retainage_releases set source_bill_allocations='[]'::jsonb
      where org_id=${sandbox.sandboxOrgId} and vendor_bill_document_id<>ob_rebase(${legacyBill}::uuid,(select sandbox_seed from orgs where id=${sandbox.sandboxOrgId}))`),
    error => errorChainMatches(error, /Retainage source allocations are immutable/));
    assert.deepEqual((await db.execute(sql`select to_jsonb(r) as row from vendor_retainage_releases r where org_id=${org.orgId} order by id`)).rows, original);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      for (const sandbox of (await db.execute<{ id: string }>(sql`select id from sandboxes where production_org_id=${org.orgId}`)).rows) {
        await deleteSandbox(sandbox.id, { systemReason: "Remove retainage coordinate fixture" });
      }
      await dropScratchOrgReporting(org.orgId);
    } catch (cleanupError) {
      if (failure) throw new AggregateError([failure, cleanupError], "Retainage coordinates and cleanup both failed", { cause: failure });
      throw cleanupError;
    }
  }
});
