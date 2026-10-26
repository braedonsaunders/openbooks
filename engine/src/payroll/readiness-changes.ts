import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { PayrollError } from "./error.ts";
import { add, cmp, neg, sum } from "../money/money.ts";
import { payrollSubsidiaryScopeFilter, type PayrollSubsidiaryScope } from "./scope.ts";
import { runContext } from "./readiness-context.ts";

/** Per-employee changes between this pay run and the previous pay. */

export interface StubChange {
  employeePartyId: string;
  employeeName: string;
  /** Pay date of the previous committed stub, when there is one. */
  previousPayDate: string | null;
  netDelta: string;
  grossDelta: string;
  hoursDelta: string;
  /** Component-level differences: added, removed, or changed amount. */
  changes: {
    kind: "added" | "removed" | "changed";
    component: string;
    from: string | null;
    to: string | null;
  }[];
}

/**
 * What changed for each employee since their previous committed stub.
 * Payroll review is a diff exercise — reconstructing it by eye is exactly
 * where errors survive — so compare the component sets, not just net pay.
 */
export async function payRunChanges(
  orgId: string,
  documentId: string,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<StubChange[]> {
  const run = await runContext(orgId, documentId, allowedSubsidiaryIds);
  // A missing run is a named not-found regardless of scope: without one the
  // empty stub set reads as a clean no-changes diff for a run that is not
  // there at all.
  if (!run) throw new PayrollError("pay run not found");
  const rows = await db.execute<{
    employee_party_id: string;
    name: string;
    gross: string;
    net_pay: string;
    prev_gross: string | null;
    prev_net: string | null;
    prev_pay_date: string | null;
    current_lines: { d: string; a: string; h: string | null }[] | null;
    previous_lines: { d: string; a: string; h: string | null }[] | null;
  }>(
    sql`
    with current_stub as (
      select s.id, s.employee_party_id, p.display_name as name, s.gross, s.net_pay
        from pay_stubs s
        join parties p on p.id = s.employee_party_id and p.org_id = s.org_id
       where s.org_id = ${orgId} and s.pay_run_document_id = ${documentId}
         ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)}
    ),
    previous_stub as (
      select distinct on (s.employee_party_id)
             s.employee_party_id, s.id, s.gross, s.net_pay, s.pay_date::text as pay_date
        from pay_stubs s
        join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
       where s.org_id = ${orgId} and s.pay_run_document_id <> ${documentId}
       order by s.employee_party_id, s.pay_date desc, s.id desc
    )
    select c.employee_party_id, c.name, c.gross, c.net_pay,
           pv.gross as prev_gross, pv.net_pay as prev_net, pv.pay_date as prev_pay_date,
           coalesce((select json_agg(json_build_object('d', l.description, 'a', l.amount, 'h', l.hours))
                       from pay_stub_lines l where l.org_id = ${orgId} and l.stub_id = c.id), '[]'::json) as current_lines,
           coalesce((select json_agg(json_build_object('d', l.description, 'a', l.amount, 'h', l.hours))
                       from pay_stub_lines l where l.org_id = ${orgId} and l.stub_id = pv.id), '[]'::json) as previous_lines
      from current_stub c
      left join previous_stub pv on pv.employee_party_id = c.employee_party_id
     order by c.name
  `,
    "objects",
  );

  const fold = (lines: { d: string; a: string; h: string | null }[] | null) => {
    const map = new Map<string, { amount: string; hours: string }>();
    for (const line of lines ?? []) {
      const seen = map.get(line.d) ?? { amount: "0", hours: "0" };
      map.set(line.d, {
        amount: add(seen.amount, line.a),
        hours: add(seen.hours, line.h ?? "0"),
      });
    }
    return map;
  };

  return rows.map((row) => {
    const now = fold(row.current_lines);
    const before = fold(row.previous_lines);
    const changes: StubChange["changes"] = [];
    for (const [component, value] of now) {
      const prior = before.get(component);
      if (!prior) changes.push({ kind: "added", component, from: null, to: value.amount });
      else if (cmp(prior.amount, value.amount) !== 0) {
        changes.push({ kind: "changed", component, from: prior.amount, to: value.amount });
      }
    }
    for (const [component, value] of before) {
      if (!now.has(component)) {
        changes.push({ kind: "removed", component, from: value.amount, to: null });
      }
    }
    return {
      employeePartyId: row.employee_party_id,
      employeeName: row.name,
      previousPayDate: row.prev_pay_date,
      netDelta: add(row.net_pay, neg(row.prev_net ?? "0")),
      grossDelta: add(row.gross, neg(row.prev_gross ?? "0")),
      hoursDelta: add(
        sum([...now.values()].map((v) => v.hours)),
        neg(sum([...before.values()].map((v) => v.hours))),
      ),
      changes,
    };
  });
}
