import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { businessTodayInTx, isIsoCalendarDate } from "../platform/business-date.ts";
import { isUuid } from "../platform/uuid.ts";
import {
  acquireOrgFeatureGateLock,
  lockAndCheckOrgFeature,
  orgFeatureEnabled,
} from "../organization/org-feature-lock.ts";
import { subsidiaryScopeAllows, subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import { createProjectInTransaction } from "../projects/project-create.ts";
import {
  captureBudgetBaselineInTransaction,
  type BaselineLineInput,
} from "../projects/budget-baselines.ts";
import {
  planQuoteAward,
  type AwardLineMapping,
  type AwardPlan,
  type AwardSourceLine,
  type AwardTaskSpec,
} from "../projects/award-plan.ts";
import { decimal8Units, fromDecimal8Units } from "../projects/budget-decimal.ts";
import { latestSignatureRequest, quotePresentationHash, QUOTE_SUBJECT_TABLE } from "./quote-to-cash.ts";

/**
 * Awarding a quote: the issued quote becomes a project whose work breakdown
 * carries the quoted hours, cost and price, and whose original budget
 * baseline records exactly what was sold — line by line, with each quote
 * line's provenance. Quote-versus-actual, progress and profit measures then
 * have a sold budget to compare against.
 *
 * One tenant transaction: the feature-gate fence, a row lock on the quote,
 * the project (through the native project create command), its tasks, the
 * quote's project tag, the baseline and the audit trail. A quote is awarded
 * at most once — a repeat returns the project it was awarded into.
 */

export class QuoteAwardError extends Error {
  readonly name = "QuoteAwardError";
  constructor(
    message: string,
    readonly status: 404 | 409 | 422 = 422,
    readonly field?: string,
  ) {
    super(message);
  }
}

export type AwardTarget =
  | {
      mode: "new";
      name?: string | null;
      projectTypeId?: string | null;
      startsOn?: string | null;
      /** Overrides the default contract value (the quoted net price). */
      contractValue?: string | null;
    }
  | { mode: "existing"; projectId: string };

export interface AwardQuoteInput {
  /** Defaults to the quote's own project when it names one, else a new project. */
  target?: AwardTarget;
  /** Task groups and the line mapping; omitted means one task per priced line. */
  tasks?: AwardTaskSpec[];
  mapping?: AwardLineMapping[];
  /** Total cost (functional) for lines the quote does not cost. */
  lineCosts?: { lineId: string; cost: string }[];
  /** Budget production quantities (requires Progress tracking). */
  productionQuantities?: boolean;
}

export interface AwardContext {
  orgId: string;
  actorId: string;
  /** Subsidiary scope the caller was granted; null is unrestricted. */
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}

export interface QuoteAwardResult {
  projectId: string;
  projectName: string;
  /** False when the quote had already been awarded. */
  created: boolean;
  baselineId: string | null;
  taskCount: number;
}

export interface AwardProjectTypeOption {
  id: string;
  key: string;
  name: string;
  /** The type prices the job at its contract value (fixed price, not-to-exceed). */
  pricesFromContract: boolean;
}

export interface QuoteAwardPreview {
  quote: {
    id: string;
    documentNumber: string;
    status: string;
    customerId: string | null;
    customerName: string | null;
    currency: string;
    documentDate: string;
    projectId: string | null;
    projectName: string | null;
  };
  /** Set once the quote has been awarded. */
  awarded: { projectId: string; projectName: string } | null;
  /** Why the quote cannot be awarded right now, with the remedy; null when it can. */
  blocked: string | null;
  defaults: {
    mode: "new" | "existing";
    projectId: string | null;
    name: string;
    projectTypeId: string | null;
    contractValue: string | null;
  };
  projectTypes: AwardProjectTypeOption[];
  /** Open projects of the quote's customer the caller can see. */
  projects: { id: string; name: string; code: string | null }[];
  /** Tasks of the target project (the quote's project, or `projectId`). */
  existingTasks: { id: string; code: string | null; name: string }[];
  productionQuantitiesAvailable: boolean;
  /** The quote's lines with the catalog facts the plan reads. */
  lines: AwardSourceLine[];
  /** The default plan, computed exactly as the award will compute it. */
  plan: AwardPlan | null;
  /** Why the default plan cannot be built, when it cannot. */
  planError: string | null;
}

type QuoteRow = {
  id: string;
  kind: string;
  document_number: string;
  status: string;
  party_id: string | null;
  party_name: string | null;
  subsidiary_id: string | null;
  currency: string;
  fx_rate: string;
  document_date: string;
  project_id: string | null;
  project_name: string | null;
  billing_method: string | null;
  reference_number: string | null;
  memo: string | null;
};

async function loadQuoteForAward(
  runner: SqlExecutor,
  ctx: AwardContext,
  quoteId: string,
  lock: boolean,
): Promise<QuoteRow> {
  if (!isUuid(quoteId)) throw new QuoteAwardError("Quote not found", 404);
  const row = (
    await runner.execute<QuoteRow>(sql`
      select d.id, d.kind, d.document_number, d.status, d.party_id, pa.display_name as party_name,
             d.subsidiary_id, d.currency, d.fx_rate::text as fx_rate, d.document_date::text as document_date,
             d.project_id, pr.name as project_name, d.billing_method, d.reference_number, d.memo
        from documents d
        left join parties pa on pa.id = d.party_id and pa.org_id = d.org_id
        left join projects pr on pr.id = d.project_id and pr.org_id = d.org_id
       where d.id = ${quoteId} and d.org_id = ${ctx.orgId}
       ${lock ? sql`for update of d` : sql``}`)
  ).rows[0];
  // A missing row and an out-of-scope legal entity read the same.
  if (!row || !subsidiaryScopeAllows(ctx.allowedSubsidiaryIds, row.subsidiary_id)) {
    throw new QuoteAwardError("Quote not found", 404);
  }
  if (row.kind !== "quote") {
    throw new QuoteAwardError(`Document ${row.document_number} is not a quote — only quotes (Estimates) can be awarded`);
  }
  return row;
}

async function loadQuoteLines(runner: SqlExecutor, orgId: string, quote: QuoteRow): Promise<AwardSourceLine[]> {
  const rows = (
    await runner.execute<{
      id: string; line_number: number; description: string | null; item_id: string | null;
      item_name: string | null; item_kind: string | null; item_unit: string | null; unit: string | null;
      quantity: string; amount: string; cost_amount: string | null; item_default_cost: string | null;
    }>(sql`
      select dl.id, dl.line_number, dl.description, dl.item_id, i.name as item_name, i.kind as item_kind,
             i.unit as item_unit, dl.unit, dl.quantity::text as quantity, dl.amount::text as amount,
             dl.cost_amount::text as cost_amount, i.default_cost::text as item_default_cost
        from document_lines dl
        left join items i on i.id = dl.item_id and i.org_id = dl.org_id
       where dl.org_id = ${orgId} and dl.document_id = ${quote.id}
       order by dl.line_number, dl.id`)
  ).rows;
  return rows.map((row) => ({
    lineId: row.id,
    lineNumber: Number(row.line_number),
    description: row.description,
    itemId: row.item_id,
    itemName: row.item_name,
    itemKind: row.item_kind,
    itemUnit: row.item_unit,
    unit: row.unit,
    quantity: row.quantity,
    amount: row.amount,
    costAmount: row.cost_amount,
    itemDefaultCost: row.item_default_cost,
    fxRate: quote.fx_rate,
  }));
}

/** The project a quote was already awarded into, if any. */
async function priorAward(
  runner: SqlExecutor,
  orgId: string,
  quoteId: string,
): Promise<{ projectId: string; projectName: string; baselineId: string | null } | null> {
  const row = (
    await runner.execute<{ project_id: string; project_name: string; baseline_id: string | null }>(sql`
      select p.id as project_id, p.name as project_name,
             (select b.id from project_budget_baselines b
               where b.org_id = p.org_id and b.project_id = p.id and b.source_document_id = ${quoteId}
               order by b.sequence limit 1) as baseline_id
        from projects p
       where p.org_id = ${orgId}
         and (p.awarded_from_document_id = ${quoteId}
              or exists (select 1 from project_budget_baselines b
                          where b.org_id = p.org_id and b.project_id = p.id and b.source_document_id = ${quoteId}))
       order by (p.awarded_from_document_id = ${quoteId}) desc nulls last
       limit 1`)
  ).rows[0];
  return row ? { projectId: row.project_id, projectName: row.project_name, baselineId: row.baseline_id } : null;
}

/**
 * Why this quote cannot be awarded now, or null. A signed quote must still
 * match what the customer signed; a quote changed since refuses.
 */
async function awardBlock(runner: SqlExecutor, orgId: string, quote: QuoteRow): Promise<string | null> {
  if (quote.status === "draft") return `Quote ${quote.document_number} is a draft — issue it before awarding it`;
  if (quote.status === "pending_approval") return `Quote ${quote.document_number} is awaiting approval — approve it in Flows before awarding it`;
  if (quote.status === "voided") return `Quote ${quote.document_number} is voided and cannot be awarded — issue a new quote for the work`;
  if (quote.status !== "approved") return `Quote ${quote.document_number} is ${quote.status} and can no longer be awarded`;
  if (!quote.party_id) return `Quote ${quote.document_number} names no customer — a project is awarded to the quote's customer`;
  const signature = await latestSignatureRequest(runner, orgId, QUOTE_SUBJECT_TABLE, quote.id);
  if (signature && signature.status === "signed") {
    const current = await quotePresentationHash(runner, orgId, quote.id);
    if (current !== signature.documentHash) {
      return "The quote changed after the customer signed it — void the signature request, re-send it, and award the quote once it is signed again";
    }
  }
  return null;
}

async function projectTypeOptions(runner: SqlExecutor, orgId: string): Promise<AwardProjectTypeOption[]> {
  const today = await businessTodayInTx(runner, orgId);
  const rows = (
    await runner.execute<{ id: string; key: string; name: string; price_method: string | null }>(sql`
      select pt.id, pt.key, pt.name,
             (select v.financial_profile->'totalPrice'->>'method'
                from project_financial_profile_versions v
               where v.org_id = pt.org_id and v.project_type_id = pt.id
                 and v.effective_from <= ${today}::date
                 and (v.effective_to is null or v.effective_to >= ${today}::date)
               order by v.effective_from desc limit 1) as price_method
        from project_types pt
       where pt.org_id = ${orgId} and pt.is_active
       order by pt.sort_order, pt.name, pt.id`)
  ).rows;
  return rows.map((row) => ({
    id: row.id,
    key: row.key,
    name: row.name,
    pricesFromContract: row.price_method === "contract_field" || row.price_method === "not_to_exceed",
  }));
}

/** The type a quote's billing method maps to: the built-in key, else the first active type of that method. */
async function defaultProjectTypeId(
  runner: SqlExecutor,
  orgId: string,
  billingMethod: string | null,
): Promise<string | null> {
  const method = billingMethod === "fixed_price" ? "fixed_price" : "time_and_materials";
  const row = (
    await runner.execute<{ id: string }>(sql`
      select id from project_types
       where org_id = ${orgId} and is_active and (key = ${method} or billing_method = ${method})
       order by (key = ${method}) desc, sort_order, name, id
       limit 1`)
  ).rows[0];
  return row?.id ?? null;
}

function defaultProjectName(quote: QuoteRow): string {
  const memo = (quote.memo ?? "").split(/\r?\n/)[0]!.trim();
  if (memo) return memo.length > 200 ? memo.slice(0, 200) : memo;
  return quote.party_name ? `${quote.party_name} — ${quote.document_number}` : quote.document_number;
}

async function customerProjects(
  runner: SqlExecutor,
  ctx: AwardContext,
  customerId: string | null,
): Promise<{ id: string; name: string; code: string | null }[]> {
  if (!customerId) return [];
  return (
    await runner.execute<{ id: string; name: string; code: string | null }>(sql`
      select id, name, code from projects
       where org_id = ${ctx.orgId} and customer_id = ${customerId} and is_active
         and status not in ('closed', 'cancelled')
         ${subsidiaryVisibleFilter(sql`subsidiary_id`, ctx.allowedSubsidiaryIds)}
       order by name, id
       limit 500`)
  ).rows;
}

async function projectTasks(
  runner: SqlExecutor,
  orgId: string,
  projectId: string,
): Promise<{ id: string; code: string | null; name: string; status: string; estimated_hours: string | null; estimated_cost: string | null; estimated_price: string | null; budget_quantity: string | null; budget_unit: string | null }[]> {
  return (
    await runner.execute<{ id: string; code: string | null; name: string; status: string; estimated_hours: string | null; estimated_cost: string | null; estimated_price: string | null; budget_quantity: string | null; budget_unit: string | null }>(sql`
      select id, code, name, status, estimated_hours::text as estimated_hours, estimated_cost::text as estimated_cost,
             estimated_price::text as estimated_price, budget_quantity::text as budget_quantity, budget_unit
        from project_tasks
       where org_id = ${orgId} and project_id = ${projectId}
       order by code nulls last, name, id`)
  ).rows;
}

/**
 * Everything the award drawer renders: the quote, whether and why it can be
 * awarded, the default target and project type, the customer's projects,
 * and the default plan. Writes nothing; the signed-quote check reads the
 * quote under the same row lock the award takes.
 */
export async function previewQuoteAward(
  ctx: AwardContext,
  quoteId: string,
  options: { projectId?: string | null } = {},
): Promise<QuoteAwardPreview> {
  return withOrgTransaction(ctx.orgId, async () => {
    const runner = db;
    const quote = await loadQuoteForAward(runner, ctx, quoteId, false);
    const prior = await priorAward(runner, ctx.orgId, quote.id);
    const featuresOn =
      (await orgFeatureEnabled(ctx.orgId, "projects", runner)) && (await orgFeatureEnabled(ctx.orgId, "orders", runner));
    const blocked = !featuresOn
      ? "Projects and Orders must both be on — turn them on in Company Settings → Features"
      : prior
        ? null
        : await awardBlock(runner, ctx.orgId, quote);
    const lines = await loadQuoteLines(runner, ctx.orgId, quote);
    const types = await projectTypeOptions(runner, ctx.orgId);
    const typeId = await defaultProjectTypeId(runner, ctx.orgId, quote.billing_method);
    const projects = await customerProjects(runner, ctx, quote.party_id);
    const targetProjectId = options.projectId && isUuid(options.projectId)
      ? (projects.some((p) => p.id === options.projectId) ? options.projectId : null)
      : quote.project_id;
    const existing = targetProjectId ? await projectTasks(runner, ctx.orgId, targetProjectId) : [];
    let plan: AwardPlan | null = null;
    let planError: string | null = null;
    try {
      plan = planQuoteAward({ lines, usedCodes: new Set(existing.map((t) => t.code).filter((c): c is string => !!c)) });
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "AwardPlanError") throw error;
      planError = error.message;
    }
    const pricesFromContract = types.find((t) => t.id === typeId)?.pricesFromContract === true;
    return {
      quote: {
        id: quote.id,
        documentNumber: quote.document_number,
        status: quote.status,
        customerId: quote.party_id,
        customerName: quote.party_name,
        currency: quote.currency,
        documentDate: quote.document_date,
        projectId: quote.project_id,
        projectName: quote.project_name,
      },
      awarded: prior ? { projectId: prior.projectId, projectName: prior.projectName } : null,
      blocked,
      defaults: {
        mode: quote.project_id ? "existing" : "new",
        projectId: quote.project_id,
        name: defaultProjectName(quote),
        projectTypeId: typeId,
        contractValue: pricesFromContract && plan ? plan.totals.price : null,
      },
      projectTypes: types,
      projects,
      existingTasks: existing.map((t) => ({ id: t.id, code: t.code, name: t.name })),
      productionQuantitiesAvailable: await orgFeatureEnabled(ctx.orgId, "projectProgress", runner),
      lines,
      plan,
      planError,
    };
  });
}

