import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from "../testing/fixtures.ts";
import {
  freezeTaxYearWindowEvidence,
  insertTaxYearWindow,
  taxYearWindowDeleteProblem,
  taxYearWindowEvidence,
  taxYearWindowSubsidiaryProblem,
  taxYearWindowWriteProblem,
} from "./macrs-calendar.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("gate off accepts the company's sole legal entity and refuses another", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { adminId } = await seedFlowActors(org.orgId);
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(
           coalesce(settings, '{}'::jsonb),
           '{features}',
           coalesce(settings->'features', '{}'::jsonb) || '{"multiSubsidiary":false}'::jsonb
         )
       where id=${org.orgId}`);
    const child = randomUUID();
    await db.execute(sql`
      insert into subsidiaries(id, org_id, parent_id, name, base_currency, country, is_elimination, is_active)
      values (${child}, ${org.orgId}, ${org.subsidiaryId}, 'Other plant', 'CAD', 'CA', false, true)`);
    const elimination = randomUUID();
    await db.execute(sql`
      insert into subsidiaries(id, org_id, parent_id, name, base_currency, country, is_elimination, is_active)
      values (${elimination}, ${org.orgId}, ${org.subsidiaryId}, 'Elim', 'CAD', 'CA', true, true)`);

    assert.equal(await taxYearWindowSubsidiaryProblem(db, org.orgId, org.subsidiaryId), null);
    assert.match(
      await taxYearWindowSubsidiaryProblem(db, org.orgId, child) ?? "",
      /company's legal entity/,
    );
    assert.match(
      await taxYearWindowSubsidiaryProblem(db, org.orgId, elimination) ?? "",
      /elimination/,
    );
    assert.match(
      await taxYearWindowSubsidiaryProblem(db, org.orgId, null) ?? "",
      /must name the legal entity/,
    );
    assert.match(
      await taxYearWindowSubsidiaryProblem(db, org.orgId, randomUUID()) ?? "",
      /active legal entity/,
    );

    const accepted = await insertTaxYearWindow(db, org.orgId, adminId, {
      subsidiaryId: org.subsidiaryId,
      regime: "us_macrs",
      yearStart: "2024-01-01",
      yearEnd: "2024-03-31",
      filingYear: 2024,
      reason: "short year after year-end change",
    });
    assert.equal(accepted.filingYear, 2024);
    const second = await insertTaxYearWindow(db, org.orgId, adminId, {
      subsidiaryId: org.subsidiaryId,
      regime: "us_macrs",
      yearStart: "2024-04-01",
      yearEnd: "2024-12-31",
      filingYear: 2024,
      reason: "remainder of the year after the short year",
    });
    assert.equal(second.filingYear, 2024);
    assert.notEqual(second.id, accepted.id);

    assert.match(
      await taxYearWindowWriteProblem(db, org.orgId, {
        subsidiaryId: child,
        regime: "us_macrs",
        yearStart: "2025-01-01",
        yearEnd: "2025-12-31",
        filingYear: 2025,
        reason: "calendar-year tax window",
      }) ?? "",
      /company's legal entity/,
    );
    assert.match(
      await taxYearWindowWriteProblem(db, org.orgId, {
        subsidiaryId: org.subsidiaryId,
        regime: "us_macrs",
        yearStart: "2024-03-01",
        yearEnd: "2024-06-30",
        filingYear: 2024,
        reason: "overlapping invented year",
      }) ?? "",
      /overlap/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("gate on accepts another active non-elimination entity in the same org", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { adminId } = await seedFlowActors(org.orgId);
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(
           coalesce(settings, '{}'::jsonb),
           '{features}',
           coalesce(settings->'features', '{}'::jsonb) || '{"multiSubsidiary":true}'::jsonb
         )
       where id=${org.orgId}`);
    const child = randomUUID();
    await db.execute(sql`
      insert into subsidiaries(id, org_id, parent_id, name, base_currency, country, is_elimination, is_active)
      values (${child}, ${org.orgId}, ${org.subsidiaryId}, 'Other plant', 'CAD', 'CA', false, true)`);
    assert.equal(await taxYearWindowSubsidiaryProblem(db, org.orgId, child), null);
    const window = await insertTaxYearWindow(db, org.orgId, adminId, {
      subsidiaryId: child,
      regime: "ca_cca",
      yearStart: "2024-01-01",
      yearEnd: "2024-12-31",
      filingYear: 2024,
      reason: "calendar-year tax window",
    });
    assert.equal(window.subsidiaryId, child);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("tax year window refusals name a supported correction, not a reversal", () => {
  const calendar = readFileSync(new URL("./macrs-calendar.ts", import.meta.url), "utf8");
  const poolRun = readFileSync(new URL("./pool-run.ts", import.meta.url), "utf8");
  assert.match(calendar, /there is no reversal of a computed tax year/);
  assert.match(calendar, /delete this unused window on Fixed Assets tax-year setup/);
  assert.match(calendar, /Re-run that same year from Fixed Assets tax pools/);
  assert.doesNotMatch(calendar, /reverse those years|reverse and declare/);
  assert.doesNotMatch(poolRun, /removing the later years/);
  assert.match(poolRun, /an earlier year cannot be restated after a later result exists/);
});

