import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { cmp as compareMoney, normalizeMoney } from "@openbooks/engine/src/money/money.ts";
import { guardPermission } from "../../../../../lib/authz";
import type { ForecastCategory } from "../../../../../lib/analytics/cashflow-data";
import {
  BANK_ACCOUNT_TYPE,
  CARD_ACCOUNT_TYPE,
  validateReferences,
} from "../../../../../lib/cash/category-references";

export const runtime = "nodejs";

/**
 * Cash Flow forecast-category configuration. Stored as an array at
 * orgs.settings.analytics.cashflowCategories.
 * PUT replaces the whole list (the editor sends the full state); each entry is
 * validated per method (all seven strategies) and unknown fields are
 * dropped.
 */
const METHODS = new Set([
  "gl_history_average",
  "vendor_payment_history",
  "credit_card_cycle",
  "manual_recurring",
  "formula_expression",
  "vendor_recurring_average",
  "bank_register_history",
]);
const FREQUENCIES = new Set(["weekly", "biweekly", "bi_weekly", "monthly"]);

const strList = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x).slice(0, max) : [];
const clampNum = (v: unknown, min: number, max: number, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : dflt;
};

type CleanResult = { ok: true; category: ForecastCategory } | { ok: false; error: string };
const GENERIC_CATEGORY_ERROR =
  "Each category must include a valid name, method, and method-specific configuration.";
const MANUAL_AMOUNT_MAX = "100000000.0000";

