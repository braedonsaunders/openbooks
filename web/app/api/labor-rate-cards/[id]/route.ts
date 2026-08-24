import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { cmp, normalizeDecimal, normalizeMoney } from "@openbooks/engine/src/money.ts";
import { guardPermission } from "../../../../lib/authz";
import { guardProjectsFeature } from "../../../../lib/projects-gate";
import { isUuid } from "../../../../lib/list-params";
import {
  loadFieldDefs,
  validateCustomValues,
} from "../../../../lib/custom-fields";
import { canonicalDecimal, compareDecimal } from "../../../../lib/exact-decimal";
import { isFeatureEnabled } from "../../../../lib/features";

export const runtime = "nodejs";

const INVENTORY_ITEM_KINDS = new Set(["inventory", "assembly", "kit"]);

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
function nonnegativeMoney(value: unknown, nullable = false): string | null | false {
  if ((value == null || value === "") && nullable) return null;
  const exact = canonicalDecimal(value, 4);
  if (exact === null) return false;
  try {
    const money = normalizeMoney(exact);
    return cmp(money, "0") >= 0 ? money : false;
  } catch {
    return false;
  }
}

function nonnegativeDecimal(value: unknown, scale: number, nullable = false): string | null | false {
  if ((value == null || value === "") && nullable) return null;
  const exact = canonicalDecimal(value, scale);
  if (exact === null || compareDecimal(exact, "0") < 0) return false;
  try {
    return normalizeDecimal(exact, scale);
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
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as CardInput;
  if (!body.name?.trim() || !body.code?.trim()) return error("name");
  // Rate-book currency is Multi-currency configuration. Turning that
  // switch off must refuse a write; omitting currency keeps the
  // stored book.
  if (
    body.currency !== undefined &&
    !(await isFeatureEnabled(gate.user.orgId, "multiCurrency"))
  ) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (body.currency !== undefined && !/^[A-Z]{3}$/.test(body.currency))
    return error("currency");
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
    const regular = nonnegativeMoney(line.regular, true);
    if (regular === false) return error("item");
    if (line.itemId != null && line.itemId !== "") {
      if (!isUuid(line.itemId)) return error("item");
      itemIds.add(line.itemId);
    } else if (!line.id) {
      return error("item");
    }
    line.regular = regular;
    if (line.id) {
      if (!isUuid(line.id) || lineIds.has(line.id)) return error("item");
      lineIds.add(line.id);
    }
    const timeTypeRates: Record<string, string> = {};
    for (const [key, value] of Object.entries(line.timeTypeRates ?? {})) {
      const rate = nonnegativeMoney(value, true);
      if (rate === false) return error("value");
      if (rate != null) timeTypeRates[key] = rate;
    }
    line.timeTypeRates = timeTypeRates;
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
    if (adjustment.calculation !== "text") {
      const value = nonnegativeDecimal(adjustment.value, 10);
      if (value === false) return error("value");
      adjustment.value = value;
    }
    if (adjustment.threshold != null && adjustment.threshold !== "") {
      const threshold = nonnegativeMoney(adjustment.threshold, true);
      if (threshold === false) return error("value");
      adjustment.threshold = threshold;
    }
    if (!Array.isArray(adjustment.targets)) return error("target");
    const targetKeys = new Set<string>();
    for (const target of adjustment.targets) {
      if (!TARGET_TYPES.includes(target.targetType as never))
        return error("target");
      const isText = TEXT_TARGETS.has(target.targetType!);
      if (target.targetType === "item" && (target.targetValueId == null || target.targetValueId === "")) {
        continue;
      }
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

  const orgId = gate.user.orgId;
  const storedItemTargets = (await db.execute<{
    code: string;
    target_value_id: string;
    include_children: boolean;
  }>(sql`
    select a.code, at.target_value_id, at.include_children
      from labor_rate_adjustment_targets at
      join labor_rate_adjustments a on a.id = at.adjustment_id and a.org_id = at.org_id
     where a.version_id = ${id} and a.org_id = ${orgId}
       and at.target_type = 'item' and at.target_value_id is not null`));
  const storedTargetIds = new Set(storedItemTargets.rows.map((row) => row.target_value_id));
  // Stored rate-card lines stay when itemId is omitted. Re-sending the stored
  // item is allowed. A new inventory / assembly / kit item is Inventory configuration.
  if (!(await isFeatureEnabled(orgId, "inventory"))) {
    const stored = (await db.execute<{ item_id: string }>(sql`
      select item_id from item_rate_lines
       where version_id = ${id} and org_id = ${orgId} and item_id is not null`));
    const storedIds = new Set(stored.rows.map((row) => row.item_id));
    for (const line of lines) {
      if (!line.itemId || storedIds.has(line.itemId)) continue;
      const item = (await db.execute<{ kind: string }>(sql`
        select kind from items where id = ${line.itemId} and org_id = ${orgId}`));
      if (item.rows[0] && INVENTORY_ITEM_KINDS.has(item.rows[0].kind)) {
        return NextResponse.json({ error: "not found" }, { status: 404 });
      }
    }
    for (const adjustment of adjustments) {
      for (const target of adjustment.targets ?? []) {
        if (target.targetType !== "item" || !target.targetValueId || storedTargetIds.has(target.targetValueId)) continue;
        const item = (await db.execute<{ kind: string }>(sql`
          select kind from items where id = ${target.targetValueId} and org_id = ${orgId}`));
        if (item.rows[0] && INVENTORY_ITEM_KINDS.has(item.rows[0].kind)) {
          return NextResponse.json({ error: "not found" }, { status: 404 });
        }
      }
    }
  }
  try {
    await db.transaction(async (tx) => {
      const current = (await tx.execute<{ rate_book_id: string }>(
        sql`select v.rate_book_id from item_rate_versions v where v.id=${id} and v.org_id=${orgId} for update`,
      ));
      if (!current.rows[0]) throw new Error("notFound");
      const before = (await tx.execute<{ snapshot: unknown }>(sql`select jsonb_build_object(
        'version',(select to_jsonb(v) from item_rate_versions v where v.id=${id} and v.org_id=${orgId}),
        'book',(select to_jsonb(b) from item_rate_books b where b.id=${current.rows[0].rate_book_id} and b.org_id=${orgId}),
        'policy',(select to_jsonb(p) from labor_rate_version_policies p where p.version_id=${id} and p.org_id=${orgId}),
        'scopes',(select coalesce(jsonb_agg(to_jsonb(s)),'[]'::jsonb) from labor_rate_version_scopes s where s.version_id=${id} and s.org_id=${orgId}),
        'lines',(select coalesce(jsonb_agg(to_jsonb(l)),'[]'::jsonb) from item_rate_lines l where l.version_id=${id} and l.org_id=${orgId}),
        'adjustments',(select coalesce(jsonb_agg(to_jsonb(a)),'[]'::jsonb) from labor_rate_adjustments a where a.version_id=${id} and a.org_id=${orgId}),
        'targets',(select coalesce(jsonb_agg(to_jsonb(at)),'[]'::jsonb) from labor_rate_adjustment_targets at join labor_rate_adjustments a on a.id=at.adjustment_id and a.org_id=at.org_id where a.version_id=${id} and a.org_id=${orgId}),
        'terms',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from labor_rate_terms t where t.version_id=${id} and t.org_id=${orgId})
      ) snapshot`));

      if (itemIds.size) {
        const found = (await tx.execute<{ id: string }>(
          sql`select id from items where org_id=${orgId} and is_active and id=any(${[...itemIds]}::uuid[])`,
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
          sql`select id from ${sql.raw(table)} where org_id=${orgId} and id=any(${ids}::uuid[])`,
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
          sql`select p.id from parties p join customer_roles c on c.party_id=p.id and c.org_id=${orgId} and c.is_active where p.org_id=${orgId} and p.is_active and p.id=any(${customerIds}::uuid[])`,
        ));
        if (found.rows.length !== customerIds.length) throw new Error("target");
      }

      await tx.execute(
        sql`update item_rate_books set name=${cardName},code=${cardCode},currency = case when ${body.currency === undefined} then currency else ${body.currency} end,updated_at=now(),updated_by=${gate.user.id} where id=${current.rows[0].rate_book_id} and org_id=${orgId}`,
      );
      await tx.execute(
        sql`update item_rate_versions set effective_from=${body.effective_from},effective_to=${body.effective_to || null},status=${body.status},custom=${JSON.stringify(customValidation.cleaned)}::jsonb,updated_at=now(),updated_by=${gate.user.id} where id=${id} and org_id=${orgId}`,
      );
      await tx.execute(
        sql`update labor_rate_version_policies set derivation_policy=${body.derivation_policy},updated_at=now(),updated_by=${gate.user.id} where version_id=${id} and org_id=${orgId}`,
      );

      await tx.execute(
        sql`delete from labor_rate_version_scopes where version_id=${id} and org_id=${orgId}`,
      );
      for (const scope of scopes)
        await tx.execute(
          sql`insert into labor_rate_version_scopes(org_id,version_id,scope_type,scope_value_id,scope_value_text,include_children,created_by,updated_by) values(${orgId},${id},${scope.scopeType},${scope.scopeValueId || null},${scope.scopeValueText?.trim() || null},${scope.includeChildren === true},${gate.user.id},${gate.user.id})`,
        );

      if (lineIds.size)
        await tx.execute(
          sql`delete from item_rate_lines where version_id=${id} and org_id=${orgId} and not(id=any(${[...lineIds]}::uuid[]))`,
        );
      else
        await tx.execute(
          sql`delete from item_rate_lines where version_id=${id} and org_id=${orgId}`,
        );
      for (const [sortOrder, line] of lines.entries()) {
        if (line.id)
          await tx.execute(
            sql`update item_rate_lines set item_id=${line.itemId ? line.itemId : sql`item_id`},bill_rate=${line.regular || null},time_type_bill_rates=${JSON.stringify(line.timeTypeRates ?? {})}::jsonb,sort_order=${sortOrder},updated_at=now(),updated_by=${gate.user.id} where id=${line.id} and version_id=${id} and org_id=${orgId}`,
          );
        else
          await tx.execute(
            sql`insert into item_rate_lines(org_id,version_id,item_id,unit_code,unit_name,base_quantity,bill_rate,time_type_bill_rates,sort_order,created_by,updated_by) values(${orgId},${id},${line.itemId},'hour','Hour',1,${line.regular || null},${JSON.stringify(line.timeTypeRates ?? {})}::jsonb,${sortOrder},${gate.user.id},${gate.user.id})`,
          );
      }

      await tx.execute(
        sql`delete from labor_rate_adjustment_targets where org_id=${orgId} and adjustment_id in(select id from labor_rate_adjustments where version_id=${id} and org_id=${orgId})`,
      );
      await tx.execute(
        sql`delete from labor_rate_adjustments where version_id=${id} and org_id=${orgId}`,
      );
      for (const [sortOrder, adjustment] of adjustments.entries()) {
        const inserted = (await tx.execute<{ id: string }>(
          sql`insert into labor_rate_adjustments(org_id,version_id,code,name,category,calculation,value,unit,presentation,threshold,threshold_unit,reference_text,sort_order,created_by,updated_by) values(${orgId},${id},${adjustment.code!.trim().toLowerCase()},${adjustment.name!.trim()},${adjustment.category},${adjustment.calculation},${adjustment.calculation === "text" ? null : adjustment.value || null},${adjustment.unit?.trim() || null},${adjustment.presentation},${adjustment.threshold || null},${adjustment.thresholdUnit?.trim() || null},${adjustment.referenceText?.trim() || null},${sortOrder},${gate.user.id},${gate.user.id}) returning id`,
        ));
        let wroteItemTarget = false;
        for (const target of adjustment.targets ?? []) {
          if (target.targetType === "item" && !target.targetValueId) continue;
          if (target.targetType === "item" && target.targetValueId) wroteItemTarget = true;
          await tx.execute(
            sql`insert into labor_rate_adjustment_targets(org_id,adjustment_id,target_type,target_value_id,target_value_text,include_children,created_by,updated_by) values(${orgId},${inserted.rows[0]!.id},${target.targetType},${target.targetValueId || null},${target.targetValueText?.trim() || null},${target.includeChildren === true},${gate.user.id},${gate.user.id})`,
          );
        }
        if (!wroteItemTarget) {
          const code = adjustment.code!.trim().toLowerCase();
          for (const stored of storedItemTargets.rows.filter((row) => row.code === code)) {
            await tx.execute(
              sql`insert into labor_rate_adjustment_targets(org_id,adjustment_id,target_type,target_value_id,target_value_text,include_children,created_by,updated_by) values(${orgId},${inserted.rows[0]!.id},'item',${stored.target_value_id},null,${stored.include_children},${gate.user.id},${gate.user.id})`,
            );
          }
        }
      }

      await tx.execute(
        sql`delete from labor_rate_terms where version_id=${id} and org_id=${orgId}`,
      );
      for (const [sortOrder, term] of terms.entries())
        await tx.execute(
          sql`insert into labor_rate_terms(org_id,version_id,code,label,content,placement,sort_order,created_by,updated_by) values(${orgId},${id},${term.code!.trim().toLowerCase()},${term.label!.trim()},${term.content!.trim()},${term.placement},${sortOrder},${gate.user.id},${gate.user.id})`,
        );

      await tx.execute(
        sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id) values(${orgId},'item_rate_versions',${id},'update',${JSON.stringify({ before: before.rows[0]?.snapshot, after: body })}::jsonb,${gate.user.id})`,
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
