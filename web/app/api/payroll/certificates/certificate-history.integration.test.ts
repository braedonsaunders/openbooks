import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

const state: { orgId: string; actorId: string } = { orgId: "", actorId: "" };
Object.assign(globalThis, { __payrollCertificateHistoryState: state });
const virtual = (source: string) => ({
  shortCircuit: true as const,
  url: "data:text/javascript," + encodeURIComponent(source),
});
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "../../../../lib/feature-gates" || specifier === "@/lib/feature-gates")
      return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__payrollCertificateHistoryState;
        return { user: { orgId: s.orgId, id: s.actorId }, allowedSubsidiaryIds: null };
      }
    `);
    return next(specifier, context);
  },
});
const { db, pool, withBypassContext, withOrgContext } =
  await import("@openbooks/engine/platform/db");
const { sql } = await import("drizzle-orm");
const { resolveCertificate, payrollCertificate } =
  await import("@openbooks/engine/payroll/certificates");
const { requireUsFederalAlienStatus } =
  await import("@openbooks/engine/testing/payroll/us/employee-facts");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");
const { GET, POST, PATCH, DELETE } = await import("./route");
const { readApiErrorMessage } = await import("../../../../lib/api-error");

async function fixture() {
  return withBypassContext(async () => {
    const org = await createScratchOrg();
    state.orgId = org.orgId;
    state.actorId = await createScratchUser(org.orgId, "Payroll clerk", "admin");
    await db.execute(
      sql`insert into user_permission_overrides(org_id,user_id,permission,effect) values(${org.orgId},${state.actorId},'payroll.manage','grant')`,
    );
    const scheduleId = randomUUID();
    await db.execute(sql`
      insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                 pay_date_offset_days, is_active, created_by, updated_by)
      values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-01-09', 5, true,
              ${state.actorId}, ${state.actorId})`);
    return { org, scheduleId };
  });
}

async function employee(
  orgId: string,
  scheduleId: string,
  name: string,
  country: string,
  province: string,
  hiredOn: string | null,
): Promise<string> {
  const id = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${id}, ${orgId}, 'person', ${name}, true, '{}'::jsonb)`);
    await db.execute(sql`
      insert into employee_roles (id, org_id, party_id, hired_on, terminated_on)
      values (${randomUUID()}, ${orgId}, ${id}, ${hiredOn}::date, null)`);
    await db.execute(sql`
      insert into employee_payroll_profiles
        (org_id, employee_party_id, pay_schedule_id, country, province, pay_basis, is_active,
         created_by, updated_by)
      values (${orgId}, ${id}, ${scheduleId}, ${country}, ${province}, 'salary', true,
              ${state.actorId}, ${state.actorId})`);
  });
  return id;
}

const request = (method: string, body: unknown) =>
  withOrgContext(state.orgId, () => {
    const handler = method === "POST" ? POST : method === "PATCH" ? PATCH : DELETE;
    return handler(new Request("http://payroll.test", { method, body: JSON.stringify(body) }));
  });

