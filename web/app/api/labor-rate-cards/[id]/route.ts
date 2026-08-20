import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { cmp } from "@openbooks/engine/src/money.ts";
import { guardPermission } from "../../../../lib/authz";
import { guardProjectsFeature } from "../../../../lib/projects-gate";
import { isUuid } from "../../../../lib/list-params";
import {
  loadFieldDefs,
  validateCustomValues,
} from "../../../../lib/custom-fields";

export const runtime = "nodejs";

const CATEGORIES = [
  "markup",
  "travel",
  "allowance",
  "minimum",
  "surcharge",
  "other",
] as const;
const CALCULATIONS = [
  "percent",
  "fixed",
  "per_hour",
  "per_day",
  "distance",
  "time",
  "text",
] as const;
const PRESENTATIONS = ["included", "separate", "informational"] as const;
const SCOPE_TYPES = [
  "department",
  "subsidiary",
  "location",
  "class",
  "trade",
  "job_title",
  "other",
] as const;
const TARGET_TYPES = [
  "item",
  "item_kind",
  "item_category",
  "transaction_type",
  "department",
  "subsidiary",
  "location",
  "class",
  "trade",
  "job_title",
  "project",
  "customer",
  "other",
] as const;
const TEXT_TARGETS = new Set([
  "item_kind",
  "item_category",
  "transaction_type",
  "job_title",
  "other",
]);
const UUID_TARGET_TABLES: Record<string, string> = {
  item: "items",
  department: "departments",
  subsidiary: "subsidiaries",
  location: "locations",
  class: "classes",
  trade: "trades",
  project: "projects",
};

type TargetInput = {
  targetType?: string;
  targetValueId?: string | null;
  targetValueText?: string | null;
  includeChildren?: boolean;
};
type ScopeInput = {
  scopeType?: string;
  scopeValueId?: string | null;
  scopeValueText?: string | null;
  includeChildren?: boolean;
};
type LineInput = {
  id?: string;
  itemId?: string;
  regular?: string | null;
  timeTypeRates?: Record<string, string>;
};
type AdjustmentInput = {
  code?: string;
  name?: string;
  category?: string;
  calculation?: string;
  value?: string | null;
  unit?: string | null;
  presentation?: string;
  threshold?: string | null;
  thresholdUnit?: string | null;
  referenceText?: string | null;
  targets?: TargetInput[];
};
type TermInput = {
  code?: string;
  label?: string;
  content?: string;
  placement?: string;
};
type CardInput = {
  name?: string;
  code?: string;
  currency?: string;
  effective_from?: string;
  effective_to?: string | null;
  status?: string;
  derivation_policy?: string;
  custom?: Record<string, unknown>;
  scopes?: ScopeInput[];
  lines?: LineInput[];
  adjustments?: AdjustmentInput[];
  terms?: TermInput[];
};

function error(errorCode: string, status = 422) {
  return NextResponse.json({ errorCode }, { status });
}
function date(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}
function nonnegative(value: unknown, nullable = false) {
  if ((value == null || value === "") && nullable) return true;
  try {
    return typeof value === "string" && value !== "" && cmp(value, "0") >= 0;
  } catch {
    return false;
  }
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await guardPermission("admin.setup.manage");
  if (gate instanceof NextResponse) return gate;
  const projectsGate = await guardProjectsFeature(gate.user.orgId);
  if (projectsGate) return projectsGate;
  const { id } = await params;
  if (!isUuid(id)) return error("notFound", 404);
  const body = (await req.json()) as CardInput;
  if (!body.name?.trim() || !body.code?.trim()) return error("name");
  if (!/^[A-Z]{3}$/.test(body.currency ?? "")) return error("currency");
  if (
    !date(body.effective_from) ||
    (body.effective_to &&
      (!date(body.effective_to) || body.effective_to < body.effective_from!))
  )
    return error("effectiveDate");
  if (!["draft", "active", "retired"].includes(body.status ?? ""))
    return error("status");
  if (
    !["explicit", "time_type_multipliers"].includes(
      body.derivation_policy ?? "",
    )
  )
    return error("derivation");
  if (
    !Array.isArray(body.scopes) ||
    !Array.isArray(body.lines) ||
    !Array.isArray(body.adjustments) ||
    !Array.isArray(body.terms)
  )
    return error("save");
  const scopes = body.scopes,
    lines = body.lines,
    adjustments = body.adjustments,
    terms = body.terms;
  const cardName = body.name.trim(),
    cardCode = body.code.trim();

  for (const scope of scopes) {
    if (!SCOPE_TYPES.includes(scope.scopeType as never)) return error("scope");
    const text = scope.scopeType === "job_title" || scope.scopeType === "other";
    if (
      text
        ? !scope.scopeValueText?.trim()
        : !scope.scopeValueId || !isUuid(scope.scopeValueId)
    )
      return error("scope");
  }
  const lineIds = new Set<string>(),
    itemIds = new Set<string>();
  for (const line of lines) {
    if (
      !line.itemId ||
      !isUuid(line.itemId) ||
      !nonnegative(line.regular, true)
    )
      return error("item");
    itemIds.add(line.itemId);
    if (line.id) {
      if (!isUuid(line.id) || lineIds.has(line.id)) return error("item");
      lineIds.add(line.id);
    }
    for (const value of Object.values(line.timeTypeRates ?? {}))
      if (!nonnegative(value, true)) return error("value");
  }
  const adjustmentCodes = new Set<string>();
  for (const adjustment of adjustments) {
    const code = adjustment.code?.trim().toLowerCase();
    if (!code || !adjustment.name?.trim()) return error("name");
    if (adjustmentCodes.has(code)) return error("duplicateCode");
    adjustmentCodes.add(code);
    if (!CATEGORIES.includes(adjustment.category as never))
      return error("category");
    if (!CALCULATIONS.includes(adjustment.calculation as never))
      return error("calculation");
    if (!PRESENTATIONS.includes(adjustment.presentation as never))
      return error("presentation");
    if (adjustment.calculation !== "text" && !nonnegative(adjustment.value))
      return error("value");
    if (!Array.isArray(adjustment.targets)) return error("target");
    const targetKeys = new Set<string>();
    for (const target of adjustment.targets) {
      if (!TARGET_TYPES.includes(target.targetType as never))
        return error("target");
      const isText = TEXT_TARGETS.has(target.targetType!);
      const value = isText
        ? target.targetValueText?.trim()
        : target.targetValueId;
      if (typeof value !== "string" || !value || (!isText && !isUuid(value)))
        return error("target");
      const key = `${target.targetType}:${value}`;
      if (targetKeys.has(key)) return error("duplicateTarget");
      targetKeys.add(key);
    }
  }
  const termCodes = new Set<string>();
  for (const term of terms) {
    const code = term.code?.trim().toLowerCase();
    if (
      !code ||
      !term.label?.trim() ||
      !term.content?.trim() ||
      termCodes.has(code) ||
      !["header", "conditions", "footer"].includes(term.placement ?? "")
    )
      return error("term");
    termCodes.add(code);
  }

  const customValidation = validateCustomValues(
    await loadFieldDefs("item_rate_versions"),
    body.custom,
  );
  if (!customValidation.ok) return error("custom");

  try {
    await db.transaction(async (tx) => {
      const current = (await tx.execute<{ rate_book_id: string }>(
        sql`select v.rate_book_id from item_rate_versions v where v.id=${id} and v.org_id=${gate.user.orgId} for update`,
      ));
      if (!current.rows[0]) throw new Error("notFound");
      const before = (await tx.execute<{ snapshot: unknown }>(sql`select jsonb_build_object(
        'version',(select to_jsonb(v) from item_rate_versions v where v.id=${id}),
        'book',(select to_jsonb(b) from item_rate_books b where b.id=${current.rows[0].rate_book_id}),
        'policy',(select to_jsonb(p) from labor_rate_version_policies p where p.version_id=${id}),
        'scopes',(select coalesce(jsonb_agg(to_jsonb(s)),'[]'::jsonb) from labor_rate_version_scopes s where s.version_id=${id}),
        'lines',(select coalesce(jsonb_agg(to_jsonb(l)),'[]'::jsonb) from item_rate_lines l where l.version_id=${id}),
        'adjustments',(select coalesce(jsonb_agg(to_jsonb(a)),'[]'::jsonb) from labor_rate_adjustments a where a.version_id=${id}),
        'targets',(select coalesce(jsonb_agg(to_jsonb(at)),'[]'::jsonb) from labor_rate_adjustment_targets at join labor_rate_adjustments a on a.id=at.adjustment_id where a.version_id=${id}),
        'terms',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from labor_rate_terms t where t.version_id=${id})
      ) snapshot`));

      if (itemIds.size) {
        const found = (await tx.execute<{ id: string }>(
          sql`select id from items where org_id=${gate.user.orgId} and is_active and id=any(${[...itemIds]}::uuid[])`,
        ));
        if (found.rows.length !== itemIds.size) throw new Error("item");
      }
      for (const [type, table] of Object.entries(UUID_TARGET_TABLES)) {
        const ids = [
          ...new Set(
            adjustments.flatMap((a) =>
              (a.targets ?? [])
                .filter((x) => x.targetType === type)
                .map((x) => x.targetValueId!)
                .concat(
                  scopes
                    .filter((x) => x.scopeType === type)
                    .map((x) => x.scopeValueId!),
                ),
            ),
          ),
        ].filter(Boolean);
        if (!ids.length) continue;
        const found = (await tx.execute<{ id: string }>(
          sql.raw(
            `select id from ${table} where org_id = '${gate.user.orgId}' and id = any(array[${ids.map((x) => `'${x}'::uuid`).join(",")}])`,
          ),
        ));
        if (found.rows.length !== ids.length)
          throw new Error(type === "item" ? "item" : "target");
      }
      const customerIds = [
        ...new Set(
          adjustments.flatMap((a) =>
            (a.targets ?? [])
              .filter((x) => x.targetType === "customer")
              .map((x) => x.targetValueId!),
          ),
        ),
      ].filter(Boolean);
      if (customerIds.length) {
        const found = (await tx.execute<{ id: string }>(
          sql`select p.id from parties p join customer_roles c on c.party_id=p.id and c.org_id=${gate.user.orgId} and c.is_active where p.org_id=${gate.user.orgId} and p.is_active and p.id=any(${customerIds}::uuid[])`,
        ));
        if (found.rows.length !== customerIds.length) throw new Error("target");
      }

      await tx.execute(
        sql`update item_rate_books set name=${cardName},code=${cardCode},currency=${body.currency},updated_at=now(),updated_by=${gate.user.id} where id=${current.rows[0].rate_book_id} and org_id=${gate.user.orgId}`,
      );
      await tx.execute(
        sql`update item_rate_versions set effective_from=${body.effective_from},effective_to=${body.effective_to || null},status=${body.status},custom=${JSON.stringify(customValidation.cleaned)}::jsonb,updated_at=now(),updated_by=${gate.user.id} where id=${id}`,
      );
      await tx.execute(
        sql`update labor_rate_version_policies set derivation_policy=${body.derivation_policy},updated_at=now(),updated_by=${gate.user.id} where version_id=${id}`,
      );

      await tx.execute(
        sql`delete from labor_rate_version_scopes where version_id=${id}`,
      );
      for (const scope of scopes)
        await tx.execute(
          sql`insert into labor_rate_version_scopes(org_id,version_id,scope_type,scope_value_id,scope_value_text,include_children,created_by,updated_by) values(${gate.user.orgId},${id},${scope.scopeType},${scope.scopeValueId || null},${scope.scopeValueText?.trim() || null},${scope.includeChildren === true},${gate.user.id},${gate.user.id})`,
        );

      if (lineIds.size)
        await tx.execute(
          sql`delete from item_rate_lines where version_id=${id} and not(id=any(${[...lineIds]}::uuid[]))`,
        );
      else
        await tx.execute(
          sql`delete from item_rate_lines where version_id=${id}`,
        );
      for (const [sortOrder, line] of lines.entries()) {
        if (line.id)
          await tx.execute(
            sql`update item_rate_lines set item_id=${line.itemId},bill_rate=${line.regular || null},time_type_bill_rates=${JSON.stringify(line.timeTypeRates ?? {})}::jsonb,sort_order=${sortOrder},updated_at=now(),updated_by=${gate.user.id} where id=${line.id} and version_id=${id} and org_id=${gate.user.orgId}`,
          );
        else
          await tx.execute(
            sql`insert into item_rate_lines(org_id,version_id,item_id,unit_code,unit_name,base_quantity,bill_rate,time_type_bill_rates,sort_order,created_by,updated_by) values(${gate.user.orgId},${id},${line.itemId},'hour','Hour',1,${line.regular || null},${JSON.stringify(line.timeTypeRates ?? {})}::jsonb,${sortOrder},${gate.user.id},${gate.user.id})`,
          );
      }

      await tx.execute(
        sql`delete from labor_rate_adjustment_targets where adjustment_id in(select id from labor_rate_adjustments where version_id=${id})`,
      );
      await tx.execute(
        sql`delete from labor_rate_adjustments where version_id=${id}`,
      );
      for (const [sortOrder, adjustment] of adjustments.entries()) {
        const inserted = (await tx.execute<{ id: string }>(
          sql`insert into labor_rate_adjustments(org_id,version_id,code,name,category,calculation,value,unit,presentation,threshold,threshold_unit,reference_text,sort_order,created_by,updated_by) values(${gate.user.orgId},${id},${adjustment.code!.trim().toLowerCase()},${adjustment.name!.trim()},${adjustment.category},${adjustment.calculation},${adjustment.calculation === "text" ? null : adjustment.value || null},${adjustment.unit?.trim() || null},${adjustment.presentation},${adjustment.threshold || null},${adjustment.thresholdUnit?.trim() || null},${adjustment.referenceText?.trim() || null},${sortOrder},${gate.user.id},${gate.user.id}) returning id`,
        ));
        for (const target of adjustment.targets ?? [])
          await tx.execute(
            sql`insert into labor_rate_adjustment_targets(org_id,adjustment_id,target_type,target_value_id,target_value_text,include_children,created_by,updated_by) values(${gate.user.orgId},${inserted.rows[0].id},${target.targetType},${target.targetValueId || null},${target.targetValueText?.trim() || null},${target.includeChildren === true},${gate.user.id},${gate.user.id})`,
          );
      }

      await tx.execute(
        sql`delete from labor_rate_terms where version_id=${id}`,
      );
      for (const [sortOrder, term] of terms.entries())
        await tx.execute(
          sql`insert into labor_rate_terms(org_id,version_id,code,label,content,placement,sort_order,created_by,updated_by) values(${gate.user.orgId},${id},${term.code!.trim().toLowerCase()},${term.label!.trim()},${term.content!.trim()},${term.placement},${sortOrder},${gate.user.id},${gate.user.id})`,
        );

      await tx.execute(
        sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id) values(${gate.user.orgId},'item_rate_versions',${id},'update',${JSON.stringify({ before: before.rows[0]?.snapshot, after: body })}::jsonb,${gate.user.id})`,
      );
    });
    return NextResponse.json({ ok: true, id });
  } catch (cause) {
    const code = cause instanceof Error ? cause.message : "save";
    return error(
      ["notFound", "item", "target"].includes(code) ? code : "save",
      code === "notFound" ? 404 : 422,
    );
  }
}
