import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { installedPayrollCountries } from "@openbooks/engine/src/payroll/readiness.ts";
import { employerFactsFor } from "@openbooks/engine/src/payroll/employer-facts.ts";
import { listFilingAccounts } from "@openbooks/engine/src/payroll/filing.ts";
import { listPayrollEmployerFacts, upsertPayrollEmployerFact } from "@openbooks/engine/src/payroll/employer-fact-store.ts";
import { PayrollPackError, payrollPack } from "@openbooks/engine/src/payroll/packs.ts";
import { guardFeaturePermission } from "../../../../../lib/feature-gates";
import { guardRootSubsidiaryScope } from "../../../../../lib/authz";
import { isUuid } from "../../../../../lib/list-params";
import { guardPayrollFilingAccounts } from "../../subsidiary-scope";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await guardFeaturePermission("payroll.manage", "payroll");
  if (gate instanceof NextResponse) return gate;
  const scopeDenied = await guardRootSubsidiaryScope(gate);
  if (scopeDenied) return scopeDenied;
  const orgId = gate.user.orgId;
  const [org, subsidiaries, allAccounts] = await Promise.all([
    db.execute<{ payroll: Record<string, unknown> | null }>(sql`
      select settings->'payroll' as payroll from orgs where id = ${orgId}`),
    db.execute<{ id: string; name: string; country: string | null }>(sql`
      select id, name, country from subsidiaries
       where org_id = ${orgId} and is_active and not is_elimination
       order by name, id`),
    listFilingAccounts(orgId),
  ]);
  const installed = await installedPayrollCountries(orgId, org.rows[0]?.payroll ?? {});
  const packs = installed.flatMap((country) => {
    const facts = employerFactsFor(country);
    return facts.length === 0 ? [] : [{ country, facts }];
  });
  const rows = await listPayrollEmployerFacts(orgId);
  const accountPrograms = new Set(packs.flatMap(({ country, facts }) => facts
    .filter((fact) => fact.scope === "filing_account")
    .map((fact) => `${country}\u001f${fact.filingProgramType}`)));
  const candidates = allAccounts.filter((account) => account.isActive
    && accountPrograms.has(`${account.country}\u001f${account.programType}`));
  const filingAccounts = (await Promise.all(candidates.map(async (account) => ({
    account,
    denied: await guardPayrollFilingAccounts(gate, [account.id]),
  })))).filter(({ denied }) => !denied).map(({ account }) => account);
  return NextResponse.json({
    packs,
    rows: rows.filter((row) => installed.includes(row.country)),
    subsidiaries: subsidiaries.rows,
    filingAccounts,
  });
}

export async function PUT(req: Request) {
  const gate = await guardFeaturePermission("payroll.manage", "payroll");
  if (gate instanceof NextResponse) return gate;
  const scopeDenied = await guardRootSubsidiaryScope(gate);
  if (scopeDenied) return scopeDenied;
  const parsed = await parseJsonBody(req, jsonObject);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const country = typeof body.country === "string" ? body.country : "";
  const factKey = typeof body.factKey === "string" ? body.factKey : "";
  const subsidiaryId = typeof body.subsidiaryId === "string" ? body.subsidiaryId : null;
  const filingAccountId = typeof body.filingAccountId === "string" ? body.filingAccountId : null;
  const effectiveFrom = typeof body.effectiveFrom === "string" ? body.effectiveFrom : "";
  const effectiveThrough = typeof body.effectiveThrough === "string" ? body.effectiveThrough : null;
  const value = typeof body.value === "string" ? body.value : "";
  const changeReason = typeof body.changeReason === "string" ? body.changeReason : "";
  if (!country || !factKey || !effectiveFrom || !value || !changeReason) {
    return NextResponse.json({ error: "country, factKey, effectiveFrom, value, and changeReason are required" }, { status: 422 });
  }
  try {
    const pack = payrollPack(country);
    const settings = await db.execute<{ payroll: Record<string, unknown> | null }>(sql`
      select settings->'payroll' as payroll from orgs where id = ${gate.user.orgId}`);
    if (!(await installedPayrollCountries(gate.user.orgId, settings.rows[0]?.payroll ?? {})).includes(country)) {
      return NextResponse.json({ error: `payroll pack ${country} is not installed for this organization` }, { status: 422 });
    }
    const declaration = pack.employerFacts.find((fact) => fact.key === factKey);
    if (!declaration) {
      throw new PayrollPackError(`the ${country} pack declares no employer fact "${factKey}"`);
    }
    if (declaration.scope === "filing_account") {
      if (!filingAccountId || subsidiaryId || !isUuid(filingAccountId)) {
        return NextResponse.json({ error: "select exactly one filing account for this employer fact" }, { status: 422 });
      }
      const denied = await guardPayrollFilingAccounts(gate, [filingAccountId]);
      if (denied) return denied;
    } else {
      if (!subsidiaryId || filingAccountId) {
        return NextResponse.json({ error: "select exactly one legal employer for this employer fact" }, { status: 422 });
      }
      if (!isUuid(subsidiaryId)) {
        return NextResponse.json({ error: "invalid legal-employer subsidiary" }, { status: 422 });
      }
      const owned = await db.execute<{ country: string | null }>(sql`
        select country from subsidiaries where org_id = ${gate.user.orgId}
         and id = ${subsidiaryId} and is_active and not is_elimination`);
      if (!owned.rows[0] || owned.rows[0].country !== country) {
        return NextResponse.json({ error: "legal employer subsidiary is not available for this payroll country" }, { status: 422 });
      }
    }
    const saved = await upsertPayrollEmployerFact({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      subsidiaryId,
      filingAccountId,
      country,
      factKey,
      effectiveFrom,
      effectiveThrough,
      value,
      changeReason,
    });
    return NextResponse.json({ ok: true, row: saved });
  } catch (error) {
    if (error instanceof PayrollPackError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    throw error;
  }
}
