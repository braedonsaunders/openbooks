import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { cmp } from "@openbooks/engine/src/money.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isUuid } from "../../../../../lib/list-params";

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

interface AdjustmentInput {
  itemId?: string | null;
  code?: string;
  name?: string;
  category?: string;
  calculation?: string;
  value?: string | null;
  unit?: string | null;
  presentation?: string;
  referenceText?: string | null;
}

function error(code: string, status = 422) {
  return NextResponse.json({ errorCode: code }, { status });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await guardPermission("admin.setup.manage");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  if (!isUuid(id)) return error("notFound", 404);

  const body = (await req.json()) as {
    effectiveFrom?: string;
    adjustments?: AdjustmentInput[];
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.effectiveFrom ?? ""))
    return error("effectiveDate");
  if (!Array.isArray(body.adjustments)) return error("adjustments");
  const adjustments = body.adjustments;

  const seen = new Set<string>();
  for (const adjustment of adjustments) {
    const itemId = adjustment.itemId || null;
    const code = adjustment.code?.trim().toLowerCase();
    if (itemId && !isUuid(itemId)) return error("item");
    if (!code || !adjustment.name?.trim()) return error("name");
    const uniqueKey = `${itemId ?? "*"}:${code}`;
    if (seen.has(uniqueKey)) return error("duplicateCode");
    seen.add(uniqueKey);
    if (
      !CATEGORIES.includes(adjustment.category as (typeof CATEGORIES)[number])
    )
      return error("category");
    if (
      !CALCULATIONS.includes(
        adjustment.calculation as (typeof CALCULATIONS)[number],
      )
    )
      return error("calculation");
    if (
      !PRESENTATIONS.includes(
        adjustment.presentation as (typeof PRESENTATIONS)[number],
      )
    )
      return error("presentation");
    if (adjustment.calculation !== "text") {
      try {
        if (
          adjustment.value == null ||
          adjustment.value === "" ||
          cmp(adjustment.value, "0") < 0
        )
          throw new Error();
      } catch {
        return error("value");
      }
    }
  }

  try {
    const result = await db.transaction(async (tx) => {
      const source = (await tx.execute(sql`
        select v.id, v.rate_book_id, v.effective_from::text
          from item_rate_versions v
         where v.id = ${id} and v.org_id = ${gate.user.orgId}
         for update
      `)) as unknown as {
        rows: { id: string; rate_book_id: string; effective_from: string }[];
      };
      if (!source.rows[0]) throw new Error("notFound");

      const bookId = source.rows[0].rate_book_id;
      const latest = (await tx.execute(sql`
        select id, effective_from::text
          from item_rate_versions
         where org_id = ${gate.user.orgId} and rate_book_id = ${bookId}
         order by effective_from desc, created_at desc
         limit 1 for update
      `)) as unknown as { rows: { id: string; effective_from: string }[] };
      if (latest.rows[0]?.id !== id) throw new Error("latestOnly");
      if (body.effectiveFrom! <= latest.rows[0].effective_from)
        throw new Error("afterLatest");

      const itemIds = [
        ...new Set(
          adjustments
            .map((row) => row.itemId)
            .filter((value): value is string => Boolean(value)),
        ),
      ];
      if (itemIds.length) {
        const found = (await tx.execute(sql`
          select id from items
           where org_id = ${gate.user.orgId} and is_active and id = any(${itemIds}::uuid[])
        `)) as unknown as { rows: { id: string }[] };
        if (found.rows.length !== itemIds.length) throw new Error("item");
      }

      await tx.execute(sql`
        update item_rate_versions
           set effective_to = (${body.effectiveFrom}::date - interval '1 day')::date,
               updated_at = now(), updated_by = ${gate.user.id}
         where id = ${id}
      `);
      const revision = (await tx.execute(sql`
        insert into item_rate_versions
          (org_id, rate_book_id, effective_from, effective_to, status, created_by, updated_by)
        values
          (${gate.user.orgId}, ${bookId}, ${body.effectiveFrom}, null, 'active', ${gate.user.id}, ${gate.user.id})
        returning id
      `)) as unknown as { rows: { id: string }[] };
      const revisionId = revision.rows[0].id;

      await tx.execute(sql`
        insert into item_rate_lines
          (org_id, version_id, item_id, unit_code, unit_name, base_quantity, cost_rate, bill_rate,
           time_type_bill_rates, sort_order, created_by, updated_by)
        select org_id, ${revisionId}, item_id, unit_code, unit_name, base_quantity, cost_rate, bill_rate,
               time_type_bill_rates, sort_order, ${gate.user.id}, ${gate.user.id}
          from item_rate_lines where version_id = ${id}
      `);
      await tx.execute(sql`
        insert into labor_rate_version_policies
          (org_id, version_id, derivation_policy, created_by, updated_by)
        select org_id, ${revisionId}, derivation_policy, ${gate.user.id}, ${gate.user.id}
          from labor_rate_version_policies where version_id = ${id}
      `);
      await tx.execute(sql`
        insert into labor_rate_version_scopes
          (org_id, version_id, scope_type, scope_value_id, scope_value_text, include_children, created_by, updated_by)
        select org_id, ${revisionId}, scope_type, scope_value_id, scope_value_text, include_children, ${gate.user.id}, ${gate.user.id}
          from labor_rate_version_scopes where version_id = ${id}
      `);
      await tx.execute(sql`
        insert into labor_rate_terms
          (org_id, version_id, code, label, content, placement, sort_order, created_by, updated_by)
        select org_id, ${revisionId}, code, label, content, placement, sort_order, ${gate.user.id}, ${gate.user.id}
          from labor_rate_terms where version_id = ${id}
      `);

      for (const [sortOrder, adjustment] of adjustments.entries()) {
        await tx.execute(sql`
          insert into labor_rate_adjustments
            (org_id, version_id, item_id, code, name, category, calculation, value, unit,
             presentation, reference_text, sort_order, created_by, updated_by)
          values
            (${gate.user.orgId}, ${revisionId}, ${adjustment.itemId || null}, ${adjustment.code!.trim().toLowerCase()},
             ${adjustment.name!.trim()}, ${adjustment.category}, ${adjustment.calculation},
             ${adjustment.calculation === "text" || adjustment.value === "" ? null : (adjustment.value ?? null)},
             ${adjustment.unit?.trim() || null}, ${adjustment.presentation}, ${adjustment.referenceText?.trim() || null},
             ${sortOrder}, ${gate.user.id}, ${gate.user.id})
        `);
      }

      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${gate.user.orgId}, 'item_rate_versions', ${revisionId}, 'insert',
                ${JSON.stringify({ sourceVersionId: id, effectiveFrom: body.effectiveFrom, adjustments })}::jsonb,
                ${gate.user.id})
      `);
      return { id: revisionId };
    });
    return NextResponse.json(result);
  } catch (cause) {
    const code = cause instanceof Error ? cause.message : "save";
    return error(
      ["notFound", "latestOnly", "afterLatest", "item"].includes(code)
        ? code
        : "save",
      code === "notFound" ? 404 : 422,
    );
  }
}