async function clean(
  raw: unknown,
  orgId: string,
  allowedSubsidiaryIds: Set<string> | null,
): Promise<CleanResult> {
  const bad = (error: string): CleanResult => ({ ok: false, error });
  if (!raw || typeof raw !== "object") return bad(GENERIC_CATEGORY_ERROR);
  const c = raw as Record<string, unknown>;
  // Every reference list below validates type, existence, and scope in one
  // pass (see ./category-references): the caller's subsidiary scope rides
  // along so a restricted writer cannot point a category at hidden books.
  const check = (
    field: string,
    table: "accounts" | "parties",
    kind: string,
    ids: string[],
    expect?: { accountType?: typeof BANK_ACCOUNT_TYPE | typeof CARD_ACCOUNT_TYPE; postable?: boolean; vendorRole?: boolean },
  ): Promise<string | null> =>
    validateReferences(orgId, [
      {
        field,
        table,
        kind,
        ids,
        allowedSubsidiaryIds,
        expectAccountType: expect?.accountType,
        expectPostable: expect?.postable,
        expectVendorRole: expect?.vendorRole,
      },
    ]);
  const name = typeof c.name === "string" ? c.name.trim().slice(0, 80) : "";
  const method = String(c.method ?? "");
  // A misspelled direction must refuse, never silently flip the sign: any
  // value other than exactly 'inflow'/'outflow' (including a missing one)
  // inverts every forecast week it touches.
  const direction =
    c.direction === "inflow" ? "inflow" : c.direction === "outflow" ? "outflow" : null;
  if (direction === null) return bad(GENERIC_CATEGORY_ERROR);
  if (!name || !METHODS.has(method)) return bad(GENERIC_CATEGORY_ERROR);
  const out: ForecastCategory = {
    id: typeof c.id === "string" && c.id ? c.id : randomUUID(),
    name,
    direction,
    method: method as ForecastCategory["method"],
  };

  // Shared placement + adjustment knobs (getProrationFactor inputs).
  const day = Number(c.expectedDay);
  if (c.expectedDay !== "" && c.expectedDay !== null && c.expectedDay !== undefined && Number.isInteger(day) && day >= 0 && day <= 6) {
    out.expectedDay = day;
  }
  const wk = Number(c.expectedWeek);
  if (c.expectedWeek !== "" && c.expectedWeek !== null && c.expectedWeek !== undefined && Number.isInteger(wk) && wk >= 1 && wk <= 4) {
    out.expectedWeek = wk;
  }
  const adj = Number(c.adjustmentPct);
  if (Number.isFinite(adj) && adj !== 0) out.adjustmentPct = Math.min(200, Math.max(-90, adj));

  if (method === "gl_history_average") {
    const ids = strList(c.accountIds, 50);
    if (!ids.length) return bad(GENERIC_CATEGORY_ERROR);
    const refError = await check("accountIds", "accounts", "an account", ids, { postable: true });
    if (refError) return bad(refError);
    out.accountIds = ids;
    out.historyWeeks = clampNum(c.historyWeeks, 1, 52, 12);
    if (c.useNetAmt === true) out.useNetAmt = true;
  } else if (method === "vendor_payment_history" || method === "vendor_recurring_average") {
    const ids = strList(c.partyIds, 50);
    if (!ids.length && typeof c.partyId === "string" && c.partyId) ids.push(c.partyId);
    if (!ids.length) return bad(GENERIC_CATEGORY_ERROR);
    const refError = await check("partyIds", "parties", "a party", ids, { vendorRole: true });
    if (refError) return bad(refError);
    out.partyIds = ids;
    out.partyId = ids[0];
    out.partyName = typeof c.partyName === "string" ? c.partyName.slice(0, 120) : undefined;
    out.historyMonths = clampNum(c.historyMonths, 1, 36, method === "vendor_recurring_average" ? 3 : 12);
  } else if (method === "credit_card_cycle") {
    const ids = strList(c.cardAccountIds, 20).length ? strList(c.cardAccountIds, 20) : strList(c.accountIds, 20);
    if (!ids.length) return bad(GENERIC_CATEGORY_ERROR);
    const refError = await check("cardAccountIds", "accounts", "an account", ids, { accountType: CARD_ACCOUNT_TYPE });
    if (refError) return bad(refError);
    out.cardAccountIds = ids;
    out.historyMonths = clampNum(c.historyMonths, 1, 24, 6);
    const threshold = Number(c.significantPaymentThreshold);
    if (Number.isFinite(threshold) && threshold > 0) out.significantPaymentThreshold = Math.min(1e9, threshold);
  } else if (method === "formula_expression") {
    const formula = typeof c.formula === "string" ? c.formula.trim().slice(0, 500) : "";
    if (!formula) return bad(GENERIC_CATEGORY_ERROR);
    out.formula = formula;
  } else if (method === "bank_register_history") {
    const ids = strList(c.bankAccountIds, 20);
    if (!ids.length) return bad(GENERIC_CATEGORY_ERROR);
    const refError = await check("bankAccountIds", "accounts", "an account", ids, { accountType: BANK_ACCOUNT_TYPE });
    if (refError) return bad(refError);
    out.bankAccountIds = ids;
    out.historyWeeks = clampNum(c.historyWeeks, 1, 52, 12);
    const keywords = strList(c.memoKeywords, 10).map((k) => k.trim().slice(0, 40)).filter(Boolean);
    if (keywords.length) out.memoKeywords = keywords;
    if (c.includeTransfers === false) out.includeTransfers = false;
    if (c.includeChecks === false) out.includeChecks = false;
    if (c.includeJournals === true) out.includeJournals = true;
  } else {
    // manual_recurring
    let amount: string;
    try {
      amount = normalizeMoney(String(c.amount ?? ""));
    } catch {
      return bad(GENERIC_CATEGORY_ERROR);
    }
    if (compareMoney(amount, "0.0000") <= 0) return bad(GENERIC_CATEGORY_ERROR);
    // An over-limit amount refuses naming the limit — silently clamping it
    // would store a number nobody typed.
    if (compareMoney(amount, MANUAL_AMOUNT_MAX) > 0) {
      return bad(`manual amount ${amount} exceeds the maximum ${MANUAL_AMOUNT_MAX}`);
    }
    // The persisted payment anchor pins the monthly/biweekly phase so moving
    // the forecast date never rephases the schedule. A writer that omits it
    // gets today stamped (stable from then on); a malformed one refuses.
    // The forecast also accepts legacy rows without it (they step from the
    // horizon start, as before) so the backfill is the only migration path
    // that needs to exist.
    const rawAnchor = c.anchorDate;
    if (rawAnchor === undefined || rawAnchor === null || rawAnchor === "") {
      out.anchorDate = new Date().toISOString().slice(0, 10);
    } else if (typeof rawAnchor === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawAnchor) && !Number.isNaN(Date.parse(`${rawAnchor}T00:00:00Z`))) {
      const [y, m, d] = rawAnchor.split("-").map(Number);
      if (m! < 1 || m! > 12) return bad(GENERIC_CATEGORY_ERROR);
      const days = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
      if (d! < 1 || d! > days) return bad(GENERIC_CATEGORY_ERROR);
      out.anchorDate = rawAnchor;
    } else {
      return bad(GENERIC_CATEGORY_ERROR);
    }
    // ForecastCategory's legacy declaration still says `number`, but the
    // persisted/read model is an exact numeric(19,4) string. Keep this route
    // on the exact-money path without crossing through an unsafe float.
    (out as unknown as { amount?: string }).amount = amount;
    out.frequency = FREQUENCIES.has(String(c.frequency)) ? (c.frequency as ForecastCategory["frequency"]) : "monthly";
  }
  return { ok: true, category: out };
}

