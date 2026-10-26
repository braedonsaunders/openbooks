import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { dropScratchOrgReporting } from "../testing/fixtures.ts";
import { calculatedRun, seedAdoption, type AdoptionFixture } from "./filing-test-fixtures.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import { createPayRun } from "./run-lifecycle.ts";

/**
 * A persisted calculation replaces the run's previous stubs, lines and
 * entitlement movements. These cases prove the replaced result is retained
 * as one native audit event per persisted attempt, in the same transaction,
 * while previews, simulations and refused attempts retain nothing new.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;

interface CalculationEvidence {
  run: {
    documentId: string;
    payScheduleId: string;
    subsidiaryId: string | null;
    currency: string;
    runStatus: string;
    periodStart: string;
    periodEnd: string;
    payDate: string;
    employeeCount: number;
    grossTotal: string;
    netTotal: string;
    employerCostTotal: string;
    calculationSourceDigest: string | null;
    calculationSourceSnapshot: {
      timeEntries: unknown[];
      claimEntryIds: string[];
    } | null;
    calculationErrors: Array<{ employee: string; message: string; kind: string }>;
  };
  stubs: Array<{
    stubId: string;
    employeePartyId: string;
    gross: string;
    netPay: string;
    employerCost: string;
    lines: Array<{ lineId: string; amount: string; rate: string | null; hours: string | null }>;
  }>;
  entitlements: Array<{ movementId: string; amount: string; hours: string | null; kind: string }>;
  benefitAllocations: unknown[];
  holidayAllocations: unknown[];
  compensationCalculations: unknown[];
}

type CalculationEvent = {
  id: string;
  action: string;
  actor_id: string | null;
  at: string;
  row_id: string;
  changes: {
    operation: string;
    event: string;
    reason: string;
    recalculation: boolean;
    before: CalculationEvidence | null;
    after: CalculationEvidence;
  };
};

async function calculationEvents(orgId: string, documentId: string): Promise<CalculationEvent[]> {
  return await db.execute<CalculationEvent>(
    sql`
    select id, action, actor_id, at::text as at, row_id, changes
      from audit_log
     where org_id = ${orgId} and table_name = 'pay_runs' and row_id = ${documentId}
       and changes ->> 'event' = 'pay_run_calculated'
     order by at, id
  `,
    "objects",
  );
}

async function persistedState(orgId: string, documentId: string) {
  return (
    await db.execute<{ state: unknown }>(
      sql`
    select jsonb_build_object(
      'run', (select jsonb_build_object(
                'status', r.run_status, 'gross', r.gross_total::text,
                'net', r.net_total::text, 'employerCost', r.employer_cost_total::text,
                'employees', r.employee_count, 'digest', r.calculation_source_digest,
                'errors', r.calculation_errors)
                from pay_runs r
               where r.org_id = ${orgId} and r.document_id = ${documentId}),
      'stubIds', (select coalesce(jsonb_agg(id::text order by id), '[]'::jsonb)
                    from pay_stubs
                   where org_id = ${orgId} and pay_run_document_id = ${documentId}),
      'lineIds', (select coalesce(jsonb_agg(l.id::text order by l.id), '[]'::jsonb)
                    from pay_stub_lines l
                    join pay_stubs s on s.org_id = l.org_id and s.id = l.stub_id
                   where s.org_id = ${orgId} and s.pay_run_document_id = ${documentId}),
      'entitlementIds', (select coalesce(jsonb_agg(id::text order by id), '[]'::jsonb)
                           from entitlement_ledger
                          where org_id = ${orgId} and pay_run_document_id = ${documentId}),
      'entitlementBalance', (select coalesce(sum(amount), 0)::text
                               from entitlement_ledger
                              where org_id = ${orgId} and pay_run_document_id = ${documentId}),
      'benefitAllocations', (select count(*)::int from pay_run_benefit_allocations
                              where org_id = ${orgId} and pay_run_document_id = ${documentId}),
      'calculationEvents', (select count(*)::int from audit_log
                             where org_id = ${orgId} and table_name = 'pay_runs'
                               and row_id = ${documentId}
                               and changes ->> 'event' = 'pay_run_calculated')
    ) as state
  `,
      "objects",
    )
  )[0]!.state;
}

async function addApprovedTime(
  fx: AdoptionFixture,
  workedOn: string,
  hours: number,
): Promise<string> {
  return (
    await db.execute<{ id: string }>(
      sql`
    insert into time_entries (org_id, employee_party_id, worked_on, hours, status,
      is_billable, billing_status, costing_basis, created_by, updated_by)
    values (${fx.orgId}, ${fx.employeeId}, ${workedOn}, ${hours}, 'approved', false,
      'unbilled', 'actual', ${fx.actorId}, ${fx.actorId}) returning id
  `,
      "objects",
    )
  )[0]!.id;
}

test(
  "first persisted calculation records one native audit event with no prior result",
  { skip: !DB },
  async () => {
    const fx = await seedAdoption();
    try {
      const { input } = await calculatedRun(fx);
      const events = await calculationEvents(fx.orgId, input.documentId);
      assert.equal(events.length, 1, "exactly one calculation event is retained");
      const event = events[0]!;
      assert.equal(event.action, "update");
      assert.equal(event.actor_id, fx.actorId);
      assert.ok(event.at.length > 0, "the native event carries its recording time");
      assert.equal(event.row_id, input.documentId);
      assert.equal(event.changes.operation, "calculate_pay_run");
      assert.equal(event.changes.event, "pay_run_calculated");
      assert.match(event.changes.reason, /calculated/);
      assert.equal(event.changes.recalculation, false);
      assert.equal(
        event.changes.before,
        null,
        "a first calculation has no prior result to preserve",
      );

      const after = event.changes.after;
      assert.equal(after.run.documentId, input.documentId);
      assert.equal(after.run.payScheduleId, fx.scheduleId);
      assert.equal(after.run.subsidiaryId, fx.subsidiaryId);
      assert.equal(after.run.periodStart, "2026-07-05");
      assert.equal(after.run.periodEnd, "2026-07-18");
      assert.equal(after.run.payDate, "2026-07-21");
      assert.equal(after.run.runStatus, "calculated");
      assert.equal(after.run.grossTotal, "240.0000");
      assert.equal(typeof after.run.netTotal, "string");
      assert.equal(typeof after.run.employerCostTotal, "string");
      assert.deepEqual(after.run.calculationErrors, []);
      assert.ok(Array.isArray(after.benefitAllocations));
      assert.ok(Array.isArray(after.holidayAllocations));
      assert.ok(Array.isArray(after.compensationCalculations));

      const stored = (
        await db.execute<{
          digest: string;
          snapshot: unknown;
          gross: string;
          net: string;
        }>(
          sql`
        select calculation_source_digest as digest,
               calculation_source_snapshot as snapshot,
               gross::text as gross, net_pay::text as net
          from pay_runs r
          join pay_stubs s on s.org_id = r.org_id and s.pay_run_document_id = r.document_id
         where r.org_id = ${fx.orgId} and r.document_id = ${input.documentId}
      `,
          "objects",
        )
      )[0]!;
      assert.equal(after.run.calculationSourceDigest, stored.digest);
      assert.deepEqual(
        after.run.calculationSourceSnapshot,
        stored.snapshot,
        "the event retains the stored source snapshot under its original identity",
      );
      assert.equal(after.stubs.length, 1);
      assert.equal(
        after.stubs[0]!.gross,
        stored.gross,
        "stub money is retained as stored decimal text",
      );
      assert.equal(after.stubs[0]!.netPay, stored.net);
      assert.ok(after.stubs[0]!.lines.length > 0);
      assert.ok(after.stubs[0]!.lines.every((line) => typeof line.amount === "string"));
      assert.ok(after.entitlements.length > 0, "the run's entitlement movements are retained");

      const entitlementIds = (
        await db.execute<{ id: string }>(
          sql`
        select id::text as id from entitlement_ledger
         where org_id = ${fx.orgId} and pay_run_document_id = ${input.documentId}
         order by id
      `,
          "objects",
        )
      ).map((row) => row.id);
      assert.deepEqual(
        after.entitlements.map((movement) => movement.movementId).sort(),
        entitlementIds,
        "the event names the actual entitlement movements the calculation produced",
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "recalculation preserves the replaced stub, source and entitlement identities",
  { skip: !DB },
  async () => {
    const fx = await seedAdoption();
    try {
      const { input } = await calculatedRun(fx);
      const firstState = (await persistedState(fx.orgId, input.documentId)) as {
        stubIds: string[];
        entitlementIds: string[];
      };
      const second = await calculatePayRun(input);
      assert.deepEqual(second.errors, []);

      const events = await calculationEvents(fx.orgId, input.documentId);
      assert.equal(events.length, 2, "each persisted attempt records exactly one event");
      const [first, recalculated] = events as [CalculationEvent, CalculationEvent];
      assert.notEqual(recalculated.id, first.id);
      assert.equal(recalculated.changes.recalculation, true);
      assert.match(recalculated.changes.reason, /recalculated/);

      const before = recalculated.changes.before!;
      assert.deepEqual(
        before.stubs.map((stub) => stub.stubId),
        first.changes.after.stubs.map((stub) => stub.stubId),
      );
      assert.deepEqual(
        before.stubs.map((stub) => stub.stubId),
        firstState.stubIds,
      );
      assert.deepEqual(
        before.entitlements.map((movement) => movement.movementId).sort(),
        firstState.entitlementIds,
        "the replaced entitlement movements survive under their original ids",
      );
      assert.equal(
        before.run.calculationSourceDigest,
        first.changes.after.run.calculationSourceDigest,
        "the replaced source digest is preserved, not re-derived",
      );
      assert.deepEqual(
        before.run.calculationSourceSnapshot,
        first.changes.after.run.calculationSourceSnapshot,
      );
      assert.deepEqual(before.benefitAllocations, first.changes.after.benefitAllocations);
      assert.deepEqual(before.holidayAllocations, first.changes.after.holidayAllocations);
      assert.deepEqual(
        before.compensationCalculations,
        first.changes.after.compensationCalculations,
      );

      const afterState = (await persistedState(fx.orgId, input.documentId)) as {
        stubIds: string[];
        entitlementIds: string[];
      };
      assert.deepEqual(
        recalculated.changes.after.stubs.map((stub) => stub.stubId),
        afterState.stubIds,
      );
      assert.ok(
        afterState.stubIds.every((id) => !firstState.stubIds.includes(id)),
        "the recalculation's stubs are the newly persisted rows",
      );
      assert.deepEqual(
        recalculated.changes.after.entitlements.map((movement) => movement.movementId).sort(),
        afterState.entitlementIds,
      );
      assert.ok(
        afterState.entitlementIds.every((id) => !firstState.entitlementIds.includes(id)),
        "the recalculation's entitlement movements are the newly persisted rows",
      );
      assert.equal(recalculated.changes.after.run.grossTotal, before.run.grossTotal);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "an input change produces genuine before and after source and money evidence",
  { skip: !DB },
  async () => {
    const fx = await seedAdoption();
    try {
      const { input } = await calculatedRun(fx);
      await addApprovedTime(fx, "2026-07-15", 8);
      const second = await calculatePayRun(input);
      assert.deepEqual(second.errors, []);
      assert.equal(second.gross, "480.0000");

      const events = await calculationEvents(fx.orgId, input.documentId);
      assert.equal(events.length, 2);
      const before = events[1]!.changes.before!;
      const after = events[1]!.changes.after;
      assert.equal(before.run.grossTotal, "240.0000");
      assert.equal(after.run.grossTotal, "480.0000");
      assert.notEqual(after.run.calculationSourceDigest, before.run.calculationSourceDigest);
      assert.equal(before.run.calculationSourceSnapshot!.timeEntries.length, 1);
      assert.equal(after.run.calculationSourceSnapshot!.timeEntries.length, 2);
      assert.equal(before.run.calculationSourceSnapshot!.claimEntryIds.length, 1);
      assert.equal(after.run.calculationSourceSnapshot!.claimEntryIds.length, 2);
      assert.notEqual(after.stubs[0]!.gross, before.stubs[0]!.gross);
      assert.notEqual(after.stubs[0]!.stubId, before.stubs[0]!.stubId);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "unchanged recalculation still records a distinguishable event without duplicating entitlement movements",
  { skip: !DB },
  async () => {
    const fx = await seedAdoption();
    try {
      const { input } = await calculatedRun(fx);
      const beforeRecalculation = (await persistedState(fx.orgId, input.documentId)) as {
        entitlementIds: string[];
        entitlementBalance: string;
      };
      await calculatePayRun(input);
      const afterRecalculation = (await persistedState(fx.orgId, input.documentId)) as {
        entitlementIds: string[];
        entitlementBalance: string;
        stubIds: string[];
      };
      assert.equal(
        afterRecalculation.entitlementIds.length,
        beforeRecalculation.entitlementIds.length,
      );
      assert.equal(afterRecalculation.entitlementBalance, beforeRecalculation.entitlementBalance);
      assert.ok(
        afterRecalculation.entitlementIds.every(
          (id) => !beforeRecalculation.entitlementIds.includes(id),
        ),
        "movements are replaced under new ids, never duplicated alongside the old ones",
      );

      const events = await calculationEvents(fx.orgId, input.documentId);
      assert.equal(events.length, 2);
      assert.equal(
        events[1]!.changes.after.run.grossTotal,
        events[1]!.changes.before!.run.grossTotal,
      );
      assert.notEqual(events[1]!.id, events[0]!.id);
      assert.equal(events[1]!.changes.recalculation, true);
      assert.deepEqual(
        events[1]!.changes.before!.entitlements.map((movement) => movement.movementId).sort(),
        beforeRecalculation.entitlementIds,
      );
      assert.deepEqual(
        events[1]!.changes.after.entitlements.map((movement) => movement.movementId).sort(),
        afterRecalculation.entitlementIds,
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "a persisted per-employee refusal retains its partial result and the result it replaced",
  { skip: !DB },
  async () => {
    const fx = await seedAdoption();
    try {
      const { input } = await calculatedRun(fx);
      const foreignSubsidiaryId = randomUUID();
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids,
                                  is_elimination, is_active, custom)
        values (${foreignSubsidiaryId}, ${fx.orgId}, ${fx.subsidiaryId}, 'Foreign entity', 'USD', 'US',
                '{}'::jsonb, false, true, '{}'::jsonb)
      `);
      await db.execute(sql`
        update parties set subsidiary_id = ${foreignSubsidiaryId}
         where org_id = ${fx.orgId} and id = ${fx.employeeId}
      `);
      const refused = await calculatePayRun(input);
      assert.equal(refused.employees, 0);
      assert.equal(refused.errors.length, 1);
      assert.equal(refused.errors[0]!.kind, "refusal");

      const events = await calculationEvents(fx.orgId, input.documentId);
      assert.equal(events.length, 2, "the persisted refusal result records its own event");
      const before = events[1]!.changes.before!;
      const after = events[1]!.changes.after;
      assert.equal(before.stubs.length, 1, "the replaced calculated stub is preserved");
      assert.deepEqual(after.stubs, []);
      assert.equal(after.run.employeeCount, 0);
      assert.equal(after.run.grossTotal, "0.0000");
      assert.equal(after.run.calculationErrors.length, 1);
      assert.equal(after.run.calculationErrors[0]!.kind, "refusal");
      assert.equal(after.run.calculationErrors[0]!.employee, fx.employeeName);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "a failed audit write rolls the recalculated result and its event back together",
  { skip: !DB },
  async () => {
    const fx = await seedAdoption();
    const failureName = `calculation_audit_failure_${randomUUID().replaceAll("-", "")}`;
    let functionInstalled = false;
    let triggerInstalled = false;
    try {
      const { input } = await calculatedRun(fx);
      const before = await persistedState(fx.orgId, input.documentId);
      await db.execute(
        sql.raw(
          `create function ${failureName}() returns trigger language plpgsql ` +
            "as $$ begin raise exception 'injected calculation audit failure'; end $$",
        ),
      );
      functionInstalled = true;
      // CREATE TRIGGER is a utility statement: its WHEN clause cannot use
      // bind parameters, so the scratch org id is interpolated literally.
      await db.execute(
        sql.raw(
          `create trigger ${failureName} before insert on audit_log\n` +
            `  for each row when (new.org_id = '${fx.orgId}'::uuid\n` +
            `    and new.table_name = 'pay_runs'\n` +
            `    and new.changes ->> 'event' = 'pay_run_calculated')\n` +
            `  execute function ${failureName}()`,
        ),
      );
      triggerInstalled = true;
      const errorText = (error: unknown): string => {
        let text = "";
        let current: unknown = error;
        for (let depth = 0; depth < 6 && current instanceof Error; depth += 1) {
          text += ` ${current.message}`;
          current = (current as { cause?: unknown }).cause;
        }
        return text;
      };
      await assert.rejects(
        () => calculatePayRun(input),
        (error: unknown) => /injected calculation audit failure/.test(errorText(error)),
      );
      assert.deepEqual(
        await persistedState(fx.orgId, input.documentId),
        before,
        "the failed attempt leaves the prior stubs, movements, totals and single event untouched",
      );
    } finally {
      if (triggerInstalled) {
        await db.execute(sql.raw(`drop trigger ${failureName} on audit_log`));
      }
      if (functionInstalled) await db.execute(sql.raw(`drop function ${failureName}()`));
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "dry runs and simulations retain no calculation event or result change",
  { skip: !DB },
  async () => {
    const fx = await seedAdoption();
    try {
      const { input } = await calculatedRun(fx);
      const calculated = await persistedState(fx.orgId, input.documentId);

      const preview = await calculatePayRun({ ...input, dryRun: true });
      assert.deepEqual(preview.errors, []);
      assert.ok(preview.stubs && preview.stubs.length === 1, "the preview still returns its stubs");
      assert.deepEqual(await persistedState(fx.orgId, input.documentId), calculated);

      await commitPayRun(input);
      const committed = await persistedState(fx.orgId, input.documentId);
      const simulated = await calculatePayRun({ ...input, simulate: true });
      assert.deepEqual(simulated.errors, []);
      assert.ok(simulated.stubs && simulated.stubs.length === 1);
      assert.deepEqual(
        await persistedState(fx.orgId, input.documentId),
        committed,
        "a simulation of a committed run retains neither a preview event nor new rows",
      );
      assert.equal((await calculationEvents(fx.orgId, input.documentId)).length, 1);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "foreign and empty scopes attempt no calculation, mutation or event",
  { skip: !DB },
  async () => {
    const fx = await seedAdoption();
    try {
      const { input } = await calculatedRun(fx);
      const before = await persistedState(fx.orgId, input.documentId);
      for (const allowedSubsidiaryIds of [new Set<string>(), new Set([randomUUID()])]) {
        await assert.rejects(
          () => calculatePayRun({ ...input, allowedSubsidiaryIds }),
          /pay run not found/,
        );
        assert.deepEqual(await persistedState(fx.orgId, input.documentId), before);
      }
      assert.equal((await calculationEvents(fx.orgId, input.documentId)).length, 1);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "a run that was never persisted as calculated gains no event from a refused scope on first attempt",
  { skip: !DB },
  async () => {
    const fx = await seedAdoption();
    try {
      const run = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: "2026-07-05",
        periodEnd: "2026-07-18",
      });
      await assert.rejects(
        () =>
          calculatePayRun({
            orgId: fx.orgId,
            actorId: fx.actorId,
            documentId: run.documentId,
            allowedSubsidiaryIds: new Set<string>(),
          }),
        /pay run not found/,
      );
      assert.deepEqual(await calculationEvents(fx.orgId, run.documentId), []);
      const state = (await persistedState(fx.orgId, run.documentId)) as { stubIds: string[] };
      assert.deepEqual(state.stubIds, []);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
