import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { canonicalJson } from "./canonical-json.ts";
import { addCalendarDays, businessToday } from "./business-date.ts";
import { db, withOrg, withBypassContext, withOrgContext, inDbTransaction, type SqlExecutor } from "./db.ts";

export class CloseError extends Error {}

export const CLOSE_MODULES = [
  "ar",
  "ap",
  "banking",
  "assets",
  "tax",
  "gl",
] as const;
export type CloseModule = (typeof CLOSE_MODULES)[number];

export function periodLockBlocksPosting(
  lock: { state: string; reopenExpiresAt: Date | string | null; reason: string | null } | undefined,
  allowImportedLock: boolean,
  now = new Date(),
): boolean {
  if (!lock) return false;
  if (allowImportedLock && lock.reason === "close.importedPeriodLockReason") return false;
  return lock.state === "closed" || (
    lock.state === "open" && lock.reopenExpiresAt != null && new Date(lock.reopenExpiresAt) <= now
  );
}

export function closeModuleForDocument(kind: string): CloseModule {
  if (
    [
      "customer_invoice",
      "customer_credit",
      "customer_payment",
      "sales_order",
      "quote",
    ].includes(kind)
  )
    return "ar";
  if (
    [
      "vendor_bill",
      "vendor_credit",
      "vendor_payment",
      "purchase_order",
      "expense_report",
      "cheque",
      "card_charge",
      "card_refund",
    ].includes(kind)
  )
    return "ap";
  return "gl";
}

/** Application-level companion to the Postgres guard. It supplies a precise,
 * user-facing error before a write reaches the kernel. */
export async function assertPeriodModulesOpen(
  executor: SqlExecutor,
  args: {
    orgId: string;
    periodId: string;
    bookId: string;
    subsidiaryIds: string[];
    modules: CloseModule[];
    /** Historical source replay may cross source-owned locks, never user locks. */
    allowImportedLocks?: boolean;
  },
): Promise<void> {
  const modules = [...new Set<CloseModule>([...args.modules, "gl"])];
  const subsidiaryIds: (string | null)[] = args.subsidiaryIds.length
    ? [...new Set(args.subsidiaryIds)]
    : [null];
  for (const subsidiaryId of subsidiaryIds) {
    for (const module of modules) {
      const result = (await executor.execute<{ state: string; reopenExpiresAt: Date | string | null; reason: string | null }>(sql`
        select state, reopen_expires_at as "reopenExpiresAt", reason
          from period_locks
         where org_id = ${args.orgId} and period_id = ${args.periodId}
           and book_id = ${args.bookId} and module = ${module}
           and (subsidiary_id is not distinct from ${subsidiaryId} or subsidiary_id is null)
         order by (subsidiary_id is not null) desc
         limit 1`));
      if (periodLockBlocksPosting(result.rows[0], args.allowImportedLocks === true))
        throw new CloseError(
          `${module.toUpperCase()} is closed for this period and accounting book`,
        );
    }
  }
}

type CalendarRow = {
  id: string;
  cadence:
    | "monthly"
    | "four_four_five"
    | "four_five_four"
    | "five_four_four"
    | "thirteen_period"
    | "custom";
  year_start_month: number;
  anchor_date: string | null;
  adjustment_period_enabled: boolean;
  config: Record<string, unknown>;
};

type GeneratedPeriod = {
  fiscalYear: number;
  number: number;
  name: string;
  startsOn: string;
  endsOn: string;
  adjustment: boolean;
};

type ReadinessCheck = {
  code: string;
  taskKey: string;
  category: string;
  severity: "warning" | "error" | "critical";
  title: string;
  message: string;
  count: number;
  details?: Record<string, unknown>;
};

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
  ["variance-review", "consolidation"],
  ["controller-approval", "variance-review"],
  ["lock-subledgers", "controller-approval"],
  ["lock-subledgers", "financial-review"],
  ["lock-gl", "lock-subledgers"],
  ["publish-package", "lock-gl"],
];

type DefaultCloseFeatureContext = {
  advancedClose: boolean;
  banking: boolean;
  fixedAssets: boolean;
  multiCurrency: boolean;
  multiSubsidiary: boolean;
};

async function defaultCloseFeatureContext(
  executor: SqlExecutor,
  orgId: string,
): Promise<DefaultCloseFeatureContext> {
  const result = (await executor.execute<{
      features: Record<string, boolean>;
      entities: number;
      has_fx: boolean;
      has_assets: boolean;
    }>(sql`
    select coalesce(o.settings->'features', '{}'::jsonb) as features,
           (select count(*)::int from subsidiaries s
             where s.org_id=o.id and s.is_active and not s.is_elimination) as entities,
           (exists(select 1 from journal_lines jl where jl.org_id=o.id and jl.fx_rate <> 1)
             or exists(select 1 from fx_rates f where f.org_id=o.id)) as has_fx,
           exists(select 1 from fixed_assets fa where fa.org_id=o.id) as has_assets
      from orgs o where o.id=${orgId}
  `));
  const row = result.rows[0];
  if (!row) throw new CloseError("organization not found");
  const features = row.features ?? {};
  const flows = features.flows ?? true;
  return {
    advancedClose: flows && features.advancedClose === true,
    banking: features.banking ?? true,
    fixedAssets: (features.fixedAssets ?? true) || row.has_assets,
    multiCurrency: features.multiCurrency === true || row.has_fx,
    multiSubsidiary: features.multiSubsidiary === true || Number(row.entities) > 1,
  };
}

function defaultCloseStepEnabled(
  key: string,
  features: DefaultCloseFeatureContext,
): boolean {
  if (["ar-cutoff", "ap-cutoff", "variance-review", "controller-approval"].includes(key)) {
    return features.advancedClose;
  }
  if (key === "financial-review") return !features.advancedClose;
  if (key === "bank-reconciled") return features.banking;
  if (key === "depreciation-posted") return features.fixedAssets;
  if (["fx-ready", "fx-revalued"].includes(key)) return features.multiCurrency;
  if (["intercompany-balanced", "consolidation"].includes(key)) return features.multiSubsidiary;
  return true;
}