async function writeTaskAudit(
  runner: SqlExecutor,
  ctx: AwardContext,
  projectId: string,
  taskId: string,
  action: "insert" | "update",
  before: unknown,
  after: unknown,
  quoteNumber: string,
): Promise<void> {
  await runner.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${ctx.orgId}, 'project_tasks', ${taskId}, ${action},
            ${JSON.stringify({ projectId, source: "quote_award", quote: quoteNumber, before, after })}::jsonb,
            ${ctx.actorId})`);
}

function sameUnit(a: string | null, b: string | null): boolean {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}

/** Award inside the caller's open tenant transaction. */
export async function awardQuoteInTransaction(
  runner: SqlExecutor,
  ctx: AwardContext,
  quoteId: string,
  input: AwardQuoteInput = {},
): Promise<QuoteAwardResult> {
  // The feature-gate fence first (a new project blocks disabling Projects),
  // then both gates re-checked under it.
  await acquireOrgFeatureGateLock(runner, ctx.orgId);
  if (!(await lockAndCheckOrgFeature(runner, ctx.orgId, "projects")) || !(await lockAndCheckOrgFeature(runner, ctx.orgId, "orders"))) {
    throw new QuoteAwardError("Projects and Orders must both be on — turn them on in Company Settings → Features", 404);
  }
  const quote = await loadQuoteForAward(runner, ctx, quoteId, true);
  // The quote row lock serializes twin awards: the second observes the first.
  const prior = await priorAward(runner, ctx.orgId, quote.id);
  if (prior) {
    return { projectId: prior.projectId, projectName: prior.projectName, created: false, baselineId: prior.baselineId, taskCount: 0 };
  }
  const blocked = await awardBlock(runner, ctx.orgId, quote);
  if (blocked) throw new QuoteAwardError(blocked);
  if (input.productionQuantities && !(await lockAndCheckOrgFeature(runner, ctx.orgId, "projectProgress"))) {
    throw new QuoteAwardError(
      "Production quantities need Progress tracking — turn it on in Company Settings → Features, or award without them",
      422,
      "productionQuantities",
    );
  }

  const target: AwardTarget = input.target
    ?? (quote.project_id ? { mode: "existing", projectId: quote.project_id } : { mode: "new" });
  if (target.mode === "new" && quote.project_id) {
    throw new QuoteAwardError(
      `Quote ${quote.document_number} is already tagged to project ${quote.project_name ?? quote.project_id} — award it into that project`,
      422,
      "target",
    );
  }

  // Existing target: same customer, open, visible, and the quote's own project when it names one.
  let existingProject: { id: string; name: string } | null = null;
  let priorTasks: Awaited<ReturnType<typeof projectTasks>> = [];
  if (target.mode === "existing") {
    if (!isUuid(target.projectId)) throw new QuoteAwardError("Project not found", 404, "target");
    if (quote.project_id && quote.project_id !== target.projectId) {
      throw new QuoteAwardError(
        `Quote ${quote.document_number} is tagged to project ${quote.project_name ?? quote.project_id} — award it into that project`,
        422,
        "target",
      );
    }
    const row = (
      await runner.execute<{ id: string; name: string; customer_id: string | null; status: string; is_active: boolean }>(sql`
        select id, name, customer_id, status, is_active from projects
         where id = ${target.projectId} and org_id = ${ctx.orgId}
           ${subsidiaryVisibleFilter(sql`subsidiary_id`, ctx.allowedSubsidiaryIds)}
         for update`)
    ).rows[0];
    if (!row) throw new QuoteAwardError("Project not found", 404, "target");
    if (row.customer_id !== quote.party_id) {
      throw new QuoteAwardError(
        `Project ${row.name} belongs to a different customer than quote ${quote.document_number} — award it into one of ${quote.party_name ?? "the customer"}'s projects or a new project`,
        422,
        "target",
      );
    }
    if (!row.is_active || row.status === "closed" || row.status === "cancelled") {
      throw new QuoteAwardError(`Project ${row.name} is closed — reopen it before awarding work into it`, 422, "target");
    }
    existingProject = { id: row.id, name: row.name };
    priorTasks = await projectTasks(runner, ctx.orgId, row.id);
  }

  const lines = await loadQuoteLines(runner, ctx.orgId, quote);
  const plan = planQuoteAward({
    lines,
    tasks: input.tasks,
    mapping: input.mapping,
    lineCosts: input.lineCosts,
    productionQuantities: input.productionQuantities === true,
    usedCodes: new Set(priorTasks.map((t) => t.code).filter((c): c is string => !!c)),
  });
  if (plan.missingCost.length > 0) {
    const numbers = plan.missingCost.map((line) => line.lineNumber).join(", ");
    throw new QuoteAwardError(
      `Quote line${plan.missingCost.length === 1 ? "" : "s"} ${numbers} ${plan.missingCost.length === 1 ? "has" : "have"} a price but no cost — enter the expected cost for ${plan.missingCost.length === 1 ? "it" : "each"} in the award, or set a standard cost on the item`,
      422,
      "lineCosts",
    );
  }
  const priorById = new Map(priorTasks.map((t) => [t.id, t]));
  for (const task of plan.tasks) {
    if (!task.existingTaskId) continue;
    const existing = priorById.get(task.existingTaskId);
    if (!existing) throw new QuoteAwardError(`Task ${task.code ?? task.name} is not a task of the chosen project`, 422, "tasks");
    if (existing.status !== "open") {
      throw new QuoteAwardError(`Task ${existing.code ?? existing.name} is ${existing.status} — reopen it or map the lines to another task`, 422, "tasks");
    }
    if (task.budgetUnit && existing.budget_unit && !sameUnit(task.budgetUnit, existing.budget_unit)) {
      throw new QuoteAwardError(
        `Task ${existing.code ?? existing.name} budgets production in ${existing.budget_unit}, not ${task.budgetUnit} — map those lines to another task`,
        422,
        "tasks",
      );
    }
  }

  // The project: created through the native command, or the chosen one.
  let projectId: string;
  let projectName: string;
  let created = false;
  if (target.mode === "new") {
    const typeId = target.projectTypeId !== undefined
      ? target.projectTypeId
      : await defaultProjectTypeId(runner, ctx.orgId, quote.billing_method);
    if (target.startsOn != null && target.startsOn !== "" && !isIsoCalendarDate(target.startsOn)) {
      throw new QuoteAwardError("Invalid start date", 422, "startsOn");
    }
    let contractValue: string | null;
    if (target.contractValue !== undefined) {
      contractValue = target.contractValue;
    } else {
      const types = await projectTypeOptions(runner, ctx.orgId);
      contractValue = types.find((t) => t.id === typeId)?.pricesFromContract === true ? plan.totals.price : null;
    }
    projectName = (target.name ?? "").trim() || defaultProjectName(quote);
    projectId = randomUUID();
    await createProjectInTransaction(
      runner,
      ctx,
      projectId,
      {
        name: projectName,
        status: "awarded",
        customerId: quote.party_id,
        subsidiaryId: quote.subsidiary_id,
        projectTypeId: typeId,
        contractValue,
        customerPoNumber: quote.reference_number,
        startsOn: target.startsOn ?? null,
      },
      { awardedFromDocumentId: quote.id },
    );
    created = true;
  } else {
    projectId = existingProject!.id;
    projectName = existingProject!.name;
    // Record the award on a project that has none yet; a project already
    // awarded from another quote keeps that provenance, and this award is
    // evidenced by its baseline's source quote.
    const updated = (
      await runner.execute<{ status: string }>(sql`
        update projects
           set awarded_from_document_id = ${quote.id}, awarded_at = now(), awarded_by = ${ctx.actorId},
               status = case when status = 'quoted' then 'awarded' else status end,
               updated_at = now(), updated_by = ${ctx.actorId}
         where id = ${projectId} and org_id = ${ctx.orgId} and awarded_from_document_id is null
         returning status`)
    ).rows[0];
    if (updated) {
      await runner.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${ctx.orgId}, 'projects', ${projectId}, 'update',
                ${JSON.stringify({ before: { awarded_from_document_id: null }, after: { awarded_from_document_id: quote.id, status: updated.status }, reason: `Awarded quote ${quote.document_number}` })}::jsonb,
                ${ctx.actorId})`);
    }
  }

  // Tasks: new rows for new groups, budget added onto mapped existing tasks.
  const taskIdByKey = new Map<string, { id: string; code: string | null; name: string }>();
  let order = Number(
    (
      await runner.execute<{ next: number }>(sql`
        select coalesce(max(schedule_order), 0) + 1 as next from project_tasks
         where org_id = ${ctx.orgId} and project_id = ${projectId}`)
    ).rows[0]?.next ?? 1,
  );
  for (const task of plan.tasks) {
    if (task.existingTaskId) {
      const before = priorById.get(task.existingTaskId)!;
      const quantity = task.budgetQuantity === null
        ? before.budget_quantity
        : fromDecimal8Units(decimal8Units(before.budget_quantity ?? "0") + decimal8Units(task.budgetQuantity));
      const after = (
        await runner.execute<{ id: string }>(sql`
          update project_tasks
             set estimated_hours = coalesce(estimated_hours, 0) + ${task.hours}::numeric,
                 estimated_cost = coalesce(estimated_cost, 0) + ${task.cost}::numeric,
                 estimated_price = coalesce(estimated_price, 0) + ${task.price}::numeric,
                 budget_quantity = ${quantity},
                 budget_unit = ${task.budgetQuantity === null ? before.budget_unit : (before.budget_unit ?? task.budgetUnit)},
                 updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'),
                 updated_by = ${ctx.actorId}
           where id = ${before.id} and project_id = ${projectId} and org_id = ${ctx.orgId} and status = 'open'
           returning id`)
      ).rows[0];
      if (!after) throw new QuoteAwardError(`Task ${before.code ?? before.name} changed while awarding — reload and try again`, 409);
      await writeTaskAudit(runner, ctx, projectId, before.id, "update",
        { estimated_hours: before.estimated_hours, estimated_cost: before.estimated_cost, estimated_price: before.estimated_price, budget_quantity: before.budget_quantity, budget_unit: before.budget_unit },
        { added: { hours: task.hours, cost: task.cost, price: task.price, quantity: task.budgetQuantity, unit: task.budgetUnit } },
        quote.document_number);
      taskIdByKey.set(task.key, { id: before.id, code: before.code, name: before.name });
      continue;
    }
    const inserted = (
      await runner.execute<{ id: string }>(sql`
        insert into project_tasks
          (org_id, project_id, code, name, status, estimated_hours, estimated_cost, estimated_price,
           budget_quantity, budget_unit, schedule_order, created_by, updated_by)
        values (${ctx.orgId}, ${projectId}, ${task.code}, ${task.name}, 'open', ${task.hours}, ${task.cost}, ${task.price},
                ${task.budgetQuantity}, ${task.budgetUnit}, ${order}, ${ctx.actorId}, ${ctx.actorId})
        returning id`)
    ).rows[0];
    if (!inserted) throw new QuoteAwardError(`Task ${task.code ?? task.name} was not recorded`, 409);
    order += 1;
    await writeTaskAudit(runner, ctx, projectId, inserted.id, "insert", null,
      { code: task.code, name: task.name, estimated_hours: task.hours, estimated_cost: task.cost, estimated_price: task.price, budget_quantity: task.budgetQuantity, budget_unit: task.budgetUnit },
      quote.document_number);
    taskIdByKey.set(task.key, { id: inserted.id, code: task.code, name: task.name });
  }

  // The quote is tagged to its project. Its lines are fixed once issued, so
  // the line → task mapping lives on the baseline lines (source_line_id).
  if (!quote.project_id) {
    const tagged = await runner.execute(sql`
      update documents set project_id = ${projectId}, updated_at = now(), updated_by = ${ctx.actorId}
       where id = ${quote.id} and org_id = ${ctx.orgId} and project_id is null`);
    if ((tagged.rowCount ?? 0) !== 1) throw new QuoteAwardError("The quote changed while awarding — reload and try again", 409);
  }

  // The baseline: the project's budget before the award (one line per prior
  // task) plus each quote line, so it sums to the working budget it records.
  const baselineLines: BaselineLineInput[] = [
    ...priorTasks.map((t) => ({
      projectTaskId: t.id,
      taskCode: t.code,
      taskName: t.name,
      hours: t.estimated_hours ?? "0",
      quantity: t.budget_quantity,
      unit: t.budget_unit,
      cost: t.estimated_cost ?? "0",
      price: t.estimated_price ?? "0",
    })),
    ...plan.lines.map((line) => {
      const task = taskIdByKey.get(line.taskKey)!;
      return {
        projectTaskId: task.id,
        taskCode: task.code,
        taskName: task.name,
        sourceLineId: line.lineId,
        itemId: line.itemId,
        description: line.description,
        hours: line.hours,
        quantity: line.quantity,
        unit: line.unit,
        cost: line.cost,
        price: line.price,
      };
    }),
  ];
  const baseline = await captureBudgetBaselineInTransaction(runner, ctx, {
    projectId,
    label: `Awarded from ${quote.document_number}`.slice(0, 120),
    reason: `Awarded from quote ${quote.document_number}`,
    sourceDocumentId: quote.id,
    lines: baselineLines,
  });

  await runner.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${ctx.orgId}, 'documents', ${quote.id}, 'update',
            ${JSON.stringify({
              before: { project_id: quote.project_id },
              after: { project_id: projectId },
              award: {
                projectId,
                projectCreated: created,
                baselineId: baseline.id,
                baselineKind: baseline.kind,
                taskIds: [...new Set([...taskIdByKey.values()].map((t) => t.id))],
                totals: plan.totals,
              },
            })}::jsonb, ${ctx.actorId})`);

  return { projectId, projectName, created: true, baselineId: baseline.id, taskCount: taskIdByKey.size };
}

/** Award a quote in its own tenant transaction. */
export async function awardQuote(
  ctx: AwardContext,
  quoteId: string,
  input: AwardQuoteInput = {},
): Promise<QuoteAwardResult> {
  return withOrgTransaction(ctx.orgId, () => awardQuoteInTransaction(db, ctx, quoteId, input));
}
