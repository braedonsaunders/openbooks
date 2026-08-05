import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { currentUser } from "../../../../../lib/auth";

export const runtime = "nodejs";

/**
 * Individual time entries behind a Utilization drill-down — the openbooks
 * equivalent of the `employee_entries` / `item_entries` sub-actions.
 * Feeds the native Drawer flyouts on the Employees / Items / Titles tabs.
 */
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const employee = url.searchParams.get("employee");
  const item = url.searchParams.get("item");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if ((!employee && !item) || !from || !to) {
    return NextResponse.json({ error: "employee or item, plus from/to required" }, { status: 400 });
  }

  const filter = employee ? sql`t.employee_party_id = ${employee}` : sql`t.item_id = ${item}`;
  const res: any = await db.execute(sql`
    select
      t.id,
      t.worked_on::text as date,
      t.hours,
      t.is_billable,
      coalesce(t.cost_rate, 0) as cost_rate,
      i.name as item_name,
      emp.display_name as employee_name,
      pr.name as project_name,
      cust.display_name as customer_name,
      t.memo
    from time_entries t
    left join items i on i.id = t.item_id
    left join parties emp on emp.id = t.employee_party_id
    left join projects pr on pr.id = t.project_id
    left join parties cust on cust.id = pr.customer_id
    where t.org_id = ${user.orgId} and ${filter}
      and t.worked_on >= ${from} and t.worked_on <= ${to}
      and (t.memo_is_private is not true)
    order by t.worked_on desc
    limit 500
  `);

  const entries = (res.rows as any[]).map((r) => ({
    id: r.id,
    date: r.date,
    hours: Number(r.hours ?? 0),
    billable: Boolean(r.is_billable),
    cost: Number(r.cost_rate ?? 0) * Number(r.hours ?? 0),
    itemName: r.item_name ?? "—",
    employeeName: r.employee_name ?? "—",
    customerName: r.customer_name ?? r.project_name ?? "",
    memo: r.memo ?? "",
  }));
  return NextResponse.json({ entries });
}
