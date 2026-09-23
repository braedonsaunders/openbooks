import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { isIsoCalendarDate } from "@openbooks/engine/src/platform/business-date.ts";
import { mul, mulDecimal } from "@openbooks/engine/src/money/money.ts";
import { guardFeaturePermission } from "../../../../../lib/feature-gates";
import { flowRates, presentationCurrency } from "../../../../../lib/fx-presentation";
import { isUuid } from "../../../../../lib/list-params";
import { subsidiaryVisibleFilter } from "../../../../../lib/subsidiaries";

export const runtime = "nodejs";

/**
 * Individual time entries behind a Utilization drill-down — the openbooks
 * equivalent of the `employee_entries` / `item_entries` sub-actions.
 * Feeds the native Drawer flyouts on the Employees / Items / Titles tabs.
 */
export async function GET(req: Request) {
  const gate = await guardFeaturePermission("reports.read", "timeTracking");
  if (gate instanceof NextResponse) return gate;
  const user = gate.user;

  const url = new URL(req.url);
  const employee = url.searchParams.get("employee");
  const item = url.searchParams.get("item");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if ((!employee && !item) || !isIsoCalendarDate(from) || !isIsoCalendarDate(to) || from > to) {
    return NextResponse.json({ error: "employee or item, plus valid from/to calendar dates (from <= to) required" }, { status: 400 });
  }
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw === null ? 500 : Math.floor(Number(limitRaw));
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    return NextResponse.json({ error: "limit must be an integer from 1 to 500" }, { status: 400 });
  }
  const cursorRaw = url.searchParams.get("cursor");
  let cursor: { date: string; id: string } | null = null;
  if (cursorRaw !== null) {
    const sep = cursorRaw.indexOf("|");
    const cursorDate = sep === -1 ? "" : cursorRaw.slice(0, sep);
    const cursorId = sep === -1 ? "" : cursorRaw.slice(sep + 1);
    if (!isIsoCalendarDate(cursorDate) || !isUuid(cursorId)) {
      return NextResponse.json({ error: "invalid cursor" }, { status: 400 });
    }
    cursor = { date: cursorDate, id: cursorId };
  }

  const filter = employee ? sql`t.employee_party_id = ${employee}` : sql`t.item_id = ${item}`;
  // The same legal-entity population as the dashboard drill-down source
  // (utilization-data fetchTimeStats): an entry is visible when the caller's
  // scope admits coalesce(project, employee) subsidiary. Restricted callers
  // see no out-of-scope rows — never names, hours, memos or cost.
  const scope = subsidiaryVisibleFilter(
    sql`coalesce(pr.subsidiary_id, emp.subsidiary_id)`,
    gate.allowedSubsidiaryIds,
  );
  // The full-population predicate, shared by the page, the totals and the
  // group shares — headline and shares always read the whole population,
  // never the visible page.
  const population = sql`
    t.org_id = ${user.orgId} and ${filter}
      and t.worked_on >= ${from} and t.worked_on <= ${to}
      and (t.memo_is_private is not true)
      -- Draft, submitted and rejected hours are not worked reality (rejected
      -- hours never will be) — the same approved-only rule as the dashboard
      -- aggregate and project profitability hours.
      and t.status = 'approved'
      ${scope}`;
  const cursorFilter = cursor
    ? sql`and (t.worked_on < ${cursor.date} or (t.worked_on = ${cursor.date} and t.id < ${cursor.id}::uuid))`
    : sql``;
  // Group labels mirror the drawer: an employee drill groups by service item,
  // an item drill by employee; customers fall back exactly as the row does.
  const peerLabel = employee ? sql`coalesce(i.name, '—')` : sql`coalesce(emp.display_name, '—')`;
  const customerLabel = sql`coalesce(cust.display_name, pr.name, '')`;
  const joins = sql`
    from time_entries t
    left join items i on i.id = t.item_id and i.org_id = t.org_id
    left join parties emp on emp.id = t.employee_party_id and emp.org_id = t.org_id
    left join projects pr on pr.id = t.project_id and pr.org_id = t.org_id
    left join parties cust on cust.id = pr.customer_id and cust.org_id = t.org_id
    left join subsidiaries crs on crs.id = t.cost_rate_subsidiary_id and crs.org_id = t.org_id
    join orgs o on o.id = t.org_id`;
  const [page, totals, peerGroups, customerGroups] = await Promise.all([
    db.execute(sql`
      select
        t.id,
        t.worked_on::text as date,
        t.hours,
        t.is_billable,
        coalesce(t.cost_rate, 0) as cost_rate,
        -- The rate's functional currency, resolved exactly as the dashboard
        -- aggregate does: the stamped currency, else the rate subsidiary's
        -- base, else the org base.
        coalesce(t.cost_rate_currency, crs.base_currency, o.base_currency) as func,
        i.name as item_name,
        emp.display_name as employee_name,
        pr.name as project_name,
        cust.display_name as customer_name,
        t.memo
      ${joins}
      where ${population}
        ${cursorFilter}
      order by t.worked_on desc, t.id desc
      limit ${limit + 1}
    `),
    db.execute(sql`
      select count(*) as n,
        coalesce(sum(t.hours), 0)::text as hours,
        coalesce(sum(t.hours) filter (where t.is_billable), 0)::text as billable
      ${joins}
      where ${population}
    `),
    db.execute(sql`
      select ${peerLabel} as label,
        coalesce(sum(t.hours), 0)::text as hours,
        coalesce(sum(t.hours) filter (where t.is_billable), 0)::text as billable
      ${joins}
      where ${population}
      group by 1
      order by sum(t.hours) desc
    `),
    db.execute(sql`
      select ${customerLabel} as label,
        coalesce(sum(t.hours), 0)::text as hours,
        coalesce(sum(t.hours) filter (where t.is_billable), 0)::text as billable
      ${joins}
      where ${population}
      group by 1
      order by sum(t.hours) desc
    `),
  ]);
  const hasMore = page.rows.length > limit;
  const rows = hasMore ? page.rows.slice(0, limit) : page.rows;
  const last = rows[rows.length - 1];
  const nextCursor = hasMore && last ? `${String(last.date).slice(0, 10)}|${String(last.id)}` : null;
  const res = { rows };

  // Labour cost translates per leg at the worked date through the same flow
  // path as the dashboard: a leg without rate coverage is a named refusal,
  // never a silent 1:1 mix.
  const ratesResult = await flowRates(user.orgId, res.rows.map((r) => ({
    func: (r.func as string | null) ?? null,
    date: String(r.date ?? from).slice(0, 10),
  }))).then(
    (rates) => ({ ok: true as const, rates }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  if (!ratesResult.ok) {
    return NextResponse.json(
      { error: "missing exchange rate", message: ratesResult.error instanceof Error ? ratesResult.error.message : String(ratesResult.error) },
      { status: 422 },
    );
  }
  const rates = ratesResult.rates;
  let entries;
  try {
    entries = ((res.rows)).map((r) => {
      const native = mul(String(r.cost_rate ?? "0"), String(r.hours ?? "0"));
      return {
        id: r.id,
        date: r.date,
        hours: Number(r.hours ?? 0),
        billable: Boolean(r.is_billable),
        cost: mulDecimal(native, rates.rateAt((r.func as string | null) ?? null, String(r.date ?? from).slice(0, 10))),
        itemName: r.item_name ?? "—",
        employeeName: r.employee_name ?? "—",
        customerName: r.customer_name ?? r.project_name ?? "",
        memo: r.memo ?? "",
      };
    });
  } catch (error) {
    return NextResponse.json(
      { error: "missing exchange rate", message: error instanceof Error ? error.message : String(error) },
      { status: 422 },
    );
  }
  const currency = rates.base || await presentationCurrency(user.orgId);
  const totalRow = totals.rows[0];
  const groupRows = (result: { rows: unknown[] }) =>
    (result.rows as Array<{ label: unknown; hours: unknown; billable: unknown }>).map((g) => ({
      label: String(g.label ?? ""),
      hours: String(g.hours ?? "0"),
      billableHours: String(g.billable ?? "0"),
    }));
  return NextResponse.json({
    entries,
    currency,
    total: {
      count: Number(totalRow?.n ?? 0),
      hours: String(totalRow?.hours ?? "0"),
      billableHours: String(totalRow?.billable ?? "0"),
    },
    groups: {
      byPeer: groupRows(peerGroups),
      byCustomer: groupRows(customerGroups),
    },
    page: { limit, nextCursor, hasMore },
  });
}
