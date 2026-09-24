import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { computeTaxReturn, TaxReturnError } from "./return.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

// A registration pairing a jurisdiction with a form from another
// jurisdiction (a Canadian jurisdiction with US_NY_ST100) used to save, and
// the resolve matched form+window only — so the New York return printed the
// Canadian registration number. The write path now refuses the pair at save;
// a legacy mismatched row refuses here, at resolve, by name — pinned or not.

const DB = !!process.env.OPENBOOKS_DB_URL;

const FORM = "US_NY_ST100";

async function seedForm(orgId: string): Promise<void> {
  await db.execute(sql`
    insert into tax_return_forms (id, org_id, code, name, submission_channel, is_active)
    values (${randomUUID()}, ${orgId}, ${FORM}, 'NY ST-100 probe', 'portal_manual', true)`);
  await db.execute(sql`
    insert into tax_report_lines
      (id, org_id, report_code, line_code, label, tax_code_id, basis, sign, sequence)
    values (${randomUUID()}, ${orgId}, ${FORM}, '1', 'Probe box', null, null, 1, 10)`);
}

async function seedJurisdiction(orgId: string, code: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into tax_jurisdictions (id, org_id, code, name, country, level, tax_type)
    values (${id}, ${orgId}, ${code}, ${code}, 'XX', 'state', 'sales_use')`);
  return id;
}

async function seedRegistration(orgId: string, jurisdictionId: string, number: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into tax_registrations
      (id, org_id, jurisdiction_id, registration_number, filing_frequency, return_form_code, is_active)
    values (${id}, ${orgId}, ${jurisdictionId}, ${number}, 'quarterly', ${FORM}, true)`);
  return id;
}

test("a legacy mismatched registration is refused at resolve, unpinned", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await seedForm(org.orgId);
    const caId = await seedJurisdiction(org.orgId, "CA");
    await seedRegistration(org.orgId, caId, "CA-REG-1");
    await assert.rejects(
      computeTaxReturn(org.orgId, FORM, org.date, org.date),
      (e: unknown) => {
        assert.ok(e instanceof TaxReturnError);
        assert.match(e.message, /CA-REG-1/);
        assert.match(e.message, /"CA"/);
        assert.match(e.message, /US_NY_ST100/);
        assert.match(e.message, /US-NY/);
        return true;
      },
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a legacy mismatched registration is refused at resolve, pinned", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await seedForm(org.orgId);
    const caId = await seedJurisdiction(org.orgId, "CA");
    const regId = await seedRegistration(org.orgId, caId, "CA-REG-1");
    await assert.rejects(
      computeTaxReturn(org.orgId, FORM, org.date, org.date, {}, {
        filingEntity: { subsidiaryIds: [org.subsidiaryId], registrationId: regId },
      }),
      (e: unknown) => {
        assert.ok(e instanceof TaxReturnError);
        assert.match(e.message, /CA-REG-1/);
        assert.match(e.message, /US-NY/);
        return true;
      },
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a registration in the form's own jurisdiction still resolves", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await seedForm(org.orgId);
    const nyId = await seedJurisdiction(org.orgId, "US-NY");
    await seedRegistration(org.orgId, nyId, "NY-REG-1");
    const result = await computeTaxReturn(org.orgId, FORM, org.date, org.date);
    assert.equal(result.registrationNumber, "NY-REG-1");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a registration on a tenant-defined form keeps the historical pick", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const custom = "CUSTOM-PROBE";
    await db.execute(sql`
      insert into tax_return_forms (id, org_id, code, name, submission_channel, is_active)
      values (${randomUUID()}, ${org.orgId}, ${custom}, 'Custom probe', 'portal_manual', true)`);
    await db.execute(sql`
      insert into tax_report_lines
        (id, org_id, report_code, line_code, label, tax_code_id, basis, sign, sequence)
      values (${randomUUID()}, ${org.orgId}, ${custom}, '1', 'Probe box', null, null, 1, 10)`);
    const caId = await seedJurisdiction(org.orgId, "CA");
    const regId = randomUUID();
    await db.execute(sql`
      insert into tax_registrations
        (id, org_id, jurisdiction_id, registration_number, filing_frequency, return_form_code, is_active)
      values (${regId}, ${org.orgId}, ${caId}, 'CA-CUSTOM-1', 'quarterly', ${custom}, true)`);
    const result = await computeTaxReturn(org.orgId, custom, org.date, org.date);
    assert.equal(result.registrationNumber, "CA-CUSTOM-1");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
