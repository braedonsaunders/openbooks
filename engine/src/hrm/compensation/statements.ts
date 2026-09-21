import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { renderPdfDocument } from "@openbooks/pdf";
import { db, withOrgTransaction } from "../../platform/db.ts";
import { businessToday } from "../../platform/business-date.ts";
import { resolveWage, laborCostingSettings } from "../../projects/labor-costing.ts";
import { mul } from "../../money/money.ts";
import {
  loadOwnEmploymentIds,
  requireHrmCompensationManage,
  requireHrmCompensationRead,
} from "../authorization.ts";
import { CompensationError } from "./errors.ts";
import { resolveBandForScope } from "./bands.ts";
import { bandPlacement } from "./compensation-math.ts";
import { requireActorId, requireId, requireOrgId } from "../recruiting/input.ts";

/**
 * Total-rewards statements (HR-12, 0221): frozen per-employment payloads
 * with an optional rendered PDF.
 *
 * Generate reads the current payroll-side rate, the band placement, the
 * employer-paid benefits from hrm_benefit_enrollments amounts, and the
 * latest decided cycle line — and freezes them into payload jsonb.
 * Regeneration is a new row; a delivered statement is never overwritten.
 * The person reads their own statements through hrm.self.read; HR reads
 * any through hrm.compensation.read.
 */

export interface StatementDTO {
  readonly id: string;
  readonly employmentId: string;
  readonly cycleId: string | null;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly payload: Record<string, unknown>;
  readonly fileId: string | null;
  readonly generatedAt: string;
}

type StatementRow = {
  id: string;
  employment_id: string;
  cycle_id: string | null;
  period_from: string;
  period_to: string;
  payload: Record<string, unknown>;
  file_id: string | null;
  generated_at: string;
};

function toStatementDTO(row: StatementRow): StatementDTO {
  return {
    id: row.id,
    employmentId: row.employment_id,
    cycleId: row.cycle_id,
    periodFrom: String(row.period_from).slice(0, 10),
    periodTo: String(row.period_to).slice(0, 10),
    payload: row.payload,
    fileId: row.file_id,
    generatedAt: String(row.generated_at),
  };
}

async function buildPayload(
  orgId: string,
  employmentId: string,
  workerPartyId: string,
  cycleId: string | null,
  asOf: string,
): Promise<Record<string, unknown>> {
  const settings = await laborCostingSettings(orgId);
  const wage = await resolveWage(orgId, workerPartyId, asOf, {});
  // Annual truth without a round-trip (see bands.ts): an annual native
  // row prices directly; otherwise annualise the hourly wage.
  const native = wage
    ? (await db.execute<{ rate: string; basis: string; currency: string }>(sql`
      select rate::text as rate, basis, currency
        from labor_cost_rates
       where org_id = ${orgId} and employee_party_id = ${workerPartyId} and is_active
         and effective_from <= ${asOf}::date
         and (effective_to is null or effective_to >= ${asOf}::date)
       order by effective_from desc
       limit 1`)).rows[0]
    : undefined;
  const currentRate =
    wage === null
      ? null
      : native && native.basis === "year"
        ? { rate: String(native.rate), currency: native.currency, basis: "annual" }
        : { rate: mul(wage.wage, String(settings.annualHours)), currency: wage.currency, basis: "annual" };
  let placement: Record<string, unknown> | null = null;
  // Band placement frozen without the actor-gated read (the caller is
  // already gated): position level at the date, narrowest live band,
  // rate over target. No band or no wage freezes as "no band", never 0.
  const assignment = (await db.execute<{ position_id: string | null; department_id: string | null; location_id: string | null }>(sql`
    select position_id, department_id, location_id
      from employment_assignment_versions
     where org_id = ${orgId} and employment_id = ${employmentId} and is_primary
       and effective_from <= ${asOf}::date
       and (effective_to is null or effective_to >= ${asOf}::date)
       and recorded_until is null
     order by effective_from desc limit 1`)).rows[0];
  const position = assignment?.position_id
    ? (await db.execute<{ level_id: string | null; location_id: string | null; employer_subsidiary_id: string }>(sql`
      select job_level_id as level_id, location_id, employer_subsidiary_id
        from position_versions
       where org_id = ${orgId} and position_id = ${assignment.position_id}
         and effective_from <= ${asOf}::date
         and (effective_to is null or effective_to >= ${asOf}::date)
         and recorded_until is null
       order by effective_from desc limit 1`)).rows[0]
    : undefined;
  const levelId = position?.level_id ?? null;
  if (levelId && currentRate) {
    const level = (await db.execute<{ family_id: string | null }>(sql`
      select family_id from hrm_job_levels where org_id = ${orgId} and id = ${levelId}`)).rows[0];
    const band = await resolveBandForScope(
      orgId,
      {
        familyId: level?.family_id ?? null,
        levelId,
        employerSubsidiaryId: position?.employer_subsidiary_id ?? null,
        locationId: position?.location_id ?? assignment?.location_id ?? null,
        currency: currentRate.currency,
        basis: "annual",
      },
      asOf,
    );
    placement =
      band === null
        ? { placement: "no_band" }
        : (() => {
            const placed = bandPlacement(currentRate.rate, band.min, band.target, band.max);
            return {
              placement: placed.placement,
              compaRatio: placed.compaRatio,
              band: { min: band.min, target: band.target, max: band.max, currency: band.currency },
            };
          })();
  } else {
    placement = { placement: "no_band" };
  }
  const benefits = (await db.execute<{
    plan: string;
    employer_amount: string | null;
    currency: string;
  }>(sql`
    select p.name as plan, e.employer_amount_per_period::text as employer_amount, e.currency
      from hrm_benefit_enrollments e
      join hrm_benefit_plans p on p.org_id = e.org_id and p.id = e.plan_id
     where e.org_id = ${orgId} and e.employment_id = ${employmentId}
       and e.status = 'elected'
       and e.effective_from <= ${asOf}::date
       and (e.effective_to is null or e.effective_to >= ${asOf}::date)`)).rows;
  let cycleDecision: Record<string, unknown> | null = null;
  if (cycleId !== null) {
    const line = (await db.execute<{
      status: string;
      proposed_pct: string | null;
      proposed_rate: string | null;
      reason: string | null;
    }>(sql`
      select status, proposed_pct::text, proposed_rate::text, reason
        from hrm_comp_cycle_lines
       where org_id = ${orgId} and cycle_id = ${cycleId} and employment_id = ${employmentId}`)).rows[0];
    if (line) {
      cycleDecision = {
        status: line.status,
        proposedPct: line.proposed_pct,
        proposedRate: line.proposed_rate,
        reason: line.reason,
      };
    }
  }
  return {
    asOf,
    currentRate,
    bandPlacement: placement,
    employerPaidBenefits: benefits,
    cycleDecision,
  };
}

