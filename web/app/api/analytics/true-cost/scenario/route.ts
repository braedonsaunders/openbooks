import { NextResponse } from "next/server";
import { guardPermission } from "../../../../../lib/authz";
import { resolvePeriod } from "../../../../../lib/periods";
import { trueCostData } from "../../../../../lib/analytics/true-cost-data";
import { calculateScenario, type ScenarioType, type ScenarioInput } from "../../../../../lib/analytics/true-cost-engine";

export const runtime = "nodejs";

const TYPES = new Set<ScenarioType>(["hire", "terminate", "win_contract", "lose_contract", "cost_change", "utilization_change"]);

/**
 * True Cost scenario modeler — computes the projected composite rate for a
 * what-if (hire / terminate / win-contract / lose-contract / cost-change /
 * utilization-change) against the live burden engine, exactly as Gantry's
 * calculateScenario does (2080 hrs/yr, configurable fringe rate).
 */
export async function POST(req: Request) {
  const gate = await guardPermission("reports.read");
  if (gate instanceof NextResponse) return gate;
  const body = (await req.json().catch(() => null)) as (ScenarioInput & { period?: string; from?: string; to?: string }) | null;
  if (!body || !TYPES.has(body.scenarioType)) return NextResponse.json({ error: "valid scenarioType required" }, { status: 400 });

  const period = await resolvePeriod(body.period, { customFrom: body.from, customTo: body.to });
  const data = await trueCostData(gate.user.orgId, { from: period.from, to: period.to, label: period.label });

  const impact = calculateScenario(
    {
      scenarioType: body.scenarioType,
      employeeCount: body.employeeCount,
      avgSalary: body.avgSalary,
      expectedUtilization: body.expectedUtilization,
      annualHours: body.annualHours,
      changeType: body.changeType,
      amount: body.amount,
      newUtilization: body.newUtilization,
    },
    {
      currentRate: data.kpis.compositeRate,
      currentExpense: data.kpis.totalOverhead,
      currentHours: data.kpis.billedHours,
      currentUtilization: data.kpis.utilization > 0 ? data.kpis.utilization : 0.75,
      fringeRate: data.config.fringeRate,
    },
  );
  return NextResponse.json({ impact });
}
