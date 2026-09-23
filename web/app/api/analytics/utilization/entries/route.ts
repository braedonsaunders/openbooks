import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { mul, mulDecimal } from "@openbooks/engine/src/money/money.ts";
import { guardFeaturePermission } from "../../../../../lib/feature-gates";
import { flowRates, presentationCurrency } from "../../../../../lib/fx-presentation";
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
  if ((!employee && !item) || !from || !to) {
    return NextResponse.json({ error: "employee or item, plus from/to required" }, { status: 400 });
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
  const res = await db.execute(sql`
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
    from time_entries t
    left join items i on i.id = t.item_id and i.org_id = t.org_id
    left join parties emp on emp.id = t.employee_party_id and emp.org_id = t.org_id
    left join projects pr on pr.id = t.project_id and pr.org_id = t.org_id
    left join parties cust on cust.id = pr.customer_id and cust.org_id = t.org_id
    left join subsidiaries crs on crs.id = t.cost_rate_subsidiary_id and crs.org_id = t.org_id
    join orgs o on o.id = t.org_id
    where t.org_id = ${user.orgId} and ${filter}
      and t.worked_on >= ${from} and t.worked_on <= ${to}
      and (t.memo_is_private is not true)
      -- Draft, submitted and rejected hours are not worked reality (rejected
      -- hours never will be) — the same approved-only rule as the dashboard
      -- aggregate and project profitability hours.
      and t.status = 'approved'
      ${scope}
    order by t.worked_on desc
    limit 500
  `);

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
  return NextResponse.json({ entries, currency });
}