/** Generate (freeze) a statement. HR may generate for any employment; the person generates their own. */
export async function generateStatement(query: {
  orgId: string;
  actorId: string;
  employmentId: string;
  cycleId?: string | null;
  periodFrom: string;
  periodTo: string;
}): Promise<StatementDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const employmentId = requireId(query.employmentId, "employmentId");
  return withOrgTransaction(orgId, async () => {
    const employment = (await db.execute<{ worker_party_id: string }>(sql`
      select worker_party_id from worker_employments where org_id = ${orgId} and id = ${employmentId}`)).rows[0];
    if (!employment) {
      throw new CompensationError("NOT_FOUND", "employment is not visible in this organization");
    }
    // HR's path first; otherwise the person's own employment only.
    let hr = false;
    try {
      await requireHrmCompensationManage(db, orgId, actorId);
      hr = true;
    } catch {
      await requireHrmCompensationRead(db, orgId, actorId);
      const own = await loadOwnEmploymentIds(db, orgId, actorId);
      if (!own.includes(employmentId)) {
        throw new CompensationError(
          "REFUSED",
          "statements generate for your own employment — ask HR to generate anyone else's",
        );
      }
    }
    void hr;
    const today = await businessToday(orgId);
    const payload = await buildPayload(orgId, employmentId, employment.worker_party_id, query.cycleId ?? null, today);
    const row = (await db.execute<StatementRow>(sql`
      insert into hrm_comp_statements
        (org_id, employment_id, cycle_id, period_from, period_to, payload, generated_by, created_by, updated_by)
      values (${orgId}, ${employmentId}, ${query.cycleId ?? null},
              ${query.periodFrom}, ${query.periodTo}, ${JSON.stringify(payload)}::jsonb,
              ${actorId}, ${actorId}, ${actorId})
      returning id, employment_id, cycle_id, period_from::text as period_from, period_to::text as period_to,
                payload, file_id, generated_at::text as generated_at`)).rows[0];
    if (!row) throw new CompensationError("REFUSED", "the statement insert matched no row — the save is refused, never a silent success");
    return toStatementDTO(row);
  });
}

/** Render a stored statement to PDF through packages/pdf (pure renderer, no Chromium). */
export async function renderStatementPdf(query: {
  orgId: string;
  actorId: string;
  statementId: string;
  orgName: string;
}): Promise<Buffer> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const statementId = requireId(query.statementId, "statementId");
  const row = (await db.execute<StatementRow>(sql`
    select s.id, s.employment_id, s.cycle_id, s.period_from::text as period_from,
           s.period_to::text as period_to, s.payload, s.file_id, s.generated_at::text as generated_at
      from hrm_comp_statements s
     where s.org_id = ${orgId} and s.id = ${statementId}`)).rows[0];
  if (!row) throw new CompensationError("NOT_FOUND", "statement is not visible in this organization");
  try {
    await requireHrmCompensationRead(db, orgId, actorId);
  } catch {
    const own = await loadOwnEmploymentIds(db, orgId, actorId);
    if (!own.includes(row.employment_id)) {
      throw new CompensationError("REFUSED", "statements read for your own employment — HR reads the rest");
    }
  }
  const payload = row.payload as Record<string, unknown>;
  const rate = payload.currentRate as { rate?: string; currency?: string } | null;
  const placement = payload.bandPlacement as { placement?: string; compaRatio?: string } | null;
  const benefits = (payload.employerPaidBenefits as Array<{ plan?: string; employer_amount?: string | null; currency?: string }>) ?? [];
  return renderPdfDocument({
    title: "Total rewards statement",
    branding: { orgName: query.orgName },
    dateRangeLabel: `${row.period_from} – ${row.period_to}`,
    generatedAt: new Date(),
    layout: { paperSize: "a4", orientation: "portrait", marginMm: 15, density: "standard" },
    summary: [
      { label: "Annual rate", value: rate ? `${rate.rate} ${rate.currency}` : "—" },
      { label: "Band placement", value: placement?.placement === "no_band" ? "No band" : (placement?.placement ?? "—") },
    ],
    groups: [
      {
        kind: "section",
        title: "Employer-paid benefits",
        columns: ["Plan", "Amount", "Currency"],
        rows: benefits.map((b) => [b.plan ?? "", b.employer_amount ?? "—", b.currency ?? ""]),
      },
    ],
  });
}