test("a back-filled earlier residency certificate makes the earlier run calculate", async () => {
  // The converting-org hole: the certificate is filed today, so the federal
  // calculation boundary refuses the earlier pay date; back-filling the
  // earlier effective date clears exactly that refusal.
  const { org, scheduleId } = await fixture();
  try {
    const hire = await employee(org.orgId, scheduleId, "US Convert", "US", "CA", "2024-01-15");
    const filed = await request("POST", {
      employeePartyId: hire,
      country: "US",
      certificateKey: "us_w4_tax_residency",
      answers: { alien_status: "us_person_or_resident_alien" },
      effectiveFrom: "2026-10-11",
    });
    assert.equal(filed.status, 200, await filed.clone().text());
    const certificate = payrollCertificate("US", "us_w4_tax_residency");
    const storedNow = (
      await withOrgContext(org.orgId, () =>
        db.execute<{
          answers: Record<string, string>;
          effective_from: string | null;
          superseded_on: string | null;
        }>(
          sql`
      select answers, effective_from::text as effective_from, superseded_on::text as superseded_on
        from employee_tax_certificates
       where org_id = ${org.orgId} and employee_party_id = ${hire}`,
          "objects",
        ),
      )
    ).map((row) => ({
      certificateKey: "us_w4_tax_residency",
      answers: row.answers,
      effectiveFrom: row.effective_from,
      supersededOn: row.superseded_on,
    }));
    // No certificate is effective on the earlier pay date, so the federal
    // boundary — the same call compute-statutory makes — refuses by name.
    const earlier = resolveCertificate({ certificate, stored: storedNow, asOf: "2024-02-02" });
    assert.equal(earlier.onFile, false);
    assert.throws(
      () => requireUsFederalAlienStatus(earlier.answers.alien_status),
      /federal tax-residency status/,
    );
    // Back-fill the earlier certificate alongside the later one.
    const backfill = await request("POST", {
      employeePartyId: hire,
      country: "US",
      certificateKey: "us_w4_tax_residency",
      answers: { alien_status: "us_person_or_resident_alien" },
      effectiveFrom: "2024-01-15",
    });
    assert.equal(backfill.status, 200, await backfill.clone().text());
    assert.deepEqual(await backfill.json(), {
      ok: true,
      certificateKey: "us_w4_tax_residency",
      effectiveFrom: "2024-01-15",
      effectiveTo: "2026-10-11",
    });
    const stored = (
      await withOrgContext(org.orgId, () =>
        db.execute<{
          answers: Record<string, string>;
          effective_from: string | null;
          superseded_on: string | null;
        }>(
          sql`
      select answers, effective_from::text as effective_from, superseded_on::text as superseded_on
        from employee_tax_certificates
       where org_id = ${org.orgId} and employee_party_id = ${hire}
       order by effective_from`,
          "objects",
        ),
      )
    ).map((row) => ({
      certificateKey: "us_w4_tax_residency",
      answers: row.answers,
      effectiveFrom: row.effective_from,
      supersededOn: row.superseded_on,
    }));
    assert.deepEqual(stored, [
      {
        certificateKey: "us_w4_tax_residency",
        answers: { alien_status: "us_person_or_resident_alien" },
        effectiveFrom: "2024-01-15",
        supersededOn: "2026-10-11",
      },
      {
        certificateKey: "us_w4_tax_residency",
        answers: { alien_status: "us_person_or_resident_alien" },
        effectiveFrom: "2026-10-11",
        supersededOn: null,
      },
    ]);
    // The earlier run now reads the back-filled answers and the federal
    // boundary clears; the later run still reads the later filing.
    const earlierRun = resolveCertificate({ certificate, stored, asOf: "2024-02-02" });
    assert.equal(earlierRun.answers.alien_status, "us_person_or_resident_alien");
    assert.equal(requireUsFederalAlienStatus(earlierRun.answers.alien_status), false);
    const laterRun = resolveCertificate({ certificate, stored, asOf: "2026-10-12" });
    assert.equal(laterRun.answers.alien_status, "us_person_or_resident_alien");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("back-fill works for every row-backed US certificate, not just the federal one", async () => {
  const { org, scheduleId } = await fixture();
  try {
    const hire = await employee(org.orgId, scheduleId, "Cali Convert", "US", "CA", "2024-03-01");
    const filed = await request("POST", {
      employeePartyId: hire,
      country: "US",
      certificateKey: "us_ca_de4",
      answers: { regular_allowances: "2" },
      effectiveFrom: "2026-10-11",
    });
    assert.equal(filed.status, 200, await filed.clone().text());
    const backfill = await request("POST", {
      employeePartyId: hire,
      country: "US",
      certificateKey: "us_ca_de4",
      answers: { regular_allowances: "1" },
      effectiveFrom: "2024-03-01",
    });
    assert.equal(backfill.status, 200, await backfill.clone().text());
    const certificate = payrollCertificate("US", "us_ca_de4");
    const stored = (
      await withOrgContext(org.orgId, () =>
        db.execute<{
          answers: Record<string, string>;
          effective_from: string | null;
          superseded_on: string | null;
        }>(
          sql`
      select answers, effective_from::text as effective_from, superseded_on::text as superseded_on
        from employee_tax_certificates
       where org_id = ${org.orgId} and employee_party_id = ${hire}
       order by effective_from`,
          "objects",
        ),
      )
    ).map((row) => ({
      certificateKey: "us_ca_de4",
      answers: row.answers,
      effectiveFrom: row.effective_from,
      supersededOn: row.superseded_on,
    }));
    assert.equal(
      resolveCertificate({ certificate, stored, asOf: "2024-06-01" }).answers.regular_allowances,
      "1",
    );
    assert.equal(
      resolveCertificate({ certificate, stored, asOf: "2026-10-12" }).answers.regular_allowances,
      "2",
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("voiding a filing keeps history and audits the reason", async () => {
  const { org, scheduleId } = await fixture();
  try {
    const hire = await employee(org.orgId, scheduleId, "US Void", "US", "CA", "2024-01-15");
    const filed = await request("POST", {
      employeePartyId: hire,
      country: "US",
      certificateKey: "us_w4_tax_residency",
      answers: { alien_status: "nonresident_alien" },
      effectiveFrom: "2024-01-15",
    });
    assert.equal(filed.status, 200, await filed.clone().text());
    const id = (
      await withOrgContext(org.orgId, () =>
        db.execute<{ id: string }>(
          sql`
      select id::text as id from employee_tax_certificates
       where org_id = ${org.orgId} and employee_party_id = ${hire}`,
          "objects",
        ),
      )
    )[0]!.id;
    const voided = await request("DELETE", {
      id,
      reason: "Filed for the wrong employee; re-filing under the correct record.",
    });
    assert.equal(voided.status, 200, await voided.clone().text());
    const after = await withOrgContext(org.orgId, () =>
      db.execute<{
        answers: Record<string, string>;
        effective_from: string | null;
        superseded_on: string | null;
      }>(
        sql`
      select answers, effective_from::text as effective_from, superseded_on::text as superseded_on
        from employee_tax_certificates
       where org_id = ${org.orgId} and employee_party_id = ${hire}`,
        "objects",
      ),
    );
    // History is preserved: the row and its answers stay on file, closed.
    assert.equal(after.length, 1);
    assert.deepEqual(after[0]!.answers, { alien_status: "nonresident_alien" });
    assert.equal(after[0]!.effective_from, "2024-01-15");
    assert.ok(after[0]!.superseded_on !== null);
    const audit = (
      await withOrgContext(org.orgId, () =>
        db.execute<{ changes: unknown }>(
          sql`
      select changes from audit_log
       where org_id = ${org.orgId} and table_name = 'employee_tax_certificates' and row_id = ${id}::uuid
       order by at desc limit 1`,
          "objects",
        ),
      )
    )[0]!.changes as {
      kind: string;
      reason: string;
      before: unknown;
      after: unknown;
    };
    assert.equal(audit.kind, "certificate_void");
    assert.equal(audit.reason, "Filed for the wrong employee; re-filing under the correct record.");
    // Voiding a closed filing changes nothing and says so.
    const again = await request("DELETE", { id, reason: "Second thoughts." });
    assert.equal(again.status, 422, await again.clone().text());
    assert.match(((await again.json()) as { error: string }).error, /already closed/);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("an unused filing keeps an editable effective date, with audit", async () => {
  const { org, scheduleId } = await fixture();
  try {
    const hire = await employee(org.orgId, scheduleId, "US Correct", "US", "CA", "2024-01-15");
    const filed = await request("POST", {
      employeePartyId: hire,
      country: "US",
      certificateKey: "us_w4_tax_residency",
      answers: { alien_status: "us_person_or_resident_alien" },
      effectiveFrom: "2026-10-11",
    });
    assert.equal(filed.status, 200, await filed.clone().text());
    const id = (
      await withOrgContext(org.orgId, () =>
        db.execute<{ id: string }>(
          sql`
      select id::text as id from employee_tax_certificates
       where org_id = ${org.orgId} and employee_party_id = ${hire}`,
          "objects",
        ),
      )
    )[0]!.id;
    const corrected = await request("PATCH", {
      id,
      effectiveFrom: "2024-01-15",
      reason: "Certificate was signed at hire; correcting the effective date.",
    });
    assert.equal(corrected.status, 200, await corrected.clone().text());
    assert.deepEqual(await corrected.json(), {
      ok: true,
      id,
      effectiveFrom: "2024-01-15",
      effectiveTo: null,
    });
    const row = (
      await withOrgContext(org.orgId, () =>
        db.execute<{ effective_from: string }>(
          sql`
      select effective_from::text as effective_from from employee_tax_certificates
       where org_id = ${org.orgId} and id = ${id}::uuid`,
          "objects",
        ),
      )
    )[0]!;
    assert.equal(row.effective_from, "2024-01-15");
    const audit = (
      await withOrgContext(org.orgId, () =>
        db.execute<{ changes: unknown }>(
          sql`
      select changes from audit_log
       where org_id = ${org.orgId} and table_name = 'employee_tax_certificates' and row_id = ${id}::uuid
         and changes->>'kind' = 'certificate_correction'`,
          "objects",
        ),
      )
    )[0]!.changes as {
      kind: string;
      reason: string;
      before: { effective_from: string; superseded_on: null };
      after: { effective_from: string; superseded_on: null };
    };
    assert.equal(audit.kind, "certificate_correction");
    assert.deepEqual(audit.before, { effective_from: "2026-10-11", superseded_on: null });
    assert.deepEqual(audit.after, { effective_from: "2024-01-15", superseded_on: null });
    // Correcting a closed filing keeps its close and never forks past the
    // successor: the interval stays inside its own history.
    const later = await request("POST", {
      employeePartyId: hire,
      country: "US",
      certificateKey: "us_w4_tax_residency",
      answers: { alien_status: "nonresident_alien" },
      effectiveFrom: "2026-10-11",
    });
    assert.equal(later.status, 200, await later.clone().text());
    const recorrect = await request("PATCH", {
      id,
      effectiveFrom: "2024-06-01",
      reason: "Hire paperwork shows a June signature date.",
    });
    assert.equal(recorrect.status, 200, await recorrect.clone().text());
    assert.deepEqual(await recorrect.json(), {
      ok: true,
      id,
      effectiveFrom: "2024-06-01",
      effectiveTo: "2026-10-11",
    });
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("the overlap refusal renders through the shared error reader with its remedy", async () => {
  const { org, scheduleId } = await fixture();
  try {
    const hire = await employee(org.orgId, scheduleId, "US Overlap", "US", "CA", "2024-01-15");
    for (const [answers, effectiveFrom] of [
      [{ alien_status: "us_person_or_resident_alien" }, "2024-01-15"],
      [{ alien_status: "nonresident_alien" }, "2026-10-11"],
    ] as const) {
      const filed = await request("POST", {
        employeePartyId: hire,
        country: "US",
        certificateKey: "us_w4_tax_residency",
        answers,
        effectiveFrom,
      });
      assert.equal(filed.status, 200, await filed.clone().text());
    }
    const overlapping = await request("POST", {
      employeePartyId: hire,
      country: "US",
      certificateKey: "us_w4_tax_residency",
      answers: { alien_status: "us_person_or_resident_alien" },
      effectiveFrom: "2025-06-01",
    });
    assert.equal(overlapping.status, 422, await overlapping.clone().text());
    // The refusal the operator sees is the server's error plus its remedy —
    // the shared reader never drops either half.
    const rendered = await readApiErrorMessage(
      overlapping.clone(),
      "failed to save the certificate",
    );
    assert.match(rendered, /already covers 2025-06-01/);
    assert.match(rendered, /void or correct/);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("history serves every filing with who and when, plus the employment start", async () => {
  const { org, scheduleId } = await fixture();
  try {
    const hire = await employee(org.orgId, scheduleId, "US History", "US", "CA", "2024-01-15");
    for (const effectiveFrom of ["2024-01-15", "2026-10-11"]) {
      const filed = await request("POST", {
        employeePartyId: hire,
        country: "US",
        certificateKey: "us_w4_tax_residency",
        answers: { alien_status: "us_person_or_resident_alien" },
        effectiveFrom,
      });
      assert.equal(filed.status, 200, await filed.clone().text());
    }
    const response = await withOrgContext(state.orgId, () =>
      GET(new Request(`http://payroll.test?employee=${hire}`)),
    );
    assert.equal(response.status, 200, await response.clone().text());
    const body = (await response.json()) as {
      stored: {
        id: string;
        certificate_key: string;
        effective_from: string | null;
        superseded_on: string | null;
        created_at: string;
        created_by_name: string | null;
        updated_at: string;
      }[];
      employmentStart: string | null;
      today: string;
    };
    assert.equal(body.employmentStart, "2024-01-15");
    assert.match(body.today, /^\d{4}-\d{2}-\d{2}$/);
    const rows = body.stored.filter((entry) => entry.certificate_key === "us_w4_tax_residency");
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((entry) => [entry.effective_from, entry.superseded_on]),
      [
        ["2024-01-15", "2026-10-11"],
        ["2026-10-11", null],
      ],
    );
    for (const entry of rows) {
      assert.ok(entry.id, "history rows carry their id for void/correct actions");
      assert.equal(entry.created_by_name, "Payroll clerk");
      assert.match(entry.created_at, /^\d{4}-\d{2}-\d{2}/);
    }
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test.after(async () => {
  await pool.end();
});