export async function GET() {
  const gate = await guardPermission("reports.read");
  if (gate instanceof NextResponse) return gate;
  const r = ((await db.execute(sql`
    select settings -> 'analytics' -> 'cashflowCategories' as cats,
           coalesce((settings -> 'analytics' ->> 'cashflowCategoriesRevision')::int, 0) as rev
      from orgs where id = ${gate.user.orgId}
  `)));
  const raw = r.rows[0]?.cats;
  return NextResponse.json({
    categories: Array.isArray(raw) ? raw : [],
    revision: typeof r.rows[0]?.rev === "number" ? r.rows[0].rev : 0,
  });
}

export async function PUT(req: Request) {
  const gate = await guardPermission("admin.setup.manage");
  if (gate instanceof NextResponse) return gate;
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { categories?: unknown[]; expectedRevision?: unknown } | null;
  if (!body || !Array.isArray(body.categories)) return NextResponse.json({ error: "categories array required" }, { status: 400 });
  if (body.categories.length > 50) return NextResponse.json({ error: "too many categories (max 50)" }, { status: 400 });
  // Optimistic concurrency: the editor sends the revision it read, and a
  // stale writer gets 409 instead of silently discarding the other edit.
  if (!Number.isInteger(body.expectedRevision)) {
    return NextResponse.json(
      { error: "expectedRevision required", message: "Send the revision returned by GET with every replacement." },
      { status: 400 },
    );
  }
  const expectedRevision = body.expectedRevision as number;

  // Sequential: the first invalid index wins, and reference checks stay ordered.
  const cleaned: CleanResult[] = [];
  for (const raw of body.categories) {
    cleaned.push(await clean(raw, gate.user.orgId, gate.allowedSubsidiaryIds));
  }
  const invalidIndex = cleaned.findIndex((result) => !result.ok);
  if (invalidIndex !== -1) {
    const failure = cleaned[invalidIndex] as { ok: false; error: string };
    return NextResponse.json(
      {
        error: `invalid category at index ${invalidIndex}`,
        message: failure.error,
      },
      { status: 400 },
    );
  }
  // Every result is ok here (any failure returned above); project the stored rows.
  const categories = cleaned.flatMap((result) => (result.ok ? [result.category] : []));

  // Lock the current document and commit its replacement together with complete
  // before/after audit evidence. A malformed payload returns above, before a
  // transaction or mutation can begin. The revision is read from the locked
  // row and the replacement refused when it moved: concurrent editors
  // serialize on the org row, but serialization alone would still let the
  // second writer silently discard the first — the 409 forces a re-read.
  const result = await db.transaction(async (tx) => {
    const existing = await tx.execute(sql`
      select settings -> 'analytics' -> 'cashflowCategories' as cats,
             coalesce((settings -> 'analytics' ->> 'cashflowCategoriesRevision')::int, 0) as rev
        from orgs where id = ${gate.user.orgId} for update
    `);
    if (!existing.rows[0]) return NextResponse.json({ error: "org not found" }, { status: 404 });
    const currentRevision = typeof existing.rows[0].rev === "number" ? existing.rows[0].rev : 0;
    if (currentRevision !== expectedRevision) {
      return NextResponse.json(
        {
          error: "revision conflict",
          message: `Cashflow categories changed since revision ${expectedRevision} (now at ${currentRevision}): reload and reapply your edit.`,
          revision: currentRevision,
        },
        { status: 409 },
      );
    }
    const rawBefore = existing.rows[0].cats;
    const before = Array.isArray(rawBefore) ? rawBefore : [];
    const nextRevision = currentRevision + 1;
    await tx.execute(sql`
      update orgs
      set settings = jsonb_set(
        jsonb_set(
          jsonb_set(coalesce(settings, '{}'::jsonb), '{analytics}', coalesce(settings -> 'analytics', '{}'::jsonb), true),
          '{analytics,cashflowCategories}', ${JSON.stringify(categories)}::jsonb, true),
        '{analytics,cashflowCategoriesRevision}', ${JSON.stringify(nextRevision)}::jsonb, true)
      where id = ${gate.user.orgId}
    `);
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (
        ${gate.user.orgId}, 'orgs', ${gate.user.orgId}, 'update',
        ${JSON.stringify({
          before: { analytics: { cashflowCategories: before } },
          after: { analytics: { cashflowCategories: categories } },
        })}::jsonb,
        ${gate.user.id}
      )
    `);
    return nextRevision;
  });
  if (result instanceof NextResponse) return result;
  return NextResponse.json({ ok: true, categories, revision: result });
}