export async function advancedCloseEnabled(orgId: string): Promise<boolean> {
  return (await defaultCloseFeatureContext(db, orgId)).advancedClose;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function addDays(date: Date, days: number): Date {
  const out = new Date(date);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

function addBusinessDays(value: string, days: number): string {
  let date = utcDate(value);
  const direction = days < 0 ? -1 : 1;
  let remaining = Math.abs(days);
  while (remaining > 0) {
    date = addDays(date, direction);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6) remaining--;
  }
  return isoDate(date);
}

function endOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

function fiscalStartYear(fiscalYear: number, startMonth: number): number {
  return startMonth === 1 ? fiscalYear : fiscalYear - 1;
}

function periodName(
  number: number,
  fiscalYear: number,
  adjustment = false,
): string {
  return adjustment
    ? `FY${fiscalYear} adjustment`
    : `P${String(number).padStart(2, "0")} FY${fiscalYear}`;
}

function blueprintStepApplies(
  applicability: Record<string, unknown> | null,
  context: {
    fiscalYear: number;
    periodNumber: number;
    lastRegularPeriod: number;
    isAdjustment: boolean;
    bookId: string;
    subsidiaryIds: string[];
  },
): boolean {
  const rules = applicability ?? {};
  const list = (key: string): unknown[] =>
    Array.isArray(rules[key]) ? (rules[key] as unknown[]) : [];
  const bookIds = list("bookIds");
  if (bookIds.length && !bookIds.includes(context.bookId)) return false;
  const fiscalYears = list("fiscalYears").map(Number);
  if (fiscalYears.length && !fiscalYears.includes(context.fiscalYear))
    return false;
  const subsidiaries = list("subsidiaryIds").filter(
    (item): item is string => typeof item === "string",
  );
  if (
    subsidiaries.length &&
    !context.subsidiaryIds.some((id) => subsidiaries.includes(id))
  )
    return false;
  const types = list("periodTypes");
  if (types.length) {
    const actual = new Set<string>(["any"]);
    if (context.isAdjustment) actual.add("adjustment");
    else {
      actual.add("month");
      if (context.periodNumber % 3 === 0) actual.add("quarter");
      if (context.periodNumber === context.lastRegularPeriod)
        actual.add("year");
    }
    if (!types.some((type) => typeof type === "string" && actual.has(type)))
      return false;
  }
  return true;
}

function generatedPeriods(
  calendar: CalendarRow,
  fiscalYear: number,
): GeneratedPeriod[] {
  if (!Number.isInteger(fiscalYear) || fiscalYear < 1900 || fiscalYear > 9999) {
    throw new CloseError("fiscal year must be between 1900 and 9999");
  }

  let rows: GeneratedPeriod[] = [];
  if (calendar.cadence === "monthly") {
    const startYear = fiscalStartYear(fiscalYear, calendar.year_start_month);
    for (let i = 0; i < 12; i++) {
      const start = new Date(
        Date.UTC(startYear, calendar.year_start_month - 1 + i, 1),
      );
      rows.push({
        fiscalYear,
        number: i + 1,
        name: periodName(i + 1, fiscalYear),
        startsOn: isoDate(start),
        endsOn: isoDate(endOfMonth(start)),
        adjustment: false,
      });
    }
  } else if (calendar.cadence === "custom") {
    const years = (calendar.config.years ?? {}) as Record<string, unknown>;
    const configured = years[String(fiscalYear)];
    if (!Array.isArray(configured) || configured.length === 0) {
      throw new CloseError(
        `custom calendar has no period definition for FY${fiscalYear}`,
      );
    }
    rows = configured.map((raw, index) => {
      const item = raw as Record<string, unknown>;
      const startsOn = String(item.startsOn ?? "");
      const endsOn = String(item.endsOn ?? "");
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(startsOn) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(endsOn) ||
        startsOn > endsOn
      ) {
        throw new CloseError(
          `custom calendar period ${index + 1} has an invalid date range`,
        );
      }
      return {
        fiscalYear,
        number: index + 1,
        name: String(item.name ?? periodName(index + 1, fiscalYear)),
        startsOn,
        endsOn,
        adjustment: Boolean(item.adjustment),
      };
    });
  } else {
    if (!calendar.anchor_date)
      throw new CloseError("week-based calendars require an anchor date");
    const anchorFiscalYear = Number(
      calendar.config.anchorFiscalYear ??
        utcDate(calendar.anchor_date).getUTCFullYear(),
    );
    const leapWeekYears = new Set(
      Array.isArray(calendar.config.leapWeekYears)
        ? (calendar.config.leapWeekYears as unknown[]).map(Number)
        : [],
    );
    let start = utcDate(calendar.anchor_date);
    const direction = fiscalYear >= anchorFiscalYear ? 1 : -1;
    for (let year = anchorFiscalYear; year !== fiscalYear; year += direction) {
      const measuredYear = direction > 0 ? year : year - 1;
      start = addDays(
        start,
        direction * (leapWeekYears.has(measuredYear) ? 371 : 364),
      );
    }
    const weeks =
      calendar.cadence === "thirteen_period"
        ? Array(13).fill(4)
        : Array.from({ length: 4 }, () =>
            calendar.cadence === "four_four_five"
              ? [4, 4, 5]
              : calendar.cadence === "four_five_four"
                ? [4, 5, 4]
                : [5, 4, 4],
          ).flat();
    if (leapWeekYears.has(fiscalYear)) weeks[weeks.length - 1] += 1;
    let cursor = start;
    rows = weeks.map((weekCount, index) => {
      const end = addDays(cursor, weekCount * 7 - 1);
      const row = {
        fiscalYear,
        number: index + 1,
        name: periodName(index + 1, fiscalYear),
        startsOn: isoDate(cursor),
        endsOn: isoDate(end),
        adjustment: false,
      };
      cursor = addDays(end, 1);
      return row;
    });
  }

  if (
    calendar.adjustment_period_enabled &&
    !rows.some((row) => row.adjustment)
  ) {
    const final = rows.at(-1);
    if (!final) throw new CloseError("calendar generated no periods");
    rows.push({
      fiscalYear,
      number: rows.length + 1,
      name: periodName(rows.length + 1, fiscalYear, true),
      startsOn: final.endsOn,
      endsOn: final.endsOn,
      adjustment: true,
    });
  }
  return rows;
}

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
        returning id`));
        stepIds.set(step.key, inserted.rows[0].id);
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

export async function generateAccountingPeriods(
  orgId: string,
  calendarId: string,
  fiscalYear: number,
  actorId: string,
): Promise<{ created: number; updated: number; periods: GeneratedPeriod[] }> {
  const calendarRes = (await db.execute<CalendarRow>(sql`
    select id, cadence, year_start_month, anchor_date, adjustment_period_enabled, config
      from fiscal_calendars where id = ${calendarId} and org_id = ${orgId} and is_active`));
  const calendar = calendarRes.rows[0];
  if (!calendar) throw new CloseError("active fiscal calendar not found");
  const periods = generatedPeriods(calendar, fiscalYear);

  let created = 0;
  let updated = 0;
  await db.transaction(async (tx) => {
    for (const period of periods) {
      const existing = (await tx.execute<{
          id: string;
          name: string;
          starts_on: string;
          ends_on: string;
          is_adjustment: boolean;
          has_entries: boolean;
        }>(sql`
        select p.id, p.name, p.starts_on, p.ends_on, p.is_adjustment,
               exists(select 1 from journal_entries e where e.period_id = p.id) as has_entries
          from accounting_periods p
         where p.org_id = ${orgId} and p.fiscal_calendar_id = ${calendarId}
           and p.fiscal_year = ${fiscalYear} and p.period_number = ${period.number}`));
      const row = existing.rows[0];
      if (!row) {
        const inserted = (await tx.execute<{ id: string }>(sql`
          insert into accounting_periods
            (org_id, fiscal_calendar_id, fiscal_year, period_number, name, starts_on, ends_on,
             is_adjustment, created_by, updated_by)
          values (${orgId}, ${calendarId}, ${fiscalYear}, ${period.number}, ${period.name},
                  ${period.startsOn}, ${period.endsOn}, ${period.adjustment}, ${actorId}, ${actorId})
          returning id`));
        const books = (await tx.execute<{ id: string }>(sql`
          select id from accounting_books where org_id = ${orgId} and is_active`));
        for (const book of books.rows) {
          for (const module of CLOSE_MODULES) {
            await tx.execute(sql`
              insert into period_locks (org_id, period_id, book_id, module, state, created_by, updated_by)
              values (${orgId}, ${inserted.rows[0].id}, ${book.id}, ${module}, 'open', ${actorId}, ${actorId})
              on conflict (org_id, period_id, book_id, subsidiary_id, module) do nothing`);
          }
        }
        created++;
        continue;
      }
      const changed =
        row.name !== period.name ||
        row.starts_on !== period.startsOn ||
        row.ends_on !== period.endsOn ||
        row.is_adjustment !== period.adjustment;
      if (!changed) continue;
      if (row.has_entries)
        throw new CloseError(
          `${row.name} has ledger activity and its dates cannot be regenerated`,
        );
      await tx.execute(sql`
        update accounting_periods
           set name = ${period.name}, starts_on = ${period.startsOn}, ends_on = ${period.endsOn},
               is_adjustment = ${period.adjustment}, updated_at = now(), updated_by = ${actorId}
         where id = ${row.id} and org_id = ${orgId}`);
      updated++;
    }
  });
  return { created, updated, periods };
}

async function periodFingerprint(
  orgId: string,
  periodId: string,
  bookId: string,
): Promise<string> {
  const result = (await db.execute<Record<string, unknown>>(sql`
    select
      (select count(*) from journal_entries e where e.org_id = ${orgId} and e.period_id = ${periodId} and e.book_id = ${bookId}) as entries,
      (select coalesce(max(updated_at)::text, '') from journal_entries e where e.org_id = ${orgId} and e.period_id = ${periodId} and e.book_id = ${bookId}) as entry_changed,
      (select coalesce(sum(case when l.amount > 0 then l.amount else 0 end), 0)::text
         from journal_lines l join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
        where e.org_id = ${orgId} and e.period_id = ${periodId} and e.book_id = ${bookId}) as debits,
      (select count(*) from documents d
       where d.org_id = ${orgId}
         and d.posting_period_id = ${periodId}) as documents,
      (select coalesce(max(d.updated_at)::text, '') from documents d
       where d.org_id = ${orgId}
         and d.posting_period_id = ${periodId}) as document_changed,
      (select count(*) from documents d
        where d.org_id = ${orgId}
          and d.status in ('draft','pending_approval','approved','posted')
          and d.posting_period_id is null) as unassigned_documents,
      (select coalesce(max(d.updated_at)::text, '') from documents d
        where d.org_id = ${orgId}
          and d.status in ('draft','pending_approval','approved','posted')
          and d.posting_period_id is null) as unassigned_document_changed,
      (select count(*) from reconciliations r join accounting_periods p on p.id = ${periodId} and p.org_id = r.org_id
        where r.org_id = ${orgId} and r.through_date <= p.ends_on and r.status = 'signed_off') as reconciliations
  `));
  return createHash("sha256")
    .update(JSON.stringify(result.rows[0] ?? {}))
    .digest("hex");
}

async function assertCloseScope(
  executor: SqlExecutor,
  args: {
    orgId: string;
    periodId: string;
    bookId: string;
    subsidiaryIds?: string[];
  },
): Promise<void> {
  const requestedSubsidiaries = args.subsidiaryIds ?? [];
  const subsidiaryCount = requestedSubsidiaries.length
    ? sql`(select count(*)::int from subsidiaries where org_id = ${args.orgId} and is_active
        and id in (${sql.join(
          requestedSubsidiaries.map((id) => sql`${id}`),
          sql`, `,
        )}))`
    : sql`0`;
  const scope = (await executor.execute<{
      period_ok: boolean;
      book_ok: boolean;
      subsidiaries_found: number;
    }>(sql`
    select
      exists(select 1 from accounting_periods where id = ${args.periodId} and org_id = ${args.orgId}) as period_ok,
      exists(select 1 from accounting_books where id = ${args.bookId} and org_id = ${args.orgId} and is_active) as book_ok,
      ${subsidiaryCount} as subsidiaries_found
  `));
  const row = scope.rows[0];
  if (!row?.period_ok) throw new CloseError("period not found");
  if (!row.book_ok) throw new CloseError("active accounting book not found");
  const requested = new Set(requestedSubsidiaries);
  if (
    requested.size !== requestedSubsidiaries.length ||
    Number(row.subsidiaries_found) !== requested.size
  ) {
    throw new CloseError("one or more close-scope subsidiaries are invalid");
  }
}

export async function startCloseRun(args: {
  orgId: string;
  periodId: string;
  bookId: string;
  actorId: string;
  blueprintId?: string;
  reportingPackageId?: string;
  targetCloseDate?: string;
  subsidiaryIds?: string[];
}): Promise<string> {
  const defaults = await ensureCloseDefaults(args.orgId, args.actorId);
  const closeFeatures = await defaultCloseFeatureContext(db, args.orgId);
  const blueprintId = args.blueprintId ?? defaults.blueprintId;
  const reportingPackageId =
    args.reportingPackageId ?? defaults.reportingPackageId;
  await assertCloseScope(db, args);
  const periodRes = (await db.execute<{
      id: string;
      ends_on: string;
      fiscal_year: number;
      period_number: number;
      is_adjustment: boolean;
      last_regular_period: number;
    }>(sql`
    select p.id, p.ends_on, p.fiscal_year, p.period_number, p.is_adjustment,
           (select max(p2.period_number) from accounting_periods p2
             where p2.org_id = p.org_id and p2.fiscal_calendar_id = p.fiscal_calendar_id
               and p2.fiscal_year = p.fiscal_year and not p2.is_adjustment) as last_regular_period
      from accounting_periods p
     where p.id = ${args.periodId} and p.org_id = ${args.orgId}`));
  const period = periodRes.rows[0];
  if (!period) throw new CloseError("period not found");
  const configuration = (await db.execute<{ blueprint_name: string | null; package_ok: boolean }>(sql`
    select
      (select name from close_blueprints where id = ${blueprintId} and org_id = ${args.orgId} and is_active) as blueprint_name,
      (${reportingPackageId}::uuid is null or exists(
        select 1 from close_reporting_packages where id = ${reportingPackageId} and org_id = ${args.orgId} and is_active
      )) as package_ok`));
  if (!configuration.rows[0]?.blueprint_name)
    throw new CloseError("active close blueprint not found");
  const systemBlueprint = configuration.rows[0].blueprint_name === "close.defaultData.blueprint.name";
  if (!closeFeatures.advancedClose && !systemBlueprint) {
    throw new CloseError("custom close blueprints require Advanced close controls");
  }
  if (!configuration.rows[0]?.package_ok)
    throw new CloseError("active reporting package not found");
  const fingerprint = await periodFingerprint(
    args.orgId,
    args.periodId,
    args.bookId,
  );
  const targetCloseDate =
    args.targetCloseDate ?? addBusinessDays(period.ends_on, 5);

  return db
    .transaction(async (tx) => {
      const inserted = (await tx.execute<{ id: string }>(sql`
      insert into close_runs
        (org_id, period_id, book_id, blueprint_id, reporting_package_id, status,
         current_stage, target_close_date, scope, data_fingerprint, last_validated_at,
         started_at, started_by, created_by, updated_by)
      values (${args.orgId}, ${args.periodId}, ${args.bookId}, ${blueprintId}, ${reportingPackageId},
              'in_progress', 'readiness', ${targetCloseDate},
              ${JSON.stringify({ subsidiaryIds: args.subsidiaryIds ?? [] })}::jsonb,
              ${fingerprint}, now(), now(), ${args.actorId}, ${args.actorId}, ${args.actorId})
      on conflict (org_id, period_id, book_id) do update set
        status = case when close_runs.status = 'cancelled' then 'in_progress' else close_runs.status end,
        updated_at = now(), updated_by = ${args.actorId}
      returning id`));
      const runId = inserted.rows[0].id;
      const steps = (await tx.execute<any>(sql`
      select id, key, title, description, workstream, task_type, completion_mode,
             gate_type, due_offset_business_days, evidence_required, sort_order,
             default_owner_role_key, default_reviewer_role_key, applicability
        from close_blueprint_steps
       where blueprint_id = ${blueprintId} and org_id = ${args.orgId}
       order by sort_order`));
      if (steps.rows.length === 0)
        throw new CloseError("close blueprint has no steps");
      let materializedSteps = 0;
      for (const step of steps.rows) {
        if (systemBlueprint && !defaultCloseStepEnabled(step.key, closeFeatures)) continue;
        if (
          !blueprintStepApplies(step.applicability, {
            fiscalYear: Number(period.fiscal_year),
            periodNumber: Number(period.period_number),
            lastRegularPeriod: Number(period.last_regular_period),
            isAdjustment: period.is_adjustment,
            bookId: args.bookId,
            subsidiaryIds: args.subsidiaryIds ?? [],
          })
        )
          continue;
        async function userForRole(
          roleKey: string | null,
          excluding?: string,
        ): Promise<string | null> {
          if (!roleKey) return null;
          const user = (await tx.execute<{ id: string }>(sql`
          select distinct u.id from users u
            join role_assignments ra on ra.user_id = u.id and ra.org_id = u.org_id
            join app_roles ar on ar.id = ra.role_id and ar.org_id = ra.org_id
           where u.org_id = ${args.orgId} and u.is_active and ar.key = ${roleKey}
             ${excluding ? sql`and u.id <> ${excluding}` : sql``}
           order by u.id limit 1
        `));
          return user.rows[0]?.id ?? null;
        }
        const configuredOwnerId = await userForRole(
          step.default_owner_role_key,
        );
        if (step.default_owner_role_key && !configuredOwnerId) {
          throw new CloseError(
            `no active user holds owner role ${step.default_owner_role_key}`,
          );
        }
        const ownerId = configuredOwnerId ?? args.actorId;
        const reviewerId = await userForRole(
          step.default_reviewer_role_key,
          ownerId,
        );
        if (step.default_reviewer_role_key && !reviewerId) {
          throw new CloseError(
            `reviewer role ${step.default_reviewer_role_key} has no user independent from the task owner`,
          );
        }
        await tx.execute(sql`
        insert into close_run_tasks
          (org_id, run_id, blueprint_step_id, key, title, description, workstream,
           task_type, completion_mode, gate_type, status, sort_order, owner_id,
           due_on, evidence_required, created_by, updated_by)
        values (${args.orgId}, ${runId}, ${step.id}, ${step.key}, ${step.title}, ${step.description},
                ${step.workstream}, ${step.task_type}, ${step.completion_mode}, ${step.gate_type},
                'blocked', ${step.sort_order}, ${ownerId},
                ${addBusinessDays(period.ends_on, Number(step.due_offset_business_days))},
                ${step.evidence_required}, ${args.actorId}, ${args.actorId})
        on conflict (run_id, key) do nothing`);
        if (reviewerId)
          await tx.execute(sql`update close_run_tasks set reviewer_id = ${reviewerId}
        where run_id = ${runId} and key = ${step.key} and org_id = ${args.orgId}`);
        materializedSteps++;
      }
      if (materializedSteps === 0)
        throw new CloseError("no blueprint steps apply to this close scope");
      await tx.execute(sql`
      insert into close_events (org_id, run_id, event_type, actor_id, payload)
      values (${args.orgId}, ${runId}, 'run.started', ${args.actorId},
              ${JSON.stringify({ periodId: args.periodId, bookId: args.bookId, targetCloseDate })}::jsonb)`);
      return runId;
    })
    .then(async (runId) => {
      await refreshCloseRun(args.orgId, runId, args.actorId);
      await runCloseAutomations({
        orgId: args.orgId,
        runId,
        trigger: "run_started",
        eventKey: `run:${runId}:started`,
        actorId: args.actorId,
      });
      return runId;
    });
}

async function readinessChecks(
  orgId: string,
  runId: string,
): Promise<ReadinessCheck[]> {
  const context = (await db.execute<{
      period_id: string;
      book_id: string;
      starts_on: string;
      ends_on: string;
      fiscal_calendar_id: string;
      period_number: number;
      is_adjustment: boolean;
      base_currency: string;
    }>(sql`
    select r.period_id, r.book_id, p.starts_on, p.ends_on,
           p.fiscal_calendar_id, p.period_number, p.is_adjustment,
           o.base_currency
      from close_runs r
      join accounting_periods p on p.id = r.period_id and p.org_id = r.org_id
      join orgs o on o.id = r.org_id
     where r.id = ${runId} and r.org_id = ${orgId}`));
  const ctx = context.rows[0];
  if (!ctx) throw new CloseError("close run not found");

  const [drafts, missingPeriod, bank, depreciation, fx, fxReval, intercompany, variancePolicy] =
    (await Promise.all([
      db.execute(sql`
      select
        (select count(*) from journal_entries where org_id = ${orgId} and period_id = ${ctx.period_id} and book_id = ${ctx.book_id} and status = 'draft')
        +
        (select count(*) from documents
          where org_id = ${orgId} and status in ('draft','pending_approval','approved')
            and posting_period_id = ${ctx.period_id}) as count`),
      db.execute(sql`
      select count(*) as count
        from documents
       where org_id = ${orgId}
         and status in ('draft','pending_approval','approved','posted')
         and posting_period_id is null`),
      db.execute(sql`
      select count(*) as count
        from accounts a
       where a.org_id = ${orgId} and a.reconcilable and a.is_active and not a.is_summary
         and (
           exists (
             select 1 from bank_statement_lines bsl
              where bsl.org_id=${orgId} and bsl.account_id=a.id
                and bsl.posted_on between ${ctx.starts_on} and ${ctx.ends_on}
           )
           or exists (
             select 1 from journal_lines jl join journal_entries je on je.id=jl.entry_id and je.org_id=jl.org_id
              where jl.org_id=${orgId} and jl.account_id=a.id and je.period_id=${ctx.period_id}
                and je.book_id=${ctx.book_id} and je.status in ('posted','reversed')
           )
           or coalesce((
             select sum(jl.amount) from journal_lines jl
             join journal_entries je on je.id=jl.entry_id and je.org_id=jl.org_id
             join accounting_periods jp on jp.id=je.period_id and jp.org_id=je.org_id
              where jl.org_id=${orgId} and jl.account_id=a.id and je.book_id=${ctx.book_id}
                and je.status in ('posted','reversed') and jp.ends_on <= ${ctx.ends_on}
           ), 0) <> 0
         )
         and not exists (
           select 1 from reconciliations r
            where r.org_id = ${orgId} and r.account_id = a.id and r.status = 'signed_off'
              and r.through_date >= ${ctx.ends_on}
         )`),
      db.execute(sql`
      select count(*) as count
        from depreciation_schedule_lines l
        join depreciation_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
       where l.org_id = ${orgId} and l.period_id = ${ctx.period_id}
         and s.book_id = ${ctx.book_id} and l.posted_amount is null and l.planned_amount <> 0`),
      db.execute(sql`
      select count(*) as count
        from (
          select distinct l.currency
            from journal_lines l join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
           where e.org_id = ${orgId} and e.period_id = ${ctx.period_id} and e.book_id = ${ctx.book_id}
             and l.currency <> ${ctx.base_currency}
        ) c
       where not exists (
         select 1 from fx_rates f where f.org_id = ${orgId} and f.from_currency = c.currency
           and f.to_currency = ${ctx.base_currency} and f.rate_type = 'spot' and f.as_of <= ${ctx.ends_on}
       )`),
      db.execute(sql`
      select count(*) as count from (
        select l.subsidiary_id, l.currency
          from journal_lines l
          join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
          join accounting_periods ep on ep.id = e.period_id and ep.org_id = e.org_id
          join accounts a on a.id = l.account_id and a.org_id = l.org_id
          join subsidiaries s on s.id = l.subsidiary_id and s.org_id = l.org_id
         where l.org_id = ${orgId} and e.book_id = ${ctx.book_id} and e.status in ('posted', 'reversed')
           and e.origin <> 'fx_revaluation'
           and (
             ep.ends_on < ${ctx.ends_on}
             or ep.id = ${ctx.period_id}
             or (
               ${ctx.is_adjustment}
               and ep.fiscal_calendar_id = ${ctx.fiscal_calendar_id}
               and ep.ends_on = ${ctx.ends_on}
               and (
                 not ep.is_adjustment
                 or ep.period_number <= ${ctx.period_number}
               )
             )
           )
           and l.currency <> s.base_currency
           and a.type in ('asset_bank', 'asset_receivable', 'liability_payable')
         group by l.subsidiary_id, l.currency
        having sum(l.txn_amount) <> 0
      ) positions
      where not exists (
        select 1 from journal_entries r
         where r.org_id = ${orgId} and r.period_id = ${ctx.period_id} and r.book_id = ${ctx.book_id}
           and r.subsidiary_id = positions.subsidiary_id
           and r.origin = 'fx_revaluation' and r.reverses_entry_id is null
      )`),
      db.execute(sql`
      select count(*) as count from (
        select a.id
          from journal_lines l
          join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
          join accounts a on a.id = l.account_id and a.org_id = l.org_id and a.eliminate
         where e.org_id = ${orgId} and e.period_id = ${ctx.period_id} and e.book_id = ${ctx.book_id} and e.status in ('posted', 'reversed')
         group by a.id
        having sum(l.amount) <> 0
      ) residuals`),
      db.execute(sql`
      select coalesce(rules->>'amount', '10000.0000') as amount,
             coalesce((rules->>'percent')::numeric, 20) as percent
        from close_policies where org_id = ${orgId} and code = 'material-variance' and is_active limit 1`),
    ])) as any[];

  const threshold = variancePolicy.rows[0] ?? {
    amount: "10000.0000",
    percent: 20,
  };
  const variances = (await db.execute<{ count: string }>(sql`
    with current_activity as (
      select l.account_id, sum(l.amount) as amount
        from journal_lines l join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
       where e.org_id = ${orgId} and e.period_id = ${ctx.period_id} and e.book_id = ${ctx.book_id} and e.status in ('posted', 'reversed')
       group by l.account_id
    ), prior_period as (
      select p2.id from accounting_periods p2
       where p2.org_id = ${orgId} and p2.ends_on < ${ctx.starts_on} and not p2.is_adjustment
       order by p2.ends_on desc limit 1
    ), prior_activity as (
      select l.account_id, sum(l.amount) as amount
        from journal_lines l join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
       where e.org_id = ${orgId} and e.period_id = (select id from prior_period)
         and e.book_id = ${ctx.book_id} and e.status in ('posted', 'reversed')
       group by l.account_id
    )
    select count(*) as count
      from accounts a
      left join current_activity c on c.account_id = a.id
      left join prior_activity p on p.account_id = a.id
     where a.org_id = ${orgId} and not a.is_summary
       and abs(coalesce(c.amount, 0) - coalesce(p.amount, 0)) >= ${threshold.amount}::numeric
       and (
         coalesce(p.amount, 0) = 0
         or abs((coalesce(c.amount, 0) - p.amount) / nullif(abs(p.amount), 0) * 100) >= ${threshold.percent}::numeric
       )`));

  return [
    {
      code: "drafts-open",
      taskKey: "drafts-cleared",
      category: "readiness",
      severity: "critical",
      title: "close.diagnostics.drafts-open.title",
      message: "close.diagnostics.drafts-open.message",
      count: Number(drafts.rows[0]?.count ?? 0),
    },
    {
      code: "posting-period-missing",
      taskKey: "drafts-cleared",
      category: "readiness",
      severity: "critical",
      title: "close.diagnostics.posting-period-missing.title",
      message: "close.diagnostics.posting-period-missing.message",
      count: Number(missingPeriod.rows[0]?.count ?? 0),
    },
    {
      code: "bank-unreconciled",
      taskKey: "bank-reconciled",
      category: "banking",
      severity: "critical",
      title: "close.diagnostics.bank-unreconciled.title",
      message: "close.diagnostics.bank-unreconciled.message",
      count: Number(bank.rows[0]?.count ?? 0),
    },
    {
      code: "depreciation-unposted",
      taskKey: "depreciation-posted",
      category: "assets",
      severity: "error",
      title: "close.diagnostics.depreciation-unposted.title",
      message: "close.diagnostics.depreciation-unposted.message",
      count: Number(depreciation.rows[0]?.count ?? 0),
    },
    {
      code: "fx-missing",
      taskKey: "fx-ready",
      category: "foreign_exchange",
      severity: "critical",
      title: "close.diagnostics.fx-missing.title",
      message: "close.diagnostics.fx-missing.message",
      count: Number(fx.rows[0]?.count ?? 0),
    },
    {
      code: "fx-unrevalued",
      taskKey: "fx-revalued",
      category: "foreign_exchange",
      severity: "error",
      title: "close.diagnostics.fx-unrevalued.title",
      message: "close.diagnostics.fx-unrevalued.message",
      count: Number(fxReval.rows[0]?.count ?? 0),
    },
    {
      code: "intercompany-residual",
      taskKey: "intercompany-balanced",
      category: "intercompany",
      severity: "critical",
      title: "close.diagnostics.intercompany-residual.title",
      message: "close.diagnostics.intercompany-residual.message",
      count: Number(intercompany.rows[0]?.count ?? 0),
    },
    {
      code: "material-variances",
      taskKey: "variance-review",
      category: "variance",
      severity: "warning",
      title: "close.diagnostics.material-variances.title",
      message: "close.diagnostics.material-variances.message",
      count: Number(variances.rows[0]?.count ?? 0),
      details: {
        amountThreshold: threshold.amount,
        percentThreshold: Number(threshold.percent),
      },
    },
  ];
}

export async function refreshCloseRun(
  orgId: string,
  runId: string,
  actorId?: string,
): Promise<{
  readinessScore: number;
  fingerprint: string;
  invalidated: number;
  openExceptions: number;
}> {
  const runRes = (await db.execute<{
      period_id: string;
      book_id: string;
      data_fingerprint: string | null;
    }>(sql`
    select period_id, book_id, data_fingerprint from close_runs where id = ${runId} and org_id = ${orgId}`));
  const run = runRes.rows[0];
  if (!run) throw new CloseError("close run not found");
  const fingerprint = await periodFingerprint(
    orgId,
    run.period_id,
    run.book_id,
  );
  const dataChanged = Boolean(
    run.data_fingerprint && run.data_fingerprint !== fingerprint,
  );
  const availableTasks = (await db.execute<{ key: string }>(sql`
    select key from close_run_tasks where run_id=${runId} and org_id=${orgId}
  `));
  const availableTaskKeys = new Set(availableTasks.rows.map((task) => task.key));
  const checks = (await readinessChecks(orgId, runId)).filter((check) => availableTaskKeys.has(check.taskKey));
  const hardChecks = checks.filter((check) => check.severity !== "warning");
  const readinessScore = Math.round(
    (hardChecks.filter((check) => check.count === 0).length /
      Math.max(hardChecks.length, 1)) *
      100,
  );

  const outcome = await db.transaction(async (tx) => {
    let invalidated = 0;
    if (dataChanged) {
      const changed = (await tx.execute<{ id: string }>(sql`
        update close_run_tasks
           set status = 'invalidated', completed_at = null, completed_by = null,
               reviewed_at = null, reviewed_by = null, updated_at = now(), updated_by = ${actorId ?? null}
         where run_id = ${runId} and org_id = ${orgId}
           and status in ('complete','submitted') and data_fingerprint is not null
           and data_fingerprint <> ${fingerprint}
         returning id`));
      invalidated = changed.rows.length;
      await tx.execute(sql`
        update flow_gates set status = 'cancelled', updated_at = now(), updated_by = ${actorId ?? null}
         where org_id = ${orgId} and subject_kind = 'close_run' and subject_id = ${runId}
           and status in ('pending','escalated')
      `);
      await tx.execute(sql`
        update flow_runs set status = 'cancelled', finished_at = now(), updated_at = now(),
               updated_by = ${actorId ?? null}
         where org_id = ${orgId} and subject_kind = 'close_run' and subject_id = ${runId}
           and status in ('running','waiting')
      `);
      await tx.execute(sql`
        insert into close_events (org_id, run_id, event_type, actor_id, payload)
        values (${orgId}, ${runId}, 'run.data_changed', ${actorId ?? null},
                ${JSON.stringify({ invalidated })}::jsonb)`);
    }

    for (const check of checks) {
      const task = (await tx.execute<{ id: string }>(sql`
        select id from close_run_tasks where run_id = ${runId} and org_id = ${orgId} and key = ${check.taskKey}`));
      const taskId = task.rows[0]?.id ?? null;
      if (check.count > 0) {
        await tx.execute(sql`
          insert into close_exceptions
            (org_id, run_id, task_id, code, category, severity, status, title, message,
             source, details, created_by, updated_by)
          values (${orgId}, ${runId}, ${taskId}, ${check.code}, ${check.category}, ${check.severity},
                  'open', ${check.title}, ${check.message}, 'system',
                  ${JSON.stringify({ count: check.count, ...(check.details ?? {}) })}::jsonb,
                  ${actorId ?? null}, ${actorId ?? null})
          on conflict (run_id, code) do update set
            task_id = excluded.task_id, severity = excluded.severity, status = 'open',
            title = excluded.title, message = excluded.message, details = excluded.details,
            resolved_at = null, resolved_by = null, resolution = null, updated_at = now()`);
      } else {
        await tx.execute(sql`
          update close_exceptions set status = 'resolved', resolved_at = now(),
                 resolution = 'close.diagnostics.autoResolved', updated_at = now()
           where run_id = ${runId} and code = ${check.code} and status = 'open'`);
      }
      if (taskId) {
        const status = check.count === 0 ? "complete" : "ready";
        await tx.execute(sql`
          update close_run_tasks
             set status = ${status},
                 completed_at = ${check.count === 0 ? sql`now()` : sql`null`},
                 completed_by = ${check.count === 0 ? (actorId ?? null) : null},
                 data_fingerprint = ${fingerprint},
                 result = ${JSON.stringify({ count: check.count, checkedAt: new Date().toISOString() })}::jsonb,
                 updated_at = now(), updated_by = ${actorId ?? null}
           where id = ${taskId} and org_id = ${orgId} and completion_mode = 'computed'`);
      }
    }

    await resolveTaskDependenciesTx(tx, orgId, runId);
    await tx.execute(sql`
      update close_runs set readiness_score = ${readinessScore}, data_fingerprint = ${fingerprint},
             status = case when ${dataChanged} and status in ('review','approved') then 'in_progress' else status end,
             approved_at = case when ${dataChanged} and status in ('review','approved') then null else approved_at end,
             approved_by = case when ${dataChanged} and status in ('review','approved') then null else approved_by end,
             current_stage = case
               when status in ('closed','published') then 'publish'
               when status = 'approved' and not ${dataChanged} then 'lock'
               when exists (select 1 from close_exceptions x where x.run_id = ${runId}
                 and x.status = 'open' and x.severity in ('error','critical')) then 'readiness'
               when exists (select 1 from close_run_tasks t where t.run_id = ${runId}
                 and t.workstream not in ('review','publish') and t.key not like 'lock-%'
                 and t.status not in ('complete','waived')) then 'execute'
               else 'review'
             end,
             last_validated_at = now(), updated_at = now(), updated_by = ${actorId ?? null}
       where id = ${runId} and org_id = ${orgId}`);
    const open = (await tx.execute<{ count: string }>(sql`
      select count(*) as count from close_exceptions where run_id = ${runId} and status = 'open'`));
    return {
      readinessScore,
      fingerprint,
      invalidated,
      openExceptions: Number(open.rows[0]?.count ?? 0),
    };
  });
  const automationSubjects = (await db.execute<{
      task_id: string;
      task_key: string;
      status: string;
      exception_id: string | null;
      exception_code: string | null;
    }>(sql`
    select t.id as task_id, t.key as task_key, t.status,
           x.id as exception_id, x.code as exception_code
      from close_run_tasks t
      left join close_exceptions x on x.task_id = t.id and x.run_id = t.run_id and x.org_id = t.org_id and x.status = 'open'
     where t.run_id = ${runId} and t.org_id = ${orgId} and (t.status = 'ready' or x.id is not null)
  `));
  for (const subject of automationSubjects.rows) {
    if (subject.status === "ready") {
      await runCloseAutomations({
        orgId,
        runId,
        taskId: subject.task_id,
        trigger: "task_ready",
        eventKey: `task:${subject.task_key}:${fingerprint}`,
        actorId,
      });
    }
    if (subject.exception_id && subject.exception_code) {
      await runCloseAutomations({
        orgId,
        runId,
        taskId: subject.task_id,
        exceptionId: subject.exception_id,
        trigger: "exception_opened",
        eventKey: `exception:${subject.exception_code}:${fingerprint}`,
        actorId,
      });
    }
  }
  return outcome;
}

async function resolveTaskDependenciesTx(
  tx: SqlExecutor,
  orgId: string,
  runId: string,
): Promise<void> {
  await tx.execute(sql`
    update close_run_tasks t
       set status = case
         when t.status in ('complete','submitted','in_progress','changes_requested','waived') then t.status
         when exists (
           select 1
             from close_blueprint_dependencies d
             join close_run_tasks dep on dep.run_id = t.run_id and dep.blueprint_step_id = d.depends_on_step_id and dep.org_id = t.org_id
            where d.step_id = t.blueprint_step_id and d.org_id = t.org_id and dep.status not in ('complete','waived')
         ) then 'blocked'
         else 'ready'
       end,
       updated_at = now()
     where t.org_id = ${orgId} and t.run_id = ${runId}`);
}

export async function updateCloseTask(args: {
  orgId: string;
  runId: string;
  taskId: string;
  actorId: string;
  action:
    "start" | "submit" | "complete" | "approve" | "request_changes" | "waive";
  notes?: string;
}): Promise<void> {
  const fingerprintRes = (await db.execute<{ data_fingerprint: string | null }>(sql`
    select data_fingerprint from close_runs where id = ${args.runId} and org_id = ${args.orgId}`));
  const fingerprint = fingerprintRes.rows[0]?.data_fingerprint;
  if (!fingerprint)
    throw new CloseError("validate the close run before updating tasks");

  await db.transaction(async (tx) => {
    const taskRes = (await tx.execute<any>(sql`
      select t.*, (select count(*) from close_task_evidence e where e.task_id = t.id) as evidence_count
        from close_run_tasks t where t.id = ${args.taskId} and t.run_id = ${args.runId} and t.org_id = ${args.orgId}
        for update`));
    const task = taskRes.rows[0];
    if (!task) throw new CloseError("close task not found");
    if (task.status === "blocked")
      throw new CloseError("task dependencies are not complete");
    if (
      ["start", "submit", "complete"].includes(args.action) &&
      task.owner_id &&
      task.owner_id !== args.actorId
    ) {
      throw new CloseError("only the assigned owner can prepare this task");
    }
    if (
      ["approve", "request_changes"].includes(args.action) &&
      task.reviewer_id &&
      task.reviewer_id !== args.actorId
    ) {
      throw new CloseError("only the assigned reviewer can decide this task");
    }
    if (
      ["complete", "submit"].includes(args.action) &&
      task.evidence_required &&
      Number(task.evidence_count) === 0
    ) {
      throw new CloseError(
        "required evidence must be attached before this task can be completed",
      );
    }

    let status: string;
    if (args.action === "start") status = "in_progress";
    else if (args.action === "submit")
      status = task.reviewer_id ? "submitted" : "complete";
    else if (args.action === "complete") status = "complete";
    else if (args.action === "approve") {
      if (
        task.completed_by === args.actorId ||
        (!task.completed_by && task.owner_id === args.actorId)
      ) {
        throw new CloseError("preparer and reviewer must be different people");
      }
      status = "complete";
    } else if (args.action === "request_changes") status = "changes_requested";
    else status = "waived";

    await tx.execute(sql`
      update close_run_tasks set
        status = ${status}, notes = coalesce(${args.notes ?? null}, notes),
        completed_at = case when ${status} in ('complete','waived') then now() else completed_at end,
        completed_by = case when ${status} in ('complete','waived') then coalesce(completed_by, ${args.actorId}) else completed_by end,
        reviewed_at = case when ${args.action} = 'approve' then now() else reviewed_at end,
        reviewed_by = case when ${args.action} = 'approve' then ${args.actorId} else reviewed_by end,
        data_fingerprint = case when ${status} in ('complete','submitted','waived') then ${fingerprint} else data_fingerprint end,
        updated_at = now(), updated_by = ${args.actorId}
       where id = ${args.taskId} and org_id = ${args.orgId}`);
    if (["approve", "waive"].includes(args.action)) {
      await tx.execute(sql`
        insert into close_signoffs
          (org_id, run_id, task_id, signoff_type, decision, comment, data_fingerprint, signed_by)
        values (${args.orgId}, ${args.runId}, ${args.taskId},
                ${args.action === "approve" ? "review" : "waive"},
                ${args.action === "approve" ? "approved" : "waived"},
                ${args.notes ?? null}, ${fingerprint}, ${args.actorId})`);
    }
    await tx.execute(sql`
      insert into close_events (org_id, run_id, task_id, event_type, actor_id, payload)
      values (${args.orgId}, ${args.runId}, ${args.taskId}, ${`task.${args.action}`}, ${args.actorId},
              ${JSON.stringify({ status, notes: args.notes ?? null })}::jsonb)`);
    await resolveTaskDependenciesTx(tx, args.orgId, args.runId);
  });
  const ready = (await db.execute<{ id: string; key: string }>(sql`select id, key from close_run_tasks
    where run_id = ${args.runId} and org_id = ${args.orgId} and status = 'ready'`));
  for (const task of ready.rows) {
    await runCloseAutomations({
      orgId: args.orgId,
      runId: args.runId,
      taskId: task.id,
      trigger: "task_ready",
      eventKey: `task:${task.key}:${fingerprint}`,
      actorId: args.actorId,
    });
  }
}

export async function addCloseEvidence(args: {
  orgId: string;
  runId: string;
  taskId: string;
  actorId: string;
  evidenceType:
    "file" | "report" | "journal" | "reconciliation" | "link" | "note";
  label: string;
  fileId?: string;
  referenceId?: string;
  referenceUrl?: string;
  snapshot?: Record<string, unknown>;
}): Promise<string> {
  if (!args.label.trim()) throw new CloseError("evidence label is required");
  const snapshot = args.snapshot ?? {};
  const contentHash = createHash("sha256")
    .update(canonicalJson(snapshot), "utf8")
    .digest("hex");
  const inserted = (await db.execute<{ id: string }>(sql`
    insert into close_task_evidence
      (org_id, run_id, task_id, file_id, evidence_type, reference_id, reference_url,
       label, snapshot, content_hash, created_by, updated_by)
    select ${args.orgId}, ${args.runId}, t.id, ${args.fileId ?? null}, ${args.evidenceType},
           ${args.referenceId ?? null}, ${args.referenceUrl ?? null}, ${args.label.trim()},
           ${JSON.stringify(snapshot)}::jsonb, ${contentHash}, ${args.actorId}, ${args.actorId}
      from close_run_tasks t
     where t.id = ${args.taskId} and t.run_id = ${args.runId} and t.org_id = ${args.orgId}
    returning id`));
  if (!inserted.rows[0]) throw new CloseError("close task not found");
  await db.execute(sql`
    insert into close_events (org_id, run_id, task_id, event_type, actor_id, payload)
    values (${args.orgId}, ${args.runId}, ${args.taskId}, 'task.evidence_added', ${args.actorId},
            ${JSON.stringify({ evidenceId: inserted.rows[0].id, type: args.evidenceType, label: args.label.trim() })}::jsonb)`);
  return inserted.rows[0].id;
}

async function assertCloseReadyForApproval(
  executor: SqlExecutor,
  runId: string,
): Promise<void> {
  const blockers = (await executor.execute<{ tasks: string; exceptions: string }>(sql`
    select
      (select count(*) from close_run_tasks where run_id = ${runId} and gate_type = 'hard'
        and task_type <> 'approval'
        and key not in ('lock-subledgers','lock-gl','publish-package')
        and status not in ('complete','waived')) as tasks,
      (select count(*) from close_exceptions where run_id = ${runId} and status = 'open'
        and severity in ('error','critical')) as exceptions
  `));
  if (
    Number(blockers.rows[0]?.tasks ?? 0) > 0 ||
    Number(blockers.rows[0]?.exceptions ?? 0) > 0
  ) {
    throw new CloseError(
      "hard-gated tasks and critical exceptions must be resolved before approval",
    );
  }
}

/** Owner-managed close approval. This is deliberately not a silent bypass of
 * segregation of duties: it is available only while Advanced close controls
 * are off, requires an explicit attestation, fingerprints the ledger state,
 * and records an append-only signoff before the lock can be applied. */
export async function attestOwnerManagedClose(
  orgId: string,
  runId: string,
  actorId: string,
  comment: string,
): Promise<void> {
  if (await advancedCloseEnabled(orgId)) {
    throw new CloseError("Advanced close controls require independent approval");
  }
  const attestation = comment.trim();
  if (attestation.length < 10 || attestation.length > 1000) {
    throw new CloseError("enter an attestation reason between 10 and 1,000 characters");
  }
  await refreshCloseRun(orgId, runId, actorId);
  await withOrg(orgId, async () => {
    await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`close-attestation:${runId}`}))`);
    const run = (await db.execute<{ status: string; data_fingerprint: string | null }>(sql`
      select status, data_fingerprint from close_runs
       where id=${runId} and org_id=${orgId} for update
    `));
    const row = run.rows[0];
    if (!row) throw new CloseError("close run not found");
    if (row.status !== "in_progress") {
      throw new CloseError("only an in-progress close run can be attested");
    }
    if (!row.data_fingerprint) throw new CloseError("validate the close run before attesting");
    await assertCloseReadyForApproval(db, runId);
    await db.execute(sql`
      update close_runs set status='approved', current_stage='lock', approved_at=now(),
             approved_by=${actorId}, updated_at=now(), updated_by=${actorId}
       where id=${runId} and org_id=${orgId}
    `);
    await db.execute(sql`
      insert into close_signoffs
        (org_id, run_id, signoff_type, decision, comment, data_fingerprint, signed_by)
      values (${orgId}, ${runId}, 'approve', 'approved', ${attestation}, ${row.data_fingerprint}, ${actorId})
    `);
    await db.execute(sql`
      insert into close_events (org_id, run_id, event_type, actor_id, payload)
      values (${orgId}, ${runId}, 'run.owner_attested', ${actorId},
              ${JSON.stringify({ source: "owner_managed", comment: attestation })}::jsonb)
    `);
  });
}

