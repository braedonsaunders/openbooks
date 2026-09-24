import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { evaluateBillsForRelease } from "./compliance.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * End-to-end proof that the project's recorded site drives lien-waiver
 * coverage: the sites map in evaluateBillsForRelease feeds the evaluator,
 * so a same-state signed waiver releases the bill, a wrong-state one is
 * refused by name, and an unrecorded site fails closed as unevaluable.
 */

async function fixture(siteJurisdiction: string | null) {
  const org = await createScratchOrg();
  await db.execute(sql`update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,subcontractorCompliance}', 'true'::jsonb) where id = ${org.orgId}`);
  const classId = randomUUID();
  const vendorId = randomUUID();
  const projectId = randomUUID();
  await db.execute(sql`insert into compliance_classes (id, org_id, code, name, is_active, lien_waiver_enforcement, default_lien_waiver_type, created_by)
    values (${classId}, ${org.orgId}, 'SUB', 'Subcontractors', true, 'block', 'conditional_progress', ${org.orgId})`);
  await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, created_by)
    values (${vendorId}, ${org.orgId}, 'vendor', 'Site vendor', ${org.subsidiaryId}, ${org.orgId})`);
  await db.execute(sql`insert into vendor_roles (org_id, party_id, ap_account_id, compliance_class_id, is_active, created_by)
    values (${org.orgId}, ${vendorId}, ${org.accounts.ap}, ${classId}, true, ${org.orgId})`);
  await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, status, is_active, site_jurisdiction, custom)
    values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'SITE', 'Site project', 'active', true, ${siteJurisdiction}, '{}'::jsonb)`);
  return { org, vendorId, projectId };
}

async function signWaiver(orgId: string, vendorId: string, projectId: string, jurisdiction: string | null) {
  const waiverId = randomUUID();
  await db.execute(sql`insert into lien_waivers
    (id, org_id, waiver_number, direction, party_id, project_id, waiver_type, status,
     through_date, amount, currency, jurisdiction, signed_at, signed_by_name, created_by, updated_by)
    values (${waiverId}, ${orgId}, ${`LW-${waiverId.slice(0, 8)}`}, 'received', ${vendorId}, ${projectId},
      'conditional_progress', 'signed', '2026-12-31', '100.0000', 'USD', ${jurisdiction},
      '2026-06-15T00:00:00Z', 'Site Signatory', ${orgId}, ${orgId})`);
  return waiverId;
}

const billFor = (vendorId: string, projectId: string) => ({
  documentId: randomUUID(),
  documentNumber: "BILL-SITE-1",
  partyId: vendorId,
  vendorName: "Site vendor",
  projectId,
  documentDate: "2026-06-30",
  amount: "100",
  currency: "USD",
});

test("a same-state signed waiver releases the bill end to end", { skip: !DB }, async () => {
  const { org, vendorId, projectId } = await fixture("US-CA");
  try {
    await signWaiver(org.orgId, vendorId, projectId, "US-CA");
    const [decision] = await evaluateBillsForRelease({
      orgId: org.orgId,
      bills: [billFor(vendorId, projectId)],
      asOf: "2026-06-30",
    });
    assert.equal(decision!.lienWaiver.reason, "covered");
    assert.equal(decision!.lienWaiver.covered, true);
    assert.equal(decision!.decision, "cleared");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a wrong-state waiver is refused by name end to end", { skip: !DB }, async () => {
  const { org, vendorId, projectId } = await fixture("US-CA");
  try {
    await signWaiver(org.orgId, vendorId, projectId, "US-NY");
    const [decision] = await evaluateBillsForRelease({
      orgId: org.orgId,
      bills: [billFor(vendorId, projectId)],
      asOf: "2026-06-30",
    });
    assert.equal(decision!.lienWaiver.covered, false);
    assert.equal(decision!.lienWaiver.reason, "jurisdiction_mismatch");
    assert.equal(decision!.decision, "blocked");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an unrecorded project site fails closed as unevaluable end to end", { skip: !DB }, async () => {
  const { org, vendorId, projectId } = await fixture(null);
  try {
    await signWaiver(org.orgId, vendorId, projectId, "US-CA");
    const [decision] = await evaluateBillsForRelease({
      orgId: org.orgId,
      bills: [billFor(vendorId, projectId)],
      asOf: "2026-06-30",
    });
    assert.equal(decision!.lienWaiver.covered, false);
    assert.equal(decision!.lienWaiver.reason, "unevaluable");
    assert.equal(decision!.decision, "blocked");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