test("tax year window evidence is sorted, distinct, and refuses an unlabeled window", () => {
  const first = taxYearWindowEvidence({
    id: "11111111-1111-4111-8111-111111111111",
    subsidiaryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    regime: "us_macrs",
    taxYear: 2024,
    yearStart: "2024-07-01",
    yearEnd: "2024-12-31",
  });
  const second = taxYearWindowEvidence({
    id: "22222222-2222-4222-8222-222222222222",
    subsidiaryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    regime: "us_macrs",
    taxYear: 2024,
    yearStart: "2024-01-01",
    yearEnd: "2024-06-30",
  });
  assert.deepEqual(
    freezeTaxYearWindowEvidence([first, second, first]).map((row) => row.id),
    [second.id, first.id],
  );
  assert.throws(
    () => taxYearWindowEvidence({
      taxYear: 2024,
      yearStart: "2024-01-01",
      yearEnd: "2024-12-31",
    }),
    /registered id/,
  );
});

test("cited window dates stay frozen; unused windows may be deleted", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { adminId } = await seedFlowActors(org.orgId);
    const unused = await insertTaxYearWindow(db, org.orgId, adminId, {
      subsidiaryId: org.subsidiaryId,
      regime: "us_macrs",
      yearStart: "2024-01-01",
      yearEnd: "2024-03-31",
      filingYear: 2024,
      reason: "short year after year-end change",
    });
    const cited = await insertTaxYearWindow(db, org.orgId, adminId, {
      subsidiaryId: org.subsidiaryId,
      regime: "us_macrs",
      yearStart: "2024-04-01",
      yearEnd: "2024-12-31",
      filingYear: 2024,
      reason: "remainder of the year after the short year",
    });
    await citeWindow(org, adminId, cited.id, "2024-04-01", "2024-12-31", 2024);

    const unusedIdentity = await taxYearWindowWriteProblem(db, org.orgId, {
      id: unused.id,
      subsidiaryId: org.subsidiaryId,
      regime: "us_macrs",
      yearStart: "2023-01-01",
      yearEnd: "2024-03-31",
      filingYear: 2024,
      reason: "short year after year-end change",
    });
    assert.match(unusedIdentity ?? "", /delete this unused window/);
    assert.doesNotMatch(unusedIdentity ?? "", /reverse/i);

    assert.equal(
      await taxYearWindowWriteProblem(db, org.orgId, {
        id: unused.id,
        yearEnd: "2024-02-28",
        reason: "corrected unused short-year end date",
      }),
      null,
    );
    assert.equal(await taxYearWindowDeleteProblem(db, org.orgId, unused.id), null);

    const citedDates = await taxYearWindowWriteProblem(db, org.orgId, {
      id: cited.id,
      yearEnd: "2024-11-30",
      reason: "attempted rewrite of a computed year",
    });
    assert.match(citedDates ?? "", /dates are frozen/);
    assert.match(citedDates ?? "", /Re-run that same year from Fixed Assets tax pools/);
    assert.doesNotMatch(citedDates ?? "", /reverse/i);

    const citedIdentity = await taxYearWindowWriteProblem(db, org.orgId, {
      id: cited.id,
      yearStart: "2024-05-01",
      yearEnd: "2024-12-31",
      reason: "attempted rewrite of a computed year key",
    });
    assert.match(citedIdentity ?? "", /cannot be rewritten/);
    assert.match(citedIdentity ?? "", /no reversal of a computed tax year/);

    const citedDelete = await taxYearWindowDeleteProblem(db, org.orgId, cited.id);
    assert.match(citedDelete ?? "", /cannot be deleted/);
    assert.match(citedDelete ?? "", /no reversal of a computed tax year/);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

async function citeWindow(
  org: ScratchOrg,
  actorId: string,
  windowId: string,
  yearStart: string,
  yearEnd: string,
  filingYear: number,
): Promise<void> {
  const poolId = randomUUID();
  await db.execute(sql`
    insert into tax_depreciation_pools
      (id, org_id, book_id, subsidiary_id, regime, class_code, rate, method, created_by, updated_by)
    values (
      ${poolId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'us_macrs', '5',
      '0.2000000000', 'declining', ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into tax_pool_periods (
      org_id, pool_id, tax_year, opening_balance, year_start, year_end,
      tax_year_window_id, created_by, updated_by
    ) values (
      ${org.orgId}, ${poolId}, ${filingYear}, '0', ${yearStart}, ${yearEnd},
      ${windowId}, ${actorId}, ${actorId})`);
}