/** Store rendered PDF bytes in the File Cabinet (private comp-statements folder) and link the statement. */
export async function attachStatementPdf(query: {
  orgId: string;
  actorId: string;
  statementId: string;
  filename: string;
  bytes: Buffer;
}): Promise<StatementDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const statementId = requireId(query.statementId, "statementId");
  return withOrgTransaction(orgId, async () => {
    await requireHrmCompensationManage(db, orgId, actorId);
    const existing = (await db.execute<{ id: string }>(sql`
      select id from folders where org_id = ${orgId} and system_kind = 'hrm_comp_statements' limit 1`)).rows[0];
    let folderId = existing?.id;
    if (!folderId) {
      const created = (await db.execute<{ id: string }>(sql`
        insert into folders (org_id, name, is_system, system_kind, is_private, owner_id, created_by, updated_by, created_at, updated_at)
        values (${orgId}, 'Compensation statements', true, 'hrm_comp_statements', true, null, ${actorId}, ${actorId}, now(), now())
        returning id`)).rows[0];
      if (!created) throw new CompensationError("REFUSED", "could not create the compensation statements folder");
      folderId = created.id;
    }
    const hash = createHash("sha256").update(query.bytes).digest("hex");
    const file = (await db.execute<{ id: string }>(sql`
      insert into files (org_id, folder_id, name, extension, file_type, content_type, size_bytes,
                         storage_kind, content_hash, created_by, updated_by, created_at, updated_at)
      values (${orgId}, ${folderId}, ${query.filename}, 'pdf', 'document', 'application/pdf',
              ${query.bytes.length}, 'db', ${hash}, ${actorId}, ${actorId}, now(), now())
      returning id`)).rows[0];
    if (!file) throw new CompensationError("REFUSED", "the statement file insert matched no row — refused, never silent");
    const version = (await db.execute<{ id: string }>(sql`
      insert into file_versions (file_id, version_number, size_bytes, content_type, storage_kind, content_hash, created_by, created_at)
      values (${file.id}, 1, ${query.bytes.length}, 'application/pdf', 'db', ${hash}, ${actorId}, now())
      returning id`)).rows[0];
    if (!version) throw new CompensationError("REFUSED", "the statement file version insert matched no row — refused, never silent");
    await db.execute(sql`update files set current_version_id = ${version.id} where id = ${file.id} and org_id = ${orgId}`);
    await db.execute(sql`insert into file_blobs (version_id, bytes) values (${version.id}, ${query.bytes})`);
    const row = (await db.execute<StatementRow>(sql`
      insert into hrm_comp_statements (org_id, employment_id, cycle_id, period_from, period_to, payload, file_id, generated_by, created_by, updated_by)
      select org_id, employment_id, cycle_id, period_from, period_to, payload, ${file.id}, ${actorId}, ${actorId}, ${actorId}
        from hrm_comp_statements where org_id = ${orgId} and id = ${statementId}
      returning id, employment_id, cycle_id, period_from::text as period_from, period_to::text as period_to,
                payload, file_id, generated_at::text as generated_at`)).rows[0];
    if (!row) throw new CompensationError("NOT_FOUND", "statement is not visible in this organization");
    return toStatementDTO(row);
  });
}

/** List statements: HR sees the employment's; the person sees their own. */
export async function listStatements(query: {
  orgId: string;
  actorId: string;
  employmentId: string;
}): Promise<readonly StatementDTO[]> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const employmentId = requireId(query.employmentId, "employmentId");
  try {
    await requireHrmCompensationRead(db, orgId, actorId);
  } catch {
    const own = await loadOwnEmploymentIds(db, orgId, actorId);
    if (!own.includes(employmentId)) {
      throw new CompensationError("REFUSED", "statements read for your own employment — HR reads the rest");
    }
  }
  const rows = (await db.execute<StatementRow>(sql`
    select id, employment_id, cycle_id, period_from::text as period_from, period_to::text as period_to,
           payload, file_id, generated_at::text as generated_at
      from hrm_comp_statements
     where org_id = ${orgId} and employment_id = ${employmentId}
     order by generated_at desc`)).rows;
  return rows.map(toStatementDTO);
}
