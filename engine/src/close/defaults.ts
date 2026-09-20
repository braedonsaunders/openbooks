import { CloseError } from "./period-policy.ts";
import { defaultCloseFeatureContext } from "./features.ts";
import { sql } from "drizzle-orm";
import { inDbTransaction } from "../platform/db.ts";
import { SOURCE_EVIDENCE_POLICY_CODE } from "../banking/banking.ts";
const DEFAULT_STEPS = [
  {
    key: "drafts-cleared",
    title: "close.defaultSteps.drafts-cleared.title",
    description: "close.defaultSteps.drafts-cleared.description",
    workstream: "readiness",
    taskType: "check",
    completionMode: "computed",
    gateType: "hard",
    offset: -2,
    evidence: false,
  },
  {
    key: "bank-reconciled",
    title: "close.defaultSteps.bank-reconciled.title",
    description: "close.defaultSteps.bank-reconciled.description",
    workstream: "banking",
    taskType: "reconciliation",
    completionMode: "computed",
    gateType: "hard",
    offset: 1,
    evidence: true,
  },
  {
    key: "ar-cutoff",
    title: "close.defaultSteps.ar-cutoff.title",
    description: "close.defaultSteps.ar-cutoff.description",
    workstream: "ar",
    taskType: "action",
    completionMode: "manual",
    gateType: "hard",
    offset: 1,
    evidence: true,
  },
  {
    key: "ap-cutoff",
    title: "close.defaultSteps.ap-cutoff.title",
    description: "close.defaultSteps.ap-cutoff.description",
    workstream: "ap",
    taskType: "action",
    completionMode: "manual",
    gateType: "hard",
    offset: 1,
    evidence: true,
  },
  {
    key: "depreciation-posted",
    title: "close.defaultSteps.depreciation-posted.title",
    description: "close.defaultSteps.depreciation-posted.description",
    workstream: "assets",
    taskType: "journal",
    completionMode: "computed",
    gateType: "hard",
    offset: 2,
    evidence: true,
  },
  {
    key: "recognition-posted",
    title: "close.defaultSteps.recognition-posted.title",
    description: "close.defaultSteps.recognition-posted.description",
    workstream: "gl",
    taskType: "journal",
    completionMode: "computed",
    gateType: "hard",
    offset: 2,
    evidence: true,
  },
  {
    key: "fx-ready",
    title: "close.defaultSteps.fx-ready.title",
    description: "close.defaultSteps.fx-ready.description",
    workstream: "gl",
    taskType: "check",
    completionMode: "computed",
    gateType: "hard",
    offset: 2,
    evidence: false,
  },
  {
    key: "fx-revalued",
    title: "close.defaultSteps.fx-revalued.title",
    description: "close.defaultSteps.fx-revalued.description",
    workstream: "gl",
    taskType: "journal",
    completionMode: "computed",
    gateType: "hard",
    offset: 2,
    evidence: true,
  },
  {
    key: "intercompany-balanced",
    title: "close.defaultSteps.intercompany-balanced.title",
    description: "close.defaultSteps.intercompany-balanced.description",
    workstream: "intercompany",
    taskType: "reconciliation",
    completionMode: "computed",
    gateType: "hard",
    offset: 2,
    evidence: true,
  },
  {
    key: "consolidation",
    title: "close.defaultSteps.consolidation.title",
    description: "close.defaultSteps.consolidation.description",
    workstream: "intercompany",
    taskType: "journal",
    completionMode: "manual",
    gateType: "soft",
    offset: 3,
    evidence: true,
  },
  {
    key: "variance-review",
    title: "close.defaultSteps.variance-review.title",
    description: "close.defaultSteps.variance-review.description",
    workstream: "review",
    taskType: "approval",
    completionMode: "manual",
    gateType: "hard",
    offset: 3,
    evidence: true,
  },
  {
    key: "controller-approval",
    title: "close.defaultSteps.controller-approval.title",
    description: "close.defaultSteps.controller-approval.description",
    workstream: "review",
    taskType: "approval",
    completionMode: "manual",
    gateType: "hard",
    offset: 4,
    evidence: false,
  },
  {
    key: "financial-review",
    title: "close.defaultSteps.financial-review.title",
    description: "close.defaultSteps.financial-review.description",
    workstream: "review",
    taskType: "report",
    completionMode: "manual",
    gateType: "hard",
    offset: 3,
    evidence: false,
  },
  {
    key: "lock-subledgers",
    title: "close.defaultSteps.lock-subledgers.title",
    description: "close.defaultSteps.lock-subledgers.description",
    workstream: "gl",
    taskType: "action",
    completionMode: "automatic",
    gateType: "hard",
    offset: 4,
    evidence: false,
  },
  {
    key: "lock-gl",
    title: "close.defaultSteps.lock-gl.title",
    description: "close.defaultSteps.lock-gl.description",
    workstream: "gl",
    taskType: "action",
    completionMode: "automatic",
    gateType: "hard",
    offset: 4,
    evidence: false,
  },
  {
    key: "publish-package",
    title: "close.defaultSteps.publish-package.title",
    description: "close.defaultSteps.publish-package.description",
    workstream: "publish",
    taskType: "publish",
    completionMode: "automatic",
    gateType: "hard",
    offset: 5,
    evidence: true,
  },
] as const;

const DEFAULT_DEPENDENCIES: Array<[string, string]> = [
  ["bank-reconciled", "drafts-cleared"],
  ["ar-cutoff", "drafts-cleared"],
  ["ap-cutoff", "drafts-cleared"],
  ["depreciation-posted", "drafts-cleared"],
  ["recognition-posted", "drafts-cleared"],
  ["fx-ready", "drafts-cleared"],
  ["fx-revalued", "fx-ready"],
  ["intercompany-balanced", "drafts-cleared"],
  ["consolidation", "fx-ready"],
  ["consolidation", "fx-revalued"],
  ["consolidation", "intercompany-balanced"],
  ["variance-review", "ar-cutoff"],
  ["variance-review", "ap-cutoff"],
  ["variance-review", "bank-reconciled"],
  ["variance-review", "depreciation-posted"],
  ["variance-review", "recognition-posted"],
  ["variance-review", "consolidation"],
  ["controller-approval", "variance-review"],
  ["lock-subledgers", "controller-approval"],
  ["lock-subledgers", "financial-review"],
  ["lock-gl", "lock-subledgers"],
  ["publish-package", "lock-gl"],
];

export async function ensureCloseDefaults(
  orgId: string,
  actorId?: string,
): Promise<{
  calendarId: string;
  blueprintId: string;
  reportingPackageId: string;
}> {
  // inDbTransaction (not db.transaction): when called inside a withOrg/withBypass
  // pinned transaction (e.g. org provisioning), a nested db.transaction() issues a
  // fresh BEGIN/COMMIT on the same client and prematurely commits the outer
  // transaction — clearing its SET LOCAL RLS GUCs and breaking later inserts.
  return inDbTransaction(async (tx) => {
    const closeFeatures = await defaultCloseFeatureContext(tx, orgId);
    const org = (await tx.execute<{ start_month: number; time_zone: string }>(sql`
      select coalesce((settings->>'fiscalYearStartMonth')::integer, 1) as start_month,
             coalesce(settings->>'timeZone', 'UTC') as time_zone
        from orgs where id = ${orgId}`));
    if (!org.rows[0]) throw new CloseError("organization not found");

    const existingCalendar = (await tx.execute<{ id: string }>(sql`
      select id from fiscal_calendars where org_id = ${orgId} and is_active
       order by is_default desc, created_at limit 1`));
    let calendarId = existingCalendar.rows[0]?.id;
    if (!calendarId) {
      const createdCalendar = (await tx.execute<{ id: string }>(sql`
        insert into fiscal_calendars
          (org_id, name, cadence, year_start_month, time_zone, is_default, is_active, created_by, updated_by)
        values (${orgId}, 'close.defaultData.calendar.name', 'monthly', ${org.rows[0].start_month},
                ${org.rows[0].time_zone}, true, true, ${actorId ?? null}, ${actorId ?? null})
        returning id`));
      calendarId = createdCalendar.rows[0]?.id;
    }
    if (!calendarId)
      throw new CloseError("could not initialize fiscal calendar");

    const existingBlueprint = (await tx.execute<{ id: string; name: string }>(sql`
      select id, name from close_blueprints where org_id = ${orgId} and is_active
       order by is_default desc, version desc, created_at limit 1`));
    let blueprintId = existingBlueprint.rows[0]?.id;
    let createdBlueprint = false;
    if (!blueprintId) {
      const blueprintRes = (await tx.execute<{ id: string }>(sql`
        insert into close_blueprints
          (org_id, name, description, period_type, is_default, is_active, created_by, updated_by)
        values (${orgId}, 'close.defaultData.blueprint.name', 'close.defaultData.blueprint.description',
                'any', true, true, ${actorId ?? null}, ${actorId ?? null})
        returning id`));
      blueprintId = blueprintRes.rows[0]?.id;
      createdBlueprint = true;
    }
    if (!blueprintId)
      throw new CloseError("could not initialize close blueprint");

    const systemBlueprint = createdBlueprint || existingBlueprint.rows[0]?.name === "close.defaultData.blueprint.name";
    if (systemBlueprint) {
      const stepIds = new Map<string, string>();
      for (const [index, step] of DEFAULT_STEPS.entries()) {
        const inserted = (await tx.execute<{ id: string }>(sql`
        insert into close_blueprint_steps
          (org_id, blueprint_id, key, title, description, workstream, task_type,
           completion_mode, gate_type, due_offset_business_days, evidence_required,
           sort_order, created_by, updated_by)
        values (${orgId}, ${blueprintId}, ${step.key}, ${step.title}, ${step.description},
                ${step.workstream}, ${step.taskType}, ${step.completionMode}, ${step.gateType},
                ${step.offset}, ${step.evidence}, ${(index + 1) * 10}, ${actorId ?? null}, ${actorId ?? null})
        on conflict (blueprint_id, key) do update set
          title = excluded.title, description = excluded.description,
          sort_order = excluded.sort_order, updated_at = now()
        where close_blueprint_steps.org_id = ${orgId}
        returning id`));
        stepIds.set(step.key, inserted.rows[0]!.id);
      }
      for (const [stepKey, dependencyKey] of DEFAULT_DEPENDENCIES) {
        await tx.execute(sql`
        insert into close_blueprint_dependencies
          (org_id, blueprint_id, step_id, depends_on_step_id, created_by, updated_by)
        values (${orgId}, ${blueprintId}, ${stepIds.get(stepKey)!}, ${stepIds.get(dependencyKey)!},
                ${actorId ?? null}, ${actorId ?? null})
          on conflict (step_id, depends_on_step_id) do nothing`);
      }
    }

    await tx.execute(sql`
      insert into close_policies (org_id, code, name, description, policy_type, rules, is_active, created_by, updated_by)
      values
        (${orgId}, 'controlled-reopen', 'close.defaultData.policies.controlledReopen.name', 'close.defaultData.policies.controlledReopen.description',
         'lock', ${JSON.stringify({ approvalRequired: true, defaultHours: 24 })}::jsonb, true, ${actorId ?? null}, ${actorId ?? null})
      on conflict (org_id, code) do nothing`);

    // Source-evidenced bank sign-offs (0158): the mirror may sign reconcilable
    // accounts off through the source system's reconciled date. Deactivating
    // the policy returns close readiness to statement-only evidence.
    await tx.execute(sql`
      insert into close_policies (org_id, code, name, description, policy_type, rules, is_active, created_by, updated_by)
      values
        (${orgId}, ${SOURCE_EVIDENCE_POLICY_CODE}, 'close.defaultData.policies.sourceReconciliationEvidence.name', 'close.defaultData.policies.sourceReconciliationEvidence.description',
         'evidence', ${JSON.stringify({})}::jsonb, true, ${actorId ?? null}, ${actorId ?? null})
      on conflict (org_id, code) do nothing`);

    if (closeFeatures.advancedClose) {
      await tx.execute(sql`
        insert into close_policies (org_id, code, name, description, policy_type, rules, is_active, created_by, updated_by)
        values
          (${orgId}, 'material-variance', 'close.defaultData.policies.materialVariance.name', 'close.defaultData.policies.materialVariance.description',
           'materiality', ${JSON.stringify({ amount: "10000.0000", percent: 20 })}::jsonb, true, ${actorId ?? null}, ${actorId ?? null}),
          (${orgId}, 'independent-approval', 'close.defaultData.policies.independentApproval.name', 'close.defaultData.policies.independentApproval.description',
           'segregation', ${JSON.stringify({ prohibitSelfApproval: true })}::jsonb, true, ${actorId ?? null}, ${actorId ?? null})
        on conflict (org_id, code) do nothing`);

      const closeApprovalFlow = (await tx.execute<{ id: string }>(sql`
        select id from flows where org_id = ${orgId} and subject_kind = 'close_run' limit 1
      `));
      if (!closeApprovalFlow.rows[0]) {
      const graph = {
        schemaVersion: 1,
        nodes: [
          {
            id: "request",
            position: { x: 60, y: 120 },
            data: { kind: "trigger", trigger: { trigger: "on_submit" } },
          },
          {
            id: "independent-approval",
            position: { x: 320, y: 120 },
            data: {
              kind: "gate",
              gate: {
                title: "Independent close approval",
                assignees: [{ type: "role", role: "approver" }],
                mode: "any",
                preventSelfApproval: true,
              },
            },
          },
        ],
        edges: [
          {
            id: "request-to-approval",
            source: "request",
            target: "independent-approval",
            sourceHandle: "next",
          },
        ],
      };
        await tx.execute(sql`
          insert into flows (org_id, name, description, subject_kind, enabled, graph, created_by, updated_by)
          values (${orgId}, 'Close approval',
                  'Routes the final period-close review through the configurable approval worklist.',
                  'close_run', true, ${JSON.stringify(graph)}::jsonb, ${actorId ?? null}, ${actorId ?? null})
        `);
      }
    }

    const existingPackage = (await tx.execute<{ id: string }>(sql`
      select id from close_reporting_packages where org_id = ${orgId} and is_active
       order by is_default desc, created_at limit 1`));
    let reportingPackageId = existingPackage.rows[0]?.id;
    if (!reportingPackageId) {
      const createdPackage = (await tx.execute<{ id: string }>(sql`
        insert into close_reporting_packages
          (org_id, name, description, reports, is_default, is_active, created_by, updated_by)
        values (${orgId}, 'close.defaultData.package.name', 'close.defaultData.package.description',
                ${JSON.stringify([
                  { slug: "balance-sheet" },
                  { slug: "pnl" },
                  { slug: "cash-flow" },
                  { slug: "trial-balance" },
                  { slug: "general-ledger" },
                ])}::jsonb,
                true, true, ${actorId ?? null}, ${actorId ?? null})
        returning id`));
      reportingPackageId = createdPackage.rows[0]?.id;
    }
    if (!reportingPackageId)
      throw new CloseError("could not initialize reporting package");

    return { calendarId, blueprintId, reportingPackageId };
  });
}
