import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { postProjectGlEntry } from "../projects/recognition.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { previewDriverVector } from "./drivers.ts";
import { previewAllocationRun } from "./period-run.ts";
import { allocationServiceDeps } from "./service.ts";

// Finding 6.3: every production entry point must resolve report_definition
// drivers — the period-run service default (scheduler, close automation,
// conformance, the runs preview route) and the composed factory the drivers
// preview route and the assistant use. Each test leases its own scratch org.

interface ReportSetup {
  org: ScratchOrg;
  actor: string;
  ruleId: string;
  driverId: string;
  adjustment: string;
  bank: string;
}

async function setupReportRule(): Promise<ReportSetup> {
  const org = await createScratchOrg();
  const actor = await createScratchUser(org.orgId, "Service factory tester", "admin");
  await db.execute(sql`
    insert into user_permission_overrides (org_id, user_id, permission, effect)
    values (${org.orgId}, ${actor}, 'reports.read', 'grant')`);
  const adjustment = org.accounts.adjustment;
  const bank = org.accounts.bank;
  // The report measures posted reality: DR adjustment / CR bank.
  await postProjectGlEntry({
    orgId: org.orgId,
    actorId: actor,
    origin: "manual",
    entryNumber: `SVC-SEED-${randomUUID()}`,
    postingDate: org.date,
    memo: "Service factory pool",
    subsidiaryId: org.subsidiaryId,
    currency: "CAD",
    lines: [
      { accountId: adjustment, amount: "1000.0000" },
      { accountId: bank, amount: "-1000.0000" },
    ],
  });
  const definitionId = randomUUID();
  await db.execute(sql`
    insert into report_definitions (id, org_id, kind, slug, name, report_type, query)
    values (${definitionId}, ${org.orgId}, 'custom', 'driver-service-test', 'Driver service test', 'query',
      ${JSON.stringify({
        entity: "ledger_lines",
        mode: "summarize",
        columns: [],
        breakouts: [{ column: "account_id" }],
        measures: [{ fn: "sum", column: "debit" }],
      })}::jsonb)`);
  // The report yields account uuids, so the driver speaks extra:account and
  // explicit targets carry the matching account in their extra dims.
  const driverId = randomUUID();
  await db.execute(sql`
    insert into allocation_drivers (id, org_id, key, name, dimension, source_kind, config, is_active)
    values (${driverId}, ${org.orgId}, 'svc-report', 'Service report driver', 'extra:account',
            'report_definition',
            ${JSON.stringify({
              reportDefinitionId: definitionId,
              dimensionColumn: "account_id",
              valueColumn: "debit",
              params: {},
            })}::jsonb, true)`);
  const ruleId = randomUUID();
  const versionId = randomUUID();
  await db.execute(sql`
    insert into allocation_rules (id, org_id, key, name, mode, sort_order, is_active, is_system, custom)
    values (${ruleId}, ${org.orgId}, 'svc-rule', 'Service rule', 'period', 100, true, false, '{}'::jsonb)`);
  await db.execute(sql`
    insert into allocation_rule_versions
      (id, org_id, rule_id, version_no, status, effective_from, effective_to,
       book_scope, book_ids, account_scope, dimension_filters, source_measure,
       basis_kind, driver_id, driver_as_of, basis_config,
       target_kind, dynamic_target, impact, residual_policy, solve_method,
       run_policy, run_offset_days, memo_template, published_at)
    values (${versionId}, ${org.orgId}, ${ruleId}, 1, 'draft', '2026-01-01', null,
       'primary', '[]'::jsonb,
       ${JSON.stringify({ kind: "accounts", accountIds: [adjustment] })}::jsonb,
       '{}'::jsonb, 'period_activity',
       'driver', ${driverId}, 'period', '{}'::jsonb,
       'explicit', '{}'::jsonb, 'reclass', 'largest_share', 'sequential',
       'manual', 0, 'Service {{rule.name}} for {{period.name}}', now())`);
  for (const [sequence, accountId] of [adjustment, bank].entries()) {
    await db.execute(sql`
      insert into allocation_rule_targets
        (id, org_id, version_id, sequence, target_account_id, extra_dims, label, custom)
      values (${randomUUID()}, ${org.orgId}, ${versionId}, ${sequence + 1}, null,
              ${JSON.stringify({ account: accountId })}::jsonb, ${`Target ${sequence + 1}`}, '{}'::jsonb)`);
  }
  await db.execute(sql`
    update allocation_rule_versions
       set status = 'published', definition_hash = ${`testhash-${versionId}`}, published_at = now()
     where id = ${versionId} and org_id = ${org.orgId}`);
  await db.execute(sql`
    update allocation_rules set current_version_id = ${versionId}
     where id = ${ruleId} and org_id = ${org.orgId}`);
  return { org, actor, ruleId, driverId, adjustment, bank };
}

function sortedVector(entries: Array<{ key: string; value: string }>): Array<[string, string]> {
  return entries.map((e) => [e.key, e.value] as [string, string]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

test("period runs resolve report drivers with no injected deps (production default)", async () => {
  const s = await setupReportRule();
  try {
    // No PeriodRunDeps: scheduler, close automation, conformance and the
    // runs preview route all flow through this default.
    const preview = await previewAllocationRun({
      orgId: s.org.orgId,
      ruleId: s.ruleId,
      periodId: s.org.periodId,
      bookId: s.org.bookId,
      actorId: s.actor,
      trigger: "manual",
    });
    assert.equal(preview.status, "previewed");
    assert.equal(preview.sourceTotal, "1000.0000");
    // The stored run echoes the enforced temporal contract (undeclared mode
    // keeps the current as-of behavior, now visible instead of silent).
    assert.deepEqual(
      (preview.computation.driver as unknown as { temporal?: unknown } | null)?.temporal,
      { mode: "balance_as_of", from: null, to: "2026-07-31", field: null },
    );
    const vector = sortedVector(preview.computation.driver?.vector ?? []);
    assert.deepEqual(vector, sortedVector([
      { key: s.adjustment, value: "1000.0000" },
      { key: s.bank, value: "0.0000" },
    ]));
    const amounts = new Map(preview.computation.targets.map((t) => [t.coordinate.extraDims?.["account"], t.amount]));
    assert.equal(amounts.get(s.adjustment), "1000.0000");
    assert.equal(amounts.get(s.bank), "0.0000");
  } finally {
    await dropScratchOrgReporting(s.org.orgId);
  }
});

test("the allocation service factory resolves report drivers for preview callers", async () => {
  const s = await setupReportRule();
  try {
    // The same composition the drivers preview route and the assistant use.
    const preview = await previewDriverVector(
      { orgId: s.org.orgId, driverId: s.driverId, asOf: { periodId: s.org.periodId }, actorId: s.actor },
      allocationServiceDeps(),
    );
    assert.deepEqual(sortedVector(preview.vector), sortedVector([
      { key: s.adjustment, value: "1000.0000" },
      { key: s.bank, value: "0.0000" },
    ]));
    assert.equal(preview.total, "1000.0000");
  } finally {
    await dropScratchOrgReporting(s.org.orgId);
  }
});