export async function requestCloseApproval(
  orgId: string,
  runId: string,
  actorId: string,
): Promise<{ approvals: number }> {
  if (!(await advancedCloseEnabled(orgId))) {
    throw new CloseError("enable Advanced close controls to use independent approval routing");
  }
  await refreshCloseRun(orgId, runId, actorId);
  const outcome = await withOrg(orgId, async () => {
    // Serialize the status check, gate creation, and transition to review so a
    // double-click or concurrent request can never create duplicate approvals.
    await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`close-approval:${runId}`}))`);
    const run = (await db.execute<{ status: string; data_fingerprint: string | null }>(sql`
      select status, data_fingerprint from close_runs
       where id = ${runId} and org_id = ${orgId} for update
    `));
    if (!run.rows[0]) throw new CloseError("close run not found");
    if (run.rows[0].status === "review") {
      const pending = (await db.execute<{ count: number }>(sql`
        select count(*)::int as count from flow_gates
         where org_id = ${orgId} and subject_kind = 'close_run' and subject_id = ${runId}
           and status in ('pending','escalated')
      `));
      if (Number(pending.rows[0]?.count ?? 0) > 0)
        throw new CloseError("close approval is already in progress");
    } else if (run.rows[0].status !== "in_progress") {
      throw new CloseError("only an in-progress close run can be submitted for approval");
    }
    await assertCloseReadyForApproval(db, runId);

    const { runRecordFlows } = await import("./flows/index.ts");
    const result = await runRecordFlows(
      { kind: "on_submit", source: "ui" },
      "close_run",
      runId,
      { orgId, userId: actorId },
    );
    if (result.failed || result.gatesCreated === 0) {
      const flowRunIds = result.runs.map((item) => item.runId);
      if (flowRunIds.length > 0) {
        await db.execute(sql`
          update flow_gates set status = 'cancelled', updated_at = now(), updated_by = ${actorId}
           where run_id in (
             select jsonb_array_elements_text(${JSON.stringify(flowRunIds)}::jsonb)::uuid
           ) and status in ('pending','escalated')
        `);
        await db.execute(sql`
          update flow_runs set status = 'cancelled', finished_at = now(), updated_at = now(), updated_by = ${actorId}
           where id in (
             select jsonb_array_elements_text(${JSON.stringify(flowRunIds)}::jsonb)::uuid
           ) and status in ('running','waiting')
        `);
      }
      return {
        approvals: 0,
        error: result.failed
          ? "close approval routing failed"
          : "no enabled close approval flow produced an approval gate",
      };
    }

    await db.execute(sql`
      update close_runs set status = 'review', current_stage = 'review',
             approved_at = null, approved_by = null, updated_at = now(), updated_by = ${actorId}
       where id = ${runId} and org_id = ${orgId}
    `);
    await db.execute(sql`
      update close_run_tasks set status = 'submitted', data_fingerprint = ${run.rows[0].data_fingerprint},
             completed_at = null, completed_by = null, reviewed_at = null, reviewed_by = null,
             updated_at = now(), updated_by = ${actorId}
       where run_id = ${runId} and org_id = ${orgId} and task_type = 'approval'
         and status not in ('waived')
    `);
    await db.execute(sql`
      insert into close_events (org_id, run_id, event_type, actor_id, payload)
      values (${orgId}, ${runId}, 'run.approval_requested', ${actorId},
              ${JSON.stringify({ approvals: result.gatesCreated, flowRuns: result.runs.map((item) => item.runId) })}::jsonb)
    `);
    return { approvals: result.gatesCreated, error: null };
  });
  if (outcome.error) throw new CloseError(outcome.error);
  return { approvals: outcome.approvals };
}

export async function finalizeCloseFlowApproval(args: {
  orgId: string;
  runId: string;
  actorId: string | null;
  outcome: "approved" | "rejected";
}): Promise<void> {
  if (!args.actorId) throw new CloseError("a signed-in approver is required");
  // decideGate calls this inside its serialized, org-scoped transaction. Keep
  // every statement on that transaction instead of opening a nested one.
  const run = (await db.execute<{
      status: string;
      started_by: string | null;
      data_fingerprint: string | null;
      period_id: string;
      book_id: string;
    }>(sql`
    select status, started_by, data_fingerprint, period_id, book_id from close_runs
     where id = ${args.runId} and org_id = ${args.orgId} for update
  `));
  const row = run.rows[0];
  if (!row) throw new CloseError("close run not found");
  if (row.status !== "review")
    throw new CloseError("the close review changed and must be submitted again");
  if (row.started_by === args.actorId)
    throw new CloseError("the run initiator cannot provide final approval");

  const currentFingerprint = await periodFingerprint(
    args.orgId,
    row.period_id,
    row.book_id,
  );
  if (!row.data_fingerprint || row.data_fingerprint !== currentFingerprint) {
    await db.execute(sql`
      update close_run_tasks set status = 'invalidated', completed_at = null, completed_by = null,
             reviewed_at = null, reviewed_by = null, updated_at = now(), updated_by = ${args.actorId}
       where run_id = ${args.runId} and org_id = ${args.orgId}
         and status in ('complete','submitted') and data_fingerprint is not null
    `);
    await db.execute(sql`
      update flow_gates set status = 'cancelled', updated_at = now(), updated_by = ${args.actorId}
       where org_id = ${args.orgId} and subject_kind = 'close_run' and subject_id = ${args.runId}
         and status in ('pending','escalated')
    `);
    await db.execute(sql`
      update close_runs set status = 'in_progress', current_stage = 'review',
             data_fingerprint = ${currentFingerprint}, last_validated_at = now(),
             approved_at = null, approved_by = null, updated_at = now(), updated_by = ${args.actorId}
       where id = ${args.runId} and org_id = ${args.orgId}
    `);
    await db.execute(sql`
      insert into close_events (org_id, run_id, event_type, actor_id, payload)
      values (${args.orgId}, ${args.runId}, 'run.data_changed', ${args.actorId},
              ${JSON.stringify({ source: "approval" })}::jsonb)
    `);
    throw new CloseError("the ledger changed during approval; revalidate and submit the close again");
  }

  if (args.outcome === "rejected") {
    await db.execute(sql`
      update close_runs set status = 'in_progress', current_stage = 'review',
             approved_at = null, approved_by = null, updated_at = now(), updated_by = ${args.actorId}
       where id = ${args.runId} and org_id = ${args.orgId}
    `);
    await db.execute(sql`
      update close_run_tasks set status = 'changes_requested', completed_at = null, completed_by = null,
             reviewed_at = now(), reviewed_by = ${args.actorId}, updated_at = now(), updated_by = ${args.actorId}
       where run_id = ${args.runId} and org_id = ${args.orgId} and task_type = 'approval' and status <> 'waived'
    `);
    await db.execute(sql`
      insert into close_events (org_id, run_id, event_type, actor_id, payload)
      values (${args.orgId}, ${args.runId}, 'run.approval_rejected', ${args.actorId}, '{}'::jsonb)
    `);
    return;
  }

  await assertCloseReadyForApproval(db, args.runId);
  await db.execute(sql`
    update close_runs set status = 'approved', current_stage = 'lock', approved_at = now(),
           approved_by = ${args.actorId}, updated_at = now(), updated_by = ${args.actorId}
     where id = ${args.runId} and org_id = ${args.orgId}
  `);
  await db.execute(sql`
    update close_run_tasks set status = 'complete', completed_at = now(), completed_by = ${args.actorId},
           reviewed_at = now(), reviewed_by = ${args.actorId}, data_fingerprint = ${row.data_fingerprint},
           updated_at = now(), updated_by = ${args.actorId}
     where run_id = ${args.runId} and org_id = ${args.orgId} and task_type = 'approval' and status <> 'waived'
  `);
  await db.execute(sql`
    insert into close_signoffs (org_id, run_id, signoff_type, decision, data_fingerprint, signed_by)
    values (${args.orgId}, ${args.runId}, 'approve', 'approved', ${row.data_fingerprint}, ${args.actorId})
  `);
  await db.execute(sql`
    insert into close_events (org_id, run_id, event_type, actor_id, payload)
    values (${args.orgId}, ${args.runId}, 'run.approved', ${args.actorId},
            ${JSON.stringify({ source: "flow" })}::jsonb)
  `);
}

async function upsertLock(args: {
  tx: SqlExecutor;
  orgId: string;
  periodId: string;
  bookId: string;
  subsidiaryId?: string;
  module: CloseModule;
  state: "open" | "soft_closed" | "closed";
  actorId?: string;
  reason: string;
  reopenExpiresAt?: Date;
}): Promise<void> {
  await args.tx.execute(sql`
    insert into period_locks
      (org_id, period_id, book_id, subsidiary_id, module, state, locked_at, locked_by,
       reason, reopen_expires_at, created_by, updated_by)
    values (${args.orgId}, ${args.periodId}, ${args.bookId}, ${args.subsidiaryId ?? null},
            ${args.module}, ${args.state},
            ${args.state === "closed" ? sql`now()` : sql`null`}, ${args.actorId ?? null}, ${args.reason},
            ${args.reopenExpiresAt?.toISOString() ?? null}, ${args.actorId ?? null}, ${args.actorId ?? null})
    on conflict (org_id, period_id, book_id, subsidiary_id, module) do update set
      state = excluded.state, locked_at = excluded.locked_at, locked_by = excluded.locked_by,
      reason = excluded.reason, reopen_expires_at = excluded.reopen_expires_at,
      version = period_locks.version + 1, updated_at = now(), updated_by = excluded.updated_by`);
}

/** Administrative lock control used by Setup. A closed scope can only be
 * reopened through the independently approved reopen-case workflow. */
export async function setPeriodLockState(args: {
  orgId: string;
  periodId: string;
  bookId: string;
  subsidiaryId?: string;
  module: CloseModule;
  state: "open" | "soft_closed" | "closed";
  actorId: string;
  reason: string;
}): Promise<void> {
  if (!args.reason.trim())
    throw new CloseError("a lock-state reason is required");
  await db.transaction(async (tx) => {
    await assertCloseScope(tx, {
      ...args,
      subsidiaryIds: args.subsidiaryId ? [args.subsidiaryId] : [],
    });
    const current = (await tx.execute<{ state: string }>(sql`
      select state from period_locks where org_id = ${args.orgId} and period_id = ${args.periodId}
        and book_id = ${args.bookId} and subsidiary_id is not distinct from ${args.subsidiaryId ?? null}
        and module = ${args.module} for update`));
    if (args.state === "open" && current.rows[0]?.state === "closed") {
      throw new CloseError(
        "closed periods must be reopened through an approved reopen request",
      );
    }
    if (args.module === "gl" && args.state === "closed") {
      const openSubledgers = (await tx.execute<{ module: string }>(sql`
        select module from period_locks
         where org_id = ${args.orgId} and period_id = ${args.periodId} and book_id = ${args.bookId}
           and subsidiary_id is not distinct from ${args.subsidiaryId ?? null}
           and module <> 'gl' and state <> 'closed'`));
      if (openSubledgers.rows.length > 0) {
        throw new CloseError(
          `close ${openSubledgers.rows.map((row) => row.module.toUpperCase()).join(", ")} before GL`,
        );
      }
    }
    if (args.module !== "gl" && args.state === "open") {
      const gl = (await tx.execute<{ state: string }>(sql`
        select state from period_locks where org_id = ${args.orgId} and period_id = ${args.periodId}
          and book_id = ${args.bookId} and subsidiary_id is not distinct from ${args.subsidiaryId ?? null}
          and module = 'gl'`));
      if (gl.rows[0]?.state === "closed")
        throw new CloseError(
          "GL must be reopened before a subledger can be opened",
        );
    }
    await upsertLock({ ...args, tx, reason: args.reason.trim() });
    await tx.execute(sql`
      insert into close_events (org_id, event_type, actor_id, payload)
      values (${args.orgId}, 'period.lock_changed', ${args.actorId},
              ${JSON.stringify({ periodId: args.periodId, bookId: args.bookId, subsidiaryId: args.subsidiaryId ?? null, module: args.module, state: args.state, reason: args.reason.trim() })}::jsonb)`);
  });
}

export async function closeApprovedRun(
  orgId: string,
  runId: string,
  actorId: string,
): Promise<void> {
  await refreshCloseRun(orgId, runId, actorId);
  await db.transaction(async (tx) => {
    const run = (await tx.execute<{
        period_id: string;
        book_id: string;
        status: string;
        scope: { subsidiaryIds?: string[] };
      }>(sql`
      select period_id, book_id, status, scope from close_runs
       where id = ${runId} and org_id = ${orgId} for update`));
    const row = run.rows[0];
    if (!row) throw new CloseError("close run not found");
    if (row.status !== "approved")
      throw new CloseError(
        "the close run requires approval or an owner attestation before locking",
      );
    const blockers = (await tx.execute<{ count: string }>(sql`
      select count(*) as count from close_exceptions
       where run_id = ${runId} and status = 'open' and severity in ('error','critical')`));
    if (Number(blockers.rows[0].count) > 0)
      throw new CloseError(
        "critical exceptions reappeared after approval; review the run again",
      );

    const scopes = row.scope?.subsidiaryIds?.length
      ? row.scope.subsidiaryIds
      : [undefined];
    for (const subsidiaryId of scopes) {
      for (const module of CLOSE_MODULES.filter((item) => item !== "gl")) {
        await upsertLock({
          tx,
          orgId,
          periodId: row.period_id,
          bookId: row.book_id,
          subsidiaryId,
          module,
          state: "closed",
          actorId,
          reason: `Close run ${runId}`,
        });
      }
      await upsertLock({
        tx,
        orgId,
        periodId: row.period_id,
        bookId: row.book_id,
        subsidiaryId,
        module: "gl",
        state: "closed",
        actorId,
        reason: `Close run ${runId}`,
      });
    }
    await tx.execute(sql`
      update close_run_tasks set status = 'complete', completed_at = now(), completed_by = ${actorId},
             updated_at = now(), updated_by = ${actorId}
       where run_id = ${runId} and org_id = ${orgId} and key in ('lock-subledgers','lock-gl')`);
    await tx.execute(sql`
      update close_runs set status = 'closed', current_stage = 'publish', closed_at = now(),
             closed_by = ${actorId}, updated_at = now(), updated_by = ${actorId}
       where id = ${runId} and org_id = ${orgId}`);
    await tx.execute(sql`
      insert into close_events (org_id, run_id, event_type, actor_id, payload)
      values (${orgId}, ${runId}, 'run.closed', ${actorId}, ${JSON.stringify({ modules: CLOSE_MODULES })}::jsonb)`);
  });
  await runCloseAutomations({
    orgId,
    runId,
    trigger: "run_closed",
    eventKey: `run:${runId}:closed`,
    actorId,
  });
}

export async function publishCloseRun(
  orgId: string,
  runId: string,
  actorId: string,
  comment?: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const run = (await tx.execute<{ status: string; data_fingerprint: string | null }>(sql`
      select status, data_fingerprint from close_runs where id = ${runId} and org_id = ${orgId} for update`));
    if (!run.rows[0]) throw new CloseError("close run not found");
    if (run.rows[0].status !== "closed")
      throw new CloseError(
        "the period must be closed before its package can be published",
      );
    await tx.execute(sql`
      update close_run_tasks set status = 'complete', completed_at = now(), completed_by = ${actorId},
             data_fingerprint = ${run.rows[0].data_fingerprint}, updated_at = now(), updated_by = ${actorId}
       where run_id = ${runId} and org_id = ${orgId} and key = 'publish-package'`);
    await tx.execute(sql`
      update close_runs set status = 'published', current_stage = 'publish', published_at = now(),
             published_by = ${actorId}, updated_at = now(), updated_by = ${actorId}
       where id = ${runId} and org_id = ${orgId}`);
    await tx.execute(sql`
      insert into close_signoffs (org_id, run_id, signoff_type, decision, comment, data_fingerprint, signed_by)
      values (${orgId}, ${runId}, 'publish', 'approved', ${comment ?? null}, ${run.rows[0].data_fingerprint}, ${actorId})`);
    await tx.execute(sql`
      insert into close_events (org_id, run_id, event_type, actor_id, payload)
      values (${orgId}, ${runId}, 'run.published', ${actorId}, ${JSON.stringify({ comment: comment ?? null })}::jsonb)`);
    const [publishedRun, tasks, evidence, exceptions, signoffs, events, locks] =
      (await Promise.all([
        tx.execute(sql`select r.*, p.name as period_name, p.starts_on, p.ends_on, b.code as book_code, b.name as book_name,
        bp.name as blueprint_name, bp.version as blueprint_version, pkg.name as package_name, pkg.reports as package_reports
        from close_runs r join accounting_periods p on p.id = r.period_id and p.org_id = r.org_id join accounting_books b on b.id = r.book_id and b.org_id = r.org_id
        join close_blueprints bp on bp.id = r.blueprint_id and bp.org_id = r.org_id left join close_reporting_packages pkg on pkg.id = r.reporting_package_id and pkg.org_id = r.org_id
        where r.id = ${runId} and r.org_id = ${orgId}`),
        tx.execute(
          sql`select * from close_run_tasks where run_id = ${runId} and org_id = ${orgId} order by sort_order, id`,
        ),
        tx.execute(
          sql`select * from close_task_evidence where run_id = ${runId} and org_id = ${orgId} order by created_at, id`,
        ),
        tx.execute(
          sql`select * from close_exceptions where run_id = ${runId} and org_id = ${orgId} order by created_at, id`,
        ),
        tx.execute(
          sql`select * from close_signoffs where run_id = ${runId} and org_id = ${orgId} order by signed_at, id`,
        ),
        tx.execute(
          sql`select * from close_events where run_id = ${runId} and org_id = ${orgId} order by at, id`,
        ),
        tx.execute(sql`select * from period_locks where org_id = ${orgId} and period_id = (select period_id from close_runs where id = ${runId} and org_id = ${orgId})
        and book_id = (select book_id from close_runs where id = ${runId} and org_id = ${orgId}) order by subsidiary_id nulls first, module`),
      ])) as any[];
    const snapshot = {
      format: "openbooks.close-binder.v1",
      frozenAt: new Date().toISOString(),
      run: publishedRun.rows[0],
      tasks: tasks.rows,
      evidence: evidence.rows,
      exceptions: exceptions.rows,
      signoffs: signoffs.rows,
      events: events.rows,
      locks: locks.rows,
    };
    const binderHash = createHash("sha256")
      .update(canonicalJson(snapshot), "utf8")
      .digest("hex");
    await tx.execute(sql`
      update close_runs set binder_snapshot = ${JSON.stringify(snapshot)}::jsonb, binder_hash = ${binderHash}
       where id = ${runId} and org_id = ${orgId}`);
  });

  // Deliver the reporting package once the publish has durably committed (a
  // Redis enqueue isn't transactional with the DB, and delivery must never fire
  // for a rolled-back publish). Best-effort: the worker itself skips manual
  // cadence / no recipients, and a queue outage must not fail publication.
  const packageRow = (await db.execute<{ reporting_package_id: string | null }>(sql`
    select reporting_package_id from close_runs where id = ${runId} and org_id = ${orgId}`));
  const packageId = packageRow.rows[0]?.reporting_package_id;
  if (packageId) {
    try {
      const { enqueueCloseDelivery } = await import("@openbooks/jobs");
      await enqueueCloseDelivery(
        { orgId, runId, packageId },
        { jobId: `close-package|${runId}` },
      );
    } catch (error) {
      console.error("[close] failed to enqueue package delivery:", error);
    }
  }
}

export async function requestPeriodReopen(args: {
  orgId: string;
  periodId: string;
  bookId: string;
  subsidiaryId?: string;
  modules: CloseModule[];
  reason: string;
  actorId: string;
}): Promise<string> {
  if (!args.reason.trim())
    throw new CloseError("a reopening reason is required");
  if (
    args.modules.length === 0 ||
    args.modules.some((module) => !CLOSE_MODULES.includes(module))
  ) {
    throw new CloseError("at least one valid module is required");
  }
  await assertCloseScope(db, {
    ...args,
    subsidiaryIds: args.subsidiaryId ? [args.subsidiaryId] : [],
  });
  const impact = (await db.execute<Record<string, unknown>>(sql`
    select
      (select count(*) from journal_entries where org_id = ${args.orgId} and period_id = ${args.periodId} and book_id = ${args.bookId}) as entries,
      (select count(*) from close_signoffs s join close_runs r on r.id = s.run_id and r.org_id = s.org_id
        where r.org_id = ${args.orgId} and r.period_id = ${args.periodId} and r.book_id = ${args.bookId}) as signoffs,
      (select count(*) from close_task_evidence e join close_runs r on r.id = e.run_id and r.org_id = e.org_id
        where r.org_id = ${args.orgId} and r.period_id = ${args.periodId} and r.book_id = ${args.bookId}) as evidence`));
  const inserted = (await db.execute<{ id: string }>(sql`
    insert into close_reopen_requests
      (org_id, period_id, book_id, subsidiary_id, modules, reason, impact_snapshot,
       requested_by, created_by, updated_by)
    values (${args.orgId}, ${args.periodId}, ${args.bookId}, ${args.subsidiaryId ?? null},
            ${JSON.stringify(args.modules)}::jsonb, ${args.reason.trim()},
            ${JSON.stringify({ ...impact.rows[0], reports: ["balance-sheet", "pnl", "cash-flow", "trial-balance"] })}::jsonb,
            ${args.actorId}, ${args.actorId}, ${args.actorId})
    returning id`));
  return inserted.rows[0].id;
}

export async function decidePeriodReopen(args: {
  orgId: string;
  requestId: string;
  actorId: string;
  approve: boolean;
  hours?: number;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const request = (await tx.execute<any>(sql`
      select * from close_reopen_requests
       where id = ${args.requestId} and org_id = ${args.orgId} and status = 'requested'
       for update`));
    const row = request.rows[0];
    if (!row) throw new CloseError("pending reopen request not found");
    if (row.requested_by === args.actorId)
      throw new CloseError("a reopen request requires independent approval");
    if (!args.approve) {
      await tx.execute(sql`
        update close_reopen_requests set status = 'rejected', approved_by = ${args.actorId},
               approved_at = now(), updated_at = now(), updated_by = ${args.actorId}
         where id = ${args.requestId} and org_id = ${args.orgId}`);
      return;
    }
    const policy = (await tx.execute<{ rules: { defaultHours?: number; maxHours?: number } }>(sql`select rules from close_policies
      where org_id = ${args.orgId} and code = 'controlled-reopen' and is_active limit 1`));
    const defaultHours = Number(policy.rows[0]?.rules?.defaultHours ?? 24);
    const maxHours = Math.max(
      1,
      Number(policy.rows[0]?.rules?.maxHours ?? 168),
    );
    const requestedHours = Number.isFinite(args.hours)
      ? Math.trunc(args.hours!)
      : defaultHours;
    const hours = Math.min(Math.max(requestedHours, 1), maxHours);
    const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
    const modules = row.modules as CloseModule[];
    if (modules.some((module) => !CLOSE_MODULES.includes(module)))
      throw new CloseError("reopen request contains an invalid module");
    await tx.execute(sql`
      select pg_advisory_xact_lock(
        hashtextextended(
          ${`close-reopen:${args.orgId}:${row.period_id}:${row.book_id}:${row.subsidiary_id ?? "all"}`},
          0
        )
      )
    `);
    const activeRequests = (await tx.execute<{ id: string; modules: CloseModule[] }>(sql`
      select id, modules
        from close_reopen_requests
       where org_id = ${args.orgId}
         and period_id = ${row.period_id}
         and book_id = ${row.book_id}
         and subsidiary_id is not distinct from ${row.subsidiary_id}
         and id <> ${args.requestId}
         and status = 'approved'
         and expires_at > now()
       for update`));
    const overlap = activeRequests.rows.find((request) =>
      request.modules.some((module) => modules.includes(module)),
    );
    if (overlap) {
      throw new CloseError(
        `reopen request overlaps active request ${overlap.id}`,
      );
    }
    if (modules.some((module) => module !== "gl") && !modules.includes("gl")) {
      const gl = (await tx.execute<{ state: string }>(sql`
        select state from period_locks where org_id = ${args.orgId} and period_id = ${row.period_id}
          and book_id = ${row.book_id} and subsidiary_id is not distinct from ${row.subsidiary_id}
          and module = 'gl'`));
      if (gl.rows[0]?.state === "closed")
        throw new CloseError(
          "GL must be included before a closed subledger can be reopened",
        );
    }
    for (const module of modules) {
      await upsertLock({
        tx,
        orgId: args.orgId,
        periodId: row.period_id,
        bookId: row.book_id,
        subsidiaryId: row.subsidiary_id ?? undefined,
        module,
        state: "open",
        actorId: args.actorId,
        reason: row.reason,
        reopenExpiresAt: expiresAt,
      });
    }
    await tx.execute(sql`
      update close_reopen_requests set status = 'approved', approved_by = ${args.actorId},
             approved_at = now(), expires_at = ${expiresAt.toISOString()}, updated_at = now(), updated_by = ${args.actorId}
       where id = ${args.requestId} and org_id = ${args.orgId}`);
    await tx.execute(sql`
      update close_runs set status = 'in_progress', current_stage = 'review', approved_at = null,
             approved_by = null, closed_at = null, closed_by = null, published_at = null,
             published_by = null, updated_at = now(), updated_by = ${args.actorId}
       where org_id = ${args.orgId} and period_id = ${row.period_id} and book_id = ${row.book_id}`);
    await tx.execute(sql`
      update close_run_tasks t set status = 'invalidated', completed_at = null, completed_by = null,
             reviewed_at = null, reviewed_by = null, updated_at = now(), updated_by = ${args.actorId}
       from close_runs r where r.id = t.run_id and r.org_id = ${args.orgId}
         and r.period_id = ${row.period_id} and r.book_id = ${row.book_id}
         and t.status in ('complete','waived')`);
  });
}

async function recloseApprovedReopenRow(args: {
  tx: SqlExecutor;
  row: any;
  actorId?: string;
  reason: string;
  automatic: boolean;
}): Promise<void> {
  const modules = args.row.modules as CloseModule[];
  if (
    modules.length === 0 ||
    modules.some((module) => !CLOSE_MODULES.includes(module))
  ) {
    throw new CloseError("reopen request contains an invalid module");
  }
  await args.tx.execute(sql`
    select pg_advisory_xact_lock(
      hashtextextended(
        ${`close-reopen:${args.row.org_id}:${args.row.period_id}:${args.row.book_id}:${args.row.subsidiary_id ?? "all"}`},
        0
      )
    )
  `);
  const overlapping = (await args.tx.execute<{ id: string; modules: CloseModule[] }>(sql`
    select id, modules
      from close_reopen_requests
     where org_id = ${args.row.org_id}
       and period_id = ${args.row.period_id}
       and book_id = ${args.row.book_id}
       and subsidiary_id is not distinct from ${args.row.subsidiary_id}
       and id <> ${args.row.id}
       and status = 'approved'
       and expires_at > now()
     for update`));
  const coveredModules = new Set(
    overlapping.rows.flatMap((request) =>
      request.modules.filter((module) => modules.includes(module)),
    ),
  );
  const modulesToClose = modules.filter((module) => !coveredModules.has(module));

  for (const module of modulesToClose.filter((item) => item !== "gl")) {
    await upsertLock({
      tx: args.tx,
      orgId: args.row.org_id,
      periodId: args.row.period_id,
      bookId: args.row.book_id,
      subsidiaryId: args.row.subsidiary_id ?? undefined,
      module,
      state: "closed",
      actorId: args.actorId,
      reason: `${args.automatic ? "Automatic" : "Controlled"} re-close: ${args.reason}`,
    });
  }
  if (modulesToClose.includes("gl")) {
    const openSubledgers = (await args.tx.execute<{ module: CloseModule }>(sql`
      select module
        from period_locks
       where org_id = ${args.row.org_id}
         and period_id = ${args.row.period_id}
         and book_id = ${args.row.book_id}
         and subsidiary_id is not distinct from ${args.row.subsidiary_id}
         and module <> 'gl'
         and state <> 'closed'
       for update`));
    if (openSubledgers.rows.length > 0) {
      throw new CloseError(
        `cannot re-close GL while ${openSubledgers.rows
          .map((item) => item.module.toUpperCase())
          .join(", ")} remains open`,
      );
    }
    await upsertLock({
      tx: args.tx,
      orgId: args.row.org_id,
      periodId: args.row.period_id,
      bookId: args.row.book_id,
      subsidiaryId: args.row.subsidiary_id ?? undefined,
      module: "gl",
      state: "closed",
      actorId: args.actorId,
      reason: `${args.automatic ? "Automatic" : "Controlled"} re-close: ${args.reason}`,
    });
  }
  const finalStatus =
    args.automatic && coveredModules.size > 0 ? "expired" : "reclosed";
  const updated = await args.tx.execute(sql`
    update close_reopen_requests
       set status = ${finalStatus},
           reclosed_at = ${finalStatus === "reclosed" ? sql`now()` : sql`null`},
           updated_at = now(),
           updated_by = ${args.actorId ?? null}
     where id = ${args.row.id} and org_id = ${args.row.org_id} and status = 'approved'
    returning id`);
  if (updated.rows.length !== 1) {
    throw new CloseError("approved reopen request changed during re-close");
  }
  await args.tx.execute(sql`
    insert into close_events (org_id, event_type, actor_id, payload)
    values (${args.row.org_id},
            ${
              args.automatic
                ? coveredModules.size > 0
                  ? "period.reopen_expired_with_overlap"
                  : "period.automatically_reclosed"
                : coveredModules.size > 0
                  ? "period.controlled_reclosed_with_overlap"
                  : "period.controlled_reclosed"
            },
            ${args.actorId ?? null},
            ${JSON.stringify({
              requestId: args.row.id,
              periodId: args.row.period_id,
              bookId: args.row.book_id,
              modules,
              modulesClosed: modulesToClose,
              modulesStillOpen: [...coveredModules],
              overlappingRequestIds: overlapping.rows.map((row) => row.id),
              reason: args.reason,
            })}::jsonb)`);
}

/** End an approved reopen window immediately after controlled work completes.
 * The original approval remains immutable; the actor, timestamp and reason for
 * ending the window are appended to the close event stream. */
export async function recloseApprovedReopen(args: {
  orgId: string;
  requestId: string;
  actorId: string;
  reason: string;
}): Promise<void> {
  const reason = args.reason.trim();
  if (reason.length < 10 || reason.length > 500) {
    throw new CloseError("a 10-500 character re-close reason is required");
  }
  await db.transaction(async (tx) => {
    const request = (await tx.execute<any>(sql`
      select *
        from close_reopen_requests
       where id = ${args.requestId}
         and org_id = ${args.orgId}
         and status = 'approved'
       for update`));
    const row = request.rows[0];
    if (!row) throw new CloseError("approved reopen request not found");
    await recloseApprovedReopenRow({
      tx,
      row,
      actorId: args.actorId,
      reason,
      automatic: false,
    });
  });
}

export async function recloseExpiredReopens(actorId?: string): Promise<number> {
  // Finding expired reopen windows spans organizations and crosses an explicit
  // trusted boundary; each re-close then commits inside its own tenant. The
  // scheduler tick that calls this holds no request store, so without the
  // boundary RLS denies by default and no window is ever closed again.
  const expired = await withBypassContext(() =>
    db.execute<any>(sql`
    select request.id, request.org_id, request.period_id, request.book_id,
           request.subsidiary_id, request.modules, request.reason
      from close_reopen_requests request
      join orgs organization on organization.id = request.org_id
     where request.status = 'approved' and request.expires_at <= now()
       and organization.env_kind = 'production'`));
  for (const row of expired.rows) {
    await withOrgContext(row.org_id, () =>
      db.transaction(async (tx) => {
      const locked = (await tx.execute<any>(sql`
        select *
          from close_reopen_requests
         where id = ${row.id}
           and org_id = ${row.org_id}
           and status = 'approved'
           and expires_at <= now()
         for update`));
      if (!locked.rows[0]) return;
      await recloseApprovedReopenRow({
        tx,
        row: locked.rows[0],
        actorId,
        reason: locked.rows[0].reason,
        automatic: true,
      });
    }));
  }
  return expired.rows.length;
}

type CloseAutomationTrigger =
  | "run_started"
  | "task_ready"
  | "exception_opened"
  | "deadline_approaching"
  | "run_closed";

type CloseAutomationContext = {
  orgId: string;
  runId: string;
  trigger: CloseAutomationTrigger;
  eventKey: string;
  actorId?: string;
  taskId?: string;
  exceptionId?: string;
};

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      )
    : [];
}

function conditionMatches(expected: unknown, actual: unknown): boolean {
  if (expected == null) return true;
  return Array.isArray(expected)
    ? expected.includes(actual)
    : expected === actual;
}

/** Execute tenant-authored close automation with an idempotent database claim.
 * A failed action is retained for audit and never reported as successful. */
export async function runCloseAutomations(
  context: CloseAutomationContext,
): Promise<{ completed: number; failed: number }> {
  // Tenant-authored deadline/task automations are the Advanced Close layer.
  // Core close (start, attest, lock) still runs; existing rules are preserved.
  if (!(await advancedCloseEnabled(context.orgId))) return { completed: 0, failed: 0 };
  const runResult = (await db.execute<any>(sql`
    select r.*, p.name as period_name, b.name as book_name,
           t.key as task_key, t.workstream, t.status as task_status,
           x.severity as exception_severity, x.code as exception_code
      from close_runs r
      join accounting_periods p on p.id = r.period_id and p.org_id = r.org_id
      join accounting_books b on b.id = r.book_id and b.org_id = r.org_id
      left join close_run_tasks t on t.id = ${context.taskId ?? null} and t.run_id = r.id and t.org_id = r.org_id
      left join close_exceptions x on x.id = ${context.exceptionId ?? null} and x.run_id = r.id and x.org_id = r.org_id
     where r.id = ${context.runId} and r.org_id = ${context.orgId}
  `));
  const run = runResult.rows[0];
  if (!run) throw new CloseError("close run not found");
  const rules = (await db.execute<any>(sql`
    select * from close_automation_rules
     where org_id = ${context.orgId} and trigger = ${context.trigger} and is_active
     order by created_at, id
  `));
  let completed = 0;
  let failed = 0;
  for (const rule of rules.rows) {
    const conditions = (rule.conditions ?? {}) as Record<string, unknown>;
    const daysUntilDeadline = Math.ceil(
      (new Date(`${run.target_close_date}T00:00:00Z`).getTime() - Date.now()) /
        86_400_000,
    );
    if (
      !conditionMatches(conditions.runStatus, run.status) ||
      !conditionMatches(conditions.taskKey, run.task_key) ||
      !conditionMatches(conditions.workstream, run.workstream) ||
      !conditionMatches(conditions.taskStatus, run.task_status) ||
      !conditionMatches(conditions.severity, run.exception_severity) ||
      (typeof conditions.minReadiness === "number" &&
        Number(run.readiness_score) < conditions.minReadiness) ||
      (typeof conditions.maxReadiness === "number" &&
        Number(run.readiness_score) > conditions.maxReadiness) ||
      (typeof conditions.withinDays === "number" &&
        daysUntilDeadline > conditions.withinDays)
    )
      continue;

    const claim = (await db.execute<{ id: string }>(sql`
      insert into close_automation_executions
        (org_id, rule_id, run_id, task_id, trigger, event_key, status, created_by, updated_by)
      values (${context.orgId}, ${rule.id}, ${context.runId}, ${context.taskId ?? null}, ${context.trigger},
              ${context.eventKey}, 'running', ${context.actorId ?? null}, ${context.actorId ?? null})
      on conflict (rule_id, event_key) do nothing returning id
    `));
    const executionId = claim.rows[0]?.id;
    if (!executionId) continue;
    try {
      const config = (rule.config ?? {}) as Record<string, unknown>;
      if (rule.action === "notify") {
        const users = new Map<string, { id: string }>();
        if (stringList(config.userIds).length) {
          const direct =
            (await db.execute<{ id: string }>(sql`select id from users where org_id = ${context.orgId} and is_active
            and id in (${sql.join(
              stringList(config.userIds).map((id) => sql`${id}`),
              sql`, `,
            )})`));
          for (const user of direct.rows) users.set(user.id, user);
        }
        for (const role of stringList(config.roleKeys)) {
          const roleUsers = (await db.execute<{ id: string }>(sql`
            select distinct u.id from users u
              join role_assignments ra on ra.user_id = u.id and ra.org_id = u.org_id
              join app_roles ar on ar.id = ra.role_id and ar.org_id = ra.org_id
             where u.org_id = ${context.orgId} and u.is_active and ar.key = ${role}
          `));
          for (const user of roleUsers.rows) users.set(user.id, user);
        }
        if (users.size === 0 && run.started_by)
          users.set(run.started_by, { id: run.started_by });
        if (users.size === 0)
          throw new CloseError(
            "notification automation resolved no recipients",
          );
        for (const user of users.values()) {
          await db.execute(sql`insert into notifications (org_id, user_id, kind, title, body, href, created_by, updated_by)
            values (${context.orgId}, ${user.id}, 'close', ${String(config.title ?? rule.name)},
                    ${String(config.body ?? `${run.period_name} · ${run.book_name}`)}, ${`/close?run=${context.runId}`},
                    ${context.actorId ?? null}, ${context.actorId ?? null})`);
        }
      } else if (rule.action === "assign") {
        if (!context.taskId)
          throw new CloseError("assignment automation requires a task event");
        async function resolveUser(
          userValue: unknown,
          roleValue: unknown,
        ): Promise<string | null> {
          if (typeof userValue === "string") {
            const direct = (await db.execute<{ id: string }>(
              sql`select id from users where id = ${userValue} and org_id = ${context.orgId} and is_active`,
            ));
            if (direct.rows[0]) return direct.rows[0].id;
          }
          if (typeof roleValue === "string") {
            const byRole =
              (await db.execute<{ id: string }>(sql`select distinct u.id from users u
              join role_assignments ra on ra.user_id = u.id and ra.org_id = u.org_id
              join app_roles ar on ar.id = ra.role_id and ar.org_id = ra.org_id
              where u.org_id = ${context.orgId} and u.is_active and ar.key = ${roleValue}
              order by u.id limit 1`));
            if (byRole.rows[0]) return byRole.rows[0].id;
          }
          return null;
        }
        const ownerId = await resolveUser(
          config.ownerUserId,
          config.ownerRoleKey,
        );
        const reviewerId = await resolveUser(
          config.reviewerUserId,
          config.reviewerRoleKey,
        );
        if (!ownerId && !reviewerId)
          throw new CloseError(
            "assignment automation resolved no owner or reviewer",
          );
        await db.execute(sql`update close_run_tasks set owner_id = coalesce(${ownerId}, owner_id),
          reviewer_id = coalesce(${reviewerId}, reviewer_id), updated_at = now(), updated_by = ${context.actorId ?? null}
          where id = ${context.taskId} and run_id = ${context.runId} and org_id = ${context.orgId}`);
      } else if (rule.action === "run_check") {
        await refreshCloseRun(context.orgId, context.runId, context.actorId);
      } else if (rule.action === "complete_task") {
        if (!context.taskId)
          throw new CloseError(
            "complete-task automation requires a task event",
          );
        await db.transaction(async (tx) => {
          const task = (await tx.execute<{ evidence_required: boolean; evidence_count: string }>(sql`select evidence_required,
            (select count(*) from close_task_evidence e where e.task_id = t.id and e.org_id = t.org_id) as evidence_count
            from close_run_tasks t where t.id = ${context.taskId} and t.run_id = ${context.runId}
              and t.org_id = ${context.orgId} for update`));
          if (!task.rows[0]) throw new CloseError("automation task not found");
          if (
            task.rows[0].evidence_required &&
            Number(task.rows[0].evidence_count) === 0
          ) {
            throw new CloseError(
              "automatic task requires evidence before completion",
            );
          }
          await tx.execute(sql`update close_run_tasks set status = 'complete', completed_at = now(),
            completed_by = ${context.actorId ?? run.started_by ?? null}, data_fingerprint = ${run.data_fingerprint},
            updated_at = now(), updated_by = ${context.actorId ?? null}
            where id = ${context.taskId} and run_id = ${context.runId} and org_id = ${context.orgId} and status not in ('complete','waived')`);
          await resolveTaskDependenciesTx(tx, context.orgId, context.runId);
        });
        await refreshCloseRun(context.orgId, context.runId, context.actorId);
      } else if (rule.action === "create_task") {
        const key =
          typeof config.key === "string" &&
          /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.key)
            ? config.key
            : `automation-${rule.id}`;
        await db.execute(sql`insert into close_run_tasks
          (org_id, run_id, key, title, description, workstream, task_type, completion_mode, gate_type,
           status, sort_order, owner_id, due_on, evidence_required, created_by, updated_by)
          values (${context.orgId}, ${context.runId}, ${key}, ${String(config.title ?? rule.name)},
                  ${typeof config.description === "string" ? config.description : null},
                  ${String(config.workstream ?? "review")}, 'action', 'manual', ${String(config.gateType ?? "none")},
                  'ready', 9000, ${context.actorId ?? run.started_by ?? null}, ${run.target_close_date},
                  ${config.evidenceRequired === true}, ${context.actorId ?? null}, ${context.actorId ?? null})
          on conflict (run_id, key) do nothing`);
      } else if (rule.action === "generate_report") {
        const report = String(config.report ?? "trial-balance");
        const target =
          (await db.execute<{ id: string }>(sql`select id from close_run_tasks where run_id = ${context.runId} and org_id = ${context.orgId}
          and id = coalesce(${context.taskId ?? null}, id) order by case when key = 'publish-package' then 0 else 1 end, sort_order limit 1`));
        if (!target.rows[0])
          throw new CloseError(
            "report automation could not resolve an evidence task",
          );
        const snapshot = {
          report,
          periodId: run.period_id,
          bookId: run.book_id,
          generatedAt: new Date().toISOString(),
          fingerprint: run.data_fingerprint,
        };
        const hash = createHash("sha256")
          .update(canonicalJson(snapshot), "utf8")
          .digest("hex");
        await db.execute(sql`insert into close_task_evidence
          (org_id, run_id, task_id, evidence_type, reference_url, label, snapshot, content_hash, created_by, updated_by)
          values (${context.orgId}, ${context.runId}, ${target.rows[0].id}, 'report',
                  ${`/reports/${report}?period=${run.period_id}&book=${run.book_id}`}, ${String(config.label ?? report)},
                  ${JSON.stringify(snapshot)}::jsonb, ${hash}, ${context.actorId ?? null}, ${context.actorId ?? null})`);
      } else if (rule.action === "start_flow") {
        const subjectKind =
          typeof config.subjectKind === "string" ? config.subjectKind : "";
        const subjectId =
          config.subjectId === "$task"
            ? context.taskId
            : config.subjectId === "$run"
              ? context.runId
              : config.subjectId;
        const buttonId =
          typeof config.buttonId === "string" ? config.buttonId : "";
        if (!subjectKind || typeof subjectId !== "string" || !buttonId)
          throw new CloseError(
            "flow automation requires subjectKind, subjectId, and buttonId",
          );
        const { runRecordFlows } = await import("./flows/index.ts");
        const result = await runRecordFlows(
          { kind: "manual", buttonId, source: "close_automation" },
          subjectKind,
          subjectId,
          {
            orgId: context.orgId,
            userId: context.actorId,
          },
        );
        if (result.runs.length === 0)
          throw new CloseError("flow automation matched no enabled flow");
        if (result.runs.some((item) => item.status === "failed"))
          throw new CloseError("one or more started flows failed");
      } else {
        throw new CloseError(
          `unsupported close automation action: ${rule.action}`,
        );
      }
      await db.execute(sql`update close_automation_executions set status = 'completed', executed_at = now(),
        updated_at = now(), updated_by = ${context.actorId ?? null} where id = ${executionId} and org_id = ${context.orgId}`);
      await db.execute(sql`insert into close_events (org_id, run_id, task_id, event_type, actor_id, payload)
        values (${context.orgId}, ${context.runId}, ${context.taskId ?? null}, 'automation.completed', ${context.actorId ?? null},
                ${JSON.stringify({ ruleId: rule.id, executionId, trigger: context.trigger, action: rule.action })}::jsonb)`);
      completed++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db.execute(sql`update close_automation_executions set status = 'failed', error = ${message}, executed_at = now(),
        updated_at = now(), updated_by = ${context.actorId ?? null} where id = ${executionId} and org_id = ${context.orgId}`);
      await db.execute(sql`insert into close_events (org_id, run_id, task_id, event_type, actor_id, payload)
        values (${context.orgId}, ${context.runId}, ${context.taskId ?? null}, 'automation.failed', ${context.actorId ?? null},
                ${JSON.stringify({ ruleId: rule.id, executionId, trigger: context.trigger, action: rule.action, error: message })}::jsonb)`);
      failed++;
    }
  }
  return { completed, failed };
}

/** Scheduler entrypoint. Each run/rule/day is idempotent across processes. */
export async function runDueCloseAutomations(): Promise<number> {
  // Org-spanning discovery crosses an explicit trusted boundary; each rule then
  // executes inside its own tenant. Without this the contextless scheduler tick
  // is denied by default and no deadline automation ever runs.
  const due = await withBypassContext(() =>
    db.execute<{ org_id: string; id: string; target_close_date: string }>(sql`
    select distinct r.org_id, r.id, r.target_close_date::text as target_close_date
      from close_runs r
      join close_automation_rules a on a.org_id = r.org_id and a.trigger = 'deadline_approaching' and a.is_active
      join orgs organization on organization.id = r.org_id and organization.env_kind = 'production'
     where r.status in ('in_progress','review','approved') and r.target_close_date <= current_date + 91
       and coalesce((organization.settings->'features'->>'advancedClose')::boolean, false)
       and coalesce((organization.settings->'features'->>'flows')::boolean, true)
  `));
  for (const run of due.rows) {
    await withOrgContext(run.org_id, async () => {
      const today = await businessToday(run.org_id);
      // Discovery is one UTC day wide so a west-coast org is not missed; the
      // 90-day window is then applied on that org's own business day.
      if (run.target_close_date > addCalendarDays(today, 90)) return;
      await runCloseAutomations({
        orgId: run.org_id,
        runId: run.id,
        trigger: "deadline_approaching",
        eventKey: `deadline:${run.id}:${today}`,
      });
    });
  }
  return due.rows.length;
}
