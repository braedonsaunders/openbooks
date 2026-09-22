/// <reference types="node" />

/**
 * Behavioral coverage for 0250_employee_pay_component_overlap_guard.
 *
 * The pay run emits a line per matching employee_pay_components row
 * (engine/src/payroll/run-stub-compute.ts), so two active effective windows
 * overlapping for one assignment pay the employee twice. The guard is a GiST
 * exclusion constraint keyed on (org_id, coalesce(employment_id,
 * employee_party_id), component_id): folding NULL employment_id onto the
 * employee covers not-yet-stamped rows, while a second concurrent employment
 * (distinct employment_id) keeps its own window.
 *
 * This suite pins both halves — the overlap is refused, and a distinct
 * employment, a non-overlapping window, and an inactive row are all allowed —
 * and self-skips without OPENBOOKS_DB_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";

function pgMessage(error: unknown): string {
  const cause = (error as { cause?: unknown }).cause;
  return `${String(error)}\n${cause === undefined ? "" : String(cause)}`;
}

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

type EngineDb = typeof import("../engine/src/platform/db.ts");
type EngineFixtures = typeof import("../engine/src/testing/fixtures.ts");

let harness: {
  db: EngineDb["db"];
  withBypassContext: EngineDb["withBypassContext"];
  org: Awaited<ReturnType<EngineFixtures["createScratchOrg"]>>;
  componentId: string;
} | null = null;

async function ctx() {
  if (!harness) {
    const [{ db, withBypassContext }, { createScratchOrg }, { seedPayrollComponents }] = await Promise.all([
      import("../engine/src/platform/db.ts"),
      import("../engine/src/testing/fixtures.ts"),
      import("../engine/src/payroll/run-setup.ts"),
    ]);
    const org = await createScratchOrg();
    await withBypassContext(async () => {
      await seedPayrollComponents(org.orgId, null, "CA");
    });
    const component = (await withBypassContext(async () => (await db.execute<{ id: string }>(sql`
      select id from pay_components where org_id = ${org.orgId} and code = 'BASE' limit 1`)).rows))[0]!;
    harness = { db, withBypassContext, org, componentId: component.id };
  }
  return harness;
}

async function insertEmployment(orgId: string, partyId: string, subsidiaryId: string): Promise<string> {
  const id = randomUUID();
  await harness!.withBypassContext(async () => {
    await harness!.db.execute(sql`
      insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
      values (${id}, ${orgId}, ${partyId}, ${subsidiaryId}, 1)
    `);
  });
  return id;
}

async function insertAssignment(
  h: NonNullable<typeof harness>,
  opts: { employmentId?: string | null; from: string; to?: string | null; active?: boolean },
): Promise<void> {
  await h.withBypassContext(async () => {
    await h.db.execute(sql`
      insert into employee_pay_components
        (org_id, employee_party_id, employment_id, component_id, value, effective_from, effective_to, is_active)
      values (${h.org.orgId}, ${h.org.customerId}, ${opts.employmentId ?? null}, ${h.componentId},
              '100.0000', ${opts.from}, ${opts.to ?? null}, ${opts.active ?? true})
    `);
  });
}

function isOverlapViolation(error: unknown): boolean {
  return /employee_pay_components_no_active_overlap/.test(pgMessage(error));
}

test("an overlapping active assignment for the same employment is refused", { skip: !DB }, async () => {
  const h = await ctx();
  const employmentId = await insertEmployment(h.org.orgId, h.org.customerId, h.org.subsidiaryId);
  await insertAssignment(h, { employmentId, from: "2024-01-01", to: "2024-06-30" });
  await assert.rejects(
    () => insertAssignment(h, { employmentId, from: "2024-06-01", to: "2024-12-31" }),
    (error: unknown) => {
      assert.ok(isOverlapViolation(error), `expected exclusion violation, got: ${pgMessage(error)}`);
      return true;
    },
  );
});

test("not-yet-stamped rows are guarded, but a second employment keeps its own window", { skip: !DB }, async () => {
  const h = await ctx();
  // Two NULL-employment windows for the same employee+component overlap: refused
  // (this is the case an employment_id-only key would let escape entirely).
  await insertAssignment(h, { employmentId: null, from: "2025-01-01", to: "2025-06-30" });
  await assert.rejects(
    () => insertAssignment(h, { employmentId: null, from: "2025-06-01", to: "2025-12-31" }),
    (error: unknown) => isOverlapViolation(error),
  );

  // A distinct employment may hold an overlapping window for the same component.
  const first = await insertEmployment(h.org.orgId, h.org.customerId, h.org.subsidiaryId);
  const second = await insertEmployment(h.org.orgId, h.org.customerId, h.org.subsidiaryId);
  await insertAssignment(h, { employmentId: first, from: "2026-01-01", to: "2026-06-30" });
  await insertAssignment(h, { employmentId: second, from: "2026-01-01", to: "2026-06-30" });

  // A non-overlapping successor window on the same employment is allowed.
  await insertAssignment(h, { employmentId: first, from: "2026-07-01", to: "2026-12-31" });

  // An inactive overlapping row is not constrained (WHERE is_active).
  await insertAssignment(h, { employmentId: first, from: "2026-01-01", to: "2026-06-30", active: false });
});

if (DB) {
  test.after(async () => {
    if (!harness) return;
    const { dropScratchOrg } = await import("../engine/src/testing/fixtures.ts");
    await dropScratchOrg(harness.org.orgId);
    harness = null;
  });
}