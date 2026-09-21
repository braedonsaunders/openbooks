import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { HrmConstructionError } from "./errors.ts";
import { requireHrmConstructionManage, requireHrmConstructionRead } from "../authorization.ts";
import { classificationAsOf } from "./classifications.ts";
import { resolveWage } from "./rates.ts";
import {
  LaborComplianceBuildError,
  constructionRulesFor,
  laborComplianceFilesFor,
  type LaborComplianceReportContext,
  type LaborComplianceReportRow,
} from "../../payroll/labor-compliance.ts";
import { PAYROLL_COUNTRY_PACKS, type PayrollCountryPack } from "../../payroll/packs.ts";
import {
  HRM_CERTIFIED_PAYROLL_FEATURE,
  assertConstructionFeature,
  loadOrgCountry,
  requireDate,
  requireId,
  requireText,
  type SqlExecutor,
} from "./shared.ts";

/**
 * Certified payroll (HR-13, migration 0224). generate() freezes one row
 * per worker per classification per day (hours from approved time,
 * rates from the resolver, deductions from the posted runs covering the
 * week) and renders it through the PACK's declared file builder — the
 * generic layer lists whatever the pack declares and refuses generation
 * by name when it declares none. Amend creates a new run linked to the
 * original; the rendered file is stored in the payload (download source
 * of truth) and filed in the File Cabinet under the project's system
 * folder.
 *
 * Three separately named refusals, never collapsed: the feature off, the
 * pack declaring no files, and the week with no posted run.
 */

export interface CertifiedFormat {
  readonly key: string;
  readonly label: string;
}

export interface CertifiedRun {
  readonly id: string;
  readonly projectId: string | null;
  readonly weekEnding: string;
  readonly status: string;
  readonly formatKey: string;
  readonly generatedAt: string | null;
  readonly submittedAt: string | null;
  readonly amendsRunId: string | null;
}

async function packForOrg(exec: SqlExecutor, orgId: string): Promise<PayrollCountryPack> {
  const country = await loadOrgCountry(exec, orgId);
  const pack = PAYROLL_COUNTRY_PACKS[country];
  if (!pack) {
    throw new HrmConstructionError(
      `No payroll pack is installed for country ${country} — install the org's payroll pack before generating labor-compliance files.`,
    );
  }
  return pack;
}

/** The pack's declared files for this org — empty when it declares none (the UI names the pack). */
export async function listFormats(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
): Promise<{ packName: string; formats: readonly CertifiedFormat[] }> {
  await assertConstructionFeature(exec, orgId, HRM_CERTIFIED_PAYROLL_FEATURE, "Certified payroll");
  requireId(actorId, "actorId");
  await requireHrmConstructionRead(exec, orgId, actorId);
  const pack = await packForOrg(exec, orgId);
  return {
    packName: pack.name,
    formats: laborComplianceFilesFor(pack).map((format) => ({ key: format.key, label: format.label })),
  };
}

/** Pack construction carve-outs visible to the generic surface (readers, never branches). */
export async function constructionCarveOuts(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  region?: string,
): Promise<ReturnType<typeof constructionRulesFor>> {
  await assertConstructionFeature(exec, orgId, HRM_CERTIFIED_PAYROLL_FEATURE, "Certified payroll");
  requireId(actorId, "actorId");
  await requireHrmConstructionRead(exec, orgId, actorId);
  const pack = await packForOrg(exec, orgId);
  return constructionRulesFor(pack.construction, region);
}

function weekStartOf(weekEnding: string): string {
  const [y, m, d] = weekEnding.split("-").map(Number);
  const end = new Date(Date.UTC(y!, m! - 1, d!));
  const start = new Date(end.getTime() - 6 * 86_400_000);
  return start.toISOString().slice(0, 10);
}

interface PayloadBuild {
  rows: LaborComplianceReportRow[];
  runDocumentIds: string[];
  scheduleIds: string[];
  weekStart: string;
  projectName: string | null;
  projectReference: string | null;
  orgName: string;
}

async function buildPayload(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  projectId: string,
  weekEnding: string,
): Promise<PayloadBuild> {
  const project = (
    await exec.execute<{ name: string; custom: Record<string, unknown> }>(sql`
      select name, custom from projects where org_id = ${orgId}::uuid and id = ${projectId}::uuid
    `)
  ).rows[0];
  if (!project) {
    throw new HrmConstructionError(
      `Project ${projectId} does not exist in this organization — generate the report for one of its projects.`,
    );
  }
  const weekStart = weekStartOf(weekEnding);
  const runs = (
    await exec.execute<{ documentId: string }>(sql`
      select document_id::text as "documentId" from pay_runs
       where org_id = ${orgId}::uuid and run_status = 'committed'
         and period_start <= ${weekEnding}::date and period_end >= ${weekStart}::date
       order by period_start
    `)
  ).rows;
  if (runs.length === 0) {
    throw new HrmConstructionError(
      `No posted pay run covers the week ending ${weekEnding} — post the week's pay run before generating the certified report.`,
    );
  }
  const runDocumentIds = runs.map((run) => run.documentId);
  const stubs = (
    await exec.execute<{ partyId: string; deductions: string; net: string }>(sql`
      select employee_party_id::text as "partyId",
             sum(gross - net_pay)::text as deductions, sum(net_pay)::text as net
        from pay_stubs
       where org_id = ${orgId}::uuid and pay_run_document_id = any(${`{${runDocumentIds.join(",")}}`}::uuid[])
       group by employee_party_id
    `)
  ).rows;
  const stubByParty = new Map(stubs.map((stub) => [stub.partyId, stub]));
  const days = (
    await exec.execute<{
      partyId: string;
      employmentId: string;
      displayName: string;
      workedOn: string;
      hours: string;
    }>(sql`
      select te.employee_party_id::text as "partyId", w.id::text as "employmentId",
             coalesce(p.display_name, te.employee_party_id::text) as "displayName",
             te.worked_on::text as "workedOn", sum(te.hours)::text as hours
        from time_entries te
        join worker_employments w
          on w.org_id = te.org_id and w.worker_party_id = te.employee_party_id
        left join parties p on p.org_id = te.org_id and p.id = te.employee_party_id
       where te.org_id = ${orgId}::uuid and te.project_id = ${projectId}::uuid
         and te.worked_on >= ${weekStart}::date and te.worked_on <= ${weekEnding}::date
         and te.status = 'approved'
       group by te.employee_party_id, w.id, p.display_name, te.worked_on
       order by p.display_name, te.worked_on
    `)
  ).rows;
  if (days.length === 0) {
    throw new HrmConstructionError(
      `Project ${project.name} has no approved time in the week ending ${weekEnding} — approve the timesheet before generating the certified report.`,
    );
  }
  const orgName =
    (await exec.execute<{ name: string }>(sql`select name from orgs where id = ${orgId}::uuid`)).rows[0]?.name ??
    "Organization";
  const rows: LaborComplianceReportRow[] = [];
  const scheduleIds = new Set<string>();
  for (const day of days) {
    const assignment = await classificationAsOf(exec, orgId, day.employmentId, day.workedOn);
    if (!assignment) {
      throw new HrmConstructionError(
        `Employment ${day.employmentId} has no work classification effective ${day.workedOn} — assign one before generating the certified report.`,
      );
    }
    const classification = (
      await exec.execute<{ code: string; name: string }>(sql`
        select code, name from hrm_work_classifications
         where org_id = ${orgId}::uuid and id = (
           select classification_id from hrm_employment_classifications
            where org_id = ${orgId}::uuid and employment_id = ${day.employmentId}::uuid
              and effective_from <= ${day.workedOn}::date
              and (effective_to is null or effective_to >= ${day.workedOn}::date)
            order by effective_from desc limit 1)
      `)
    ).rows[0];
    if (!classification) {
      throw new HrmConstructionError(
        `Employment ${day.employmentId} has no work classification effective ${day.workedOn} — assign one before generating the certified report.`,
      );
    }
    const wage = await resolveWage(exec, {
      orgId,
      actorId,
      employmentId: day.employmentId,
      projectId,
      workedOn: day.workedOn,
    });
    scheduleIds.add(wage.scheduleId);
    const stub = stubByParty.get(day.partyId);
    rows.push({
      employmentId: day.employmentId,
      displayName: day.displayName,
      classificationCode: classification.code,
      classificationName: classification.name,
      day: day.workedOn,
      hours: day.hours,
      baseRate: wage.base,
      fringeCash: wage.fringeCash,
      fringeCredit: wage.fringeCredit,
      deductions: stub?.deductions ?? "0.0000",
      net: stub?.net ?? "0.0000",
      rateSource: wage.source,
    });
  }
  const custom = project.custom ?? {};
  const reference = typeof custom.reference === "string" ? custom.reference : null;
  return {
    rows,
    runDocumentIds,
    scheduleIds: [...scheduleIds],
    weekStart,
    projectName: project.name,
    projectReference: reference,
    orgName,
  };
}

async function renderAndFile(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  pack: PayrollCountryPack,
  formatKey: string,
  built: PayloadBuild,
  weekEnding: string,
): Promise<{ fileId: string; filename: string; contentType: string; body: string }> {
  const format = laborComplianceFilesFor(pack).find((entry) => entry.key === formatKey);
  if (!format) {
    const offered = laborComplianceFilesFor(pack)
      .map((entry) => entry.key)
      .join(", ");
    throw new HrmConstructionError(
      `Format ${formatKey} is not declared by the ${pack.name} payroll pack${offered ? ` — use one of ${offered}` : " — it declares no labor-compliance files"}.`,
    );
  }
  const ctx: LaborComplianceReportContext = {
    orgName: built.orgName,
    projectName: built.projectName,
    projectReference: built.projectReference,
    weekEnding,
    generatedAt: new Date().toISOString(),
    rows: built.rows,
  };
  let rendered;
  try {
    rendered = format.build(ctx);
  } catch (error) {
    if (error instanceof LaborComplianceBuildError) throw new HrmConstructionError(error.message);
    throw error;
  }
  const fileId = await fileInProjectFolder(
    exec,
    orgId,
    actorId,
    built,
    rendered.filename,
    rendered.contentType,
    rendered.body,
  );
  return { fileId, filename: rendered.filename, contentType: rendered.contentType, body: rendered.body };
}

async function fileInProjectFolder(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  built: PayloadBuild,
  filename: string,
  contentType: string,
  body: string,
): Promise<string> {
  const projectId = (built as { projectId?: string }).projectId;
  let folderId: string | null = null;
  if (projectId) {
    const folder = (
      await exec.execute<{ id: string }>(sql`
        select id::text as id from folders
         where org_id = ${orgId}::uuid and record_table = 'projects' and record_id = ${projectId}::uuid
           and not is_inactive
         order by is_system desc limit 1
      `)
    ).rows[0];
    folderId = folder ? String(folder.id) : null;
    if (!folderId) {
      const created = (
        await exec.execute<{ id: string }>(sql`
          insert into folders (org_id, name, is_system, system_kind, record_table, record_id, created_by)
          values (${orgId}::uuid, 'Project files', true, 'project', 'projects', ${projectId}::uuid, ${actorId}::uuid)
          returning id::text as id
        `)
      ).rows[0];
      if (!created) {
        throw new HrmConstructionError("The project's file folder could not be created — the report was not filed.");
      }
      folderId = String(created.id);
    }
  }
  if (!folderId) {
    const fallback = (
      await exec.execute<{ id: string }>(sql`
        select id::text as id from folders
         where org_id = ${orgId}::uuid and parent_folder_id is null and not is_inactive
         order by name limit 1
      `)
    ).rows[0];
    if (!fallback) {
      throw new HrmConstructionError(
        "The organization has no file folder to hold the rendered report — create one before generating.",
      );
    }
    folderId = String(fallback.id);
  }
  const bytes = Buffer.from(body, "utf8");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const extension = filename.includes(".") ? filename.slice(filename.lastIndexOf(".") + 1) : null;
  const file = (
    await exec.execute<{ id: string }>(sql`
      insert into files (org_id, folder_id, name, extension, file_type, content_type, size_bytes,
                         storage_kind, content_hash, source_system, created_by, updated_by)
      values (${orgId}::uuid, ${folderId}::uuid, ${filename}, ${extension}, 'compliance',
              ${contentType}, ${bytes.length}, 'db', ${hash}, 'hrm-construction',
              ${actorId}::uuid, ${actorId}::uuid)
      returning id::text as id
    `)
  ).rows[0];
  if (!file) throw new HrmConstructionError("The rendered report could not be filed — no file row was written.");
  const version = (
    await exec.execute<{ id: string }>(sql`
      insert into file_versions (file_id, version_number, size_bytes, content_type, storage_kind, content_hash, created_by)
      values (${String(file.id)}::uuid, 1, ${bytes.length}, ${contentType}, 'db', ${hash}, ${actorId}::uuid)
      returning id::text as id
    `)
  ).rows[0];
  if (!version) throw new HrmConstructionError("The rendered report could not be filed — no version row was written.");
  await exec.execute(sql`
    insert into file_blobs (version_id, bytes)
    values (${String(version.id)}::uuid, ${`\\x${bytes.toString("hex")}`}::bytea)
  `);
  await exec.execute(sql`
    update files set current_version_id = ${String(version.id)}::uuid where id = ${String(file.id)}::uuid
  `);
  return String(file.id);
}

async function insertRun(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  input: {
    projectId: string;
    weekEnding: string;
    scheduleId: string | null;
    formatKey: string;
    built: PayloadBuild;
    rendered: { filename: string; contentType: string; body: string };
    fileId: string;
    amendsRunId: string | null;
  },
): Promise<CertifiedRun> {
  const payload = {
    rows: input.built.rows,
    runDocumentIds: input.built.runDocumentIds,
    weekStart: input.built.weekStart,
    rendered: input.rendered,
  };
  try {
    const created = (
      await exec.execute<{ id: string }>(sql`
        insert into hrm_certified_payroll_runs
          (org_id, project_id, week_ending, schedule_id, status, payroll_run_document_ids,
           payload, format_key, file_id, generated_at, amends_run_id, created_by, updated_by)
        values (${orgId}::uuid, ${input.projectId}::uuid, ${input.weekEnding}::date,
                ${input.scheduleId}::uuid, 'generated', ${`{${input.built.runDocumentIds.join(",")}}`}::uuid[],
                ${JSON.stringify(payload)}::jsonb, ${input.formatKey}, ${input.fileId}::uuid,
                now(), ${input.amendsRunId}::uuid, ${actorId}::uuid, ${actorId}::uuid)
        returning id::text as id
      `)
    ).rows[0];
    if (!created) throw new HrmConstructionError("The certified run was not recorded — no row was written.");
    return loadRun(exec, orgId, String(created.id));
  } catch (error) {
    if (error instanceof HrmConstructionError) throw error;
    throw new HrmConstructionError(
      `A certified run already exists for this project, week, format, and amendment link — amend the existing run instead of generating a duplicate.`,
    );
  }
}

export async function loadRun(exec: SqlExecutor, orgId: string, runId: string): Promise<CertifiedRun> {
  const row = (
    await exec.execute<{
      id: string;
      projectId: string | null;
      weekEnding: string;
      status: string;
      formatKey: string;
      generatedAt: string | null;
      submittedAt: string | null;
      amendsRunId: string | null;
    }>(sql`
      select id::text as id, project_id::text as "projectId", week_ending::text as "weekEnding",
             status, format_key as "formatKey",
             generated_at::text as "generatedAt", submitted_at::text as "submittedAt",
             amends_run_id::text as "amendsRunId"
        from hrm_certified_payroll_runs
       where org_id = ${orgId}::uuid and id = ${runId}::uuid
    `)
  ).rows[0];
  if (!row) {
    throw new HrmConstructionError(
      `Certified run ${runId} does not exist in this organization — it may belong to another org.`,
    );
  }
  return row;
}

export async function listRuns(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  projectId?: string | null,
): Promise<readonly CertifiedRun[]> {
  await assertConstructionFeature(exec, orgId, HRM_CERTIFIED_PAYROLL_FEATURE, "Certified payroll");
  requireId(actorId, "actorId");
  await requireHrmConstructionRead(exec, orgId, actorId);
  const rows = (
    await exec.execute<{
      id: string;
      projectId: string | null;
      weekEnding: string;
      status: string;
      formatKey: string;
      generatedAt: string | null;
      submittedAt: string | null;
      amendsRunId: string | null;
    }>(sql`
      select id::text as id, project_id::text as "projectId", week_ending::text as "weekEnding",
             status, format_key as "formatKey",
             generated_at::text as "generatedAt", submitted_at::text as "submittedAt",
             amends_run_id::text as "amendsRunId"
        from hrm_certified_payroll_runs
       where org_id = ${orgId}::uuid
         and (${projectId}::uuid is null or project_id = ${projectId}::uuid)
       order by week_ending desc
    `)
  ).rows;
  return rows;
}

/**
 * Generate a certified run: frozen payload, pack-rendered file, cabinet
 * artefact — one transaction, so a render refusal leaves no half-run.
 */
export async function generate(
  exec: SqlExecutor,
  input: { orgId: string; actorId: string; projectId: string; weekEnding: string; formatKey: string },
): Promise<CertifiedRun> {
  const orgId = requireId(input.orgId, "orgId");
  const actorId = requireId(input.actorId, "actorId");
  const projectId = requireId(input.projectId, "projectId");
  const weekEnding = requireDate(input.weekEnding, "weekEnding");
  const formatKey = requireText(input.formatKey, "formatKey");
  await assertConstructionFeature(exec, orgId, HRM_CERTIFIED_PAYROLL_FEATURE, "Certified payroll");
  await requireHrmConstructionManage(exec, orgId, actorId);
  const pack = await packForOrg(exec, orgId);
  if (laborComplianceFilesFor(pack).length === 0) {
    throw new HrmConstructionError(
      `The ${pack.name} payroll pack declares no labor-compliance files — generation refuses by name rather than borrowing another pack's form.`,
    );
  }
  const built = await buildPayload(exec, orgId, actorId, projectId, weekEnding);
  (built as { projectId?: string }).projectId = projectId;
  const rendered = await renderAndFile(exec, orgId, actorId, pack, formatKey, built, weekEnding);
  return insertRun(exec, orgId, actorId, {
    projectId,
    weekEnding,
    scheduleId: built.scheduleIds.length === 1 ? built.scheduleIds[0]! : null,
    formatKey,
    built,
    rendered,
    fileId: rendered.fileId,
    amendsRunId: null,
  });
}

export async function submitRun(
  exec: SqlExecutor,
  input: { orgId: string; actorId: string; runId: string },
): Promise<CertifiedRun> {
  const orgId = requireId(input.orgId, "orgId");
  requireId(input.actorId, "actorId");
  const runId = requireId(input.runId, "runId");
  await assertConstructionFeature(exec, orgId, HRM_CERTIFIED_PAYROLL_FEATURE, "Certified payroll");
  await requireHrmConstructionManage(exec, orgId, input.actorId);
  const updated = (
    await exec.execute<{ id: string }>(sql`
      update hrm_certified_payroll_runs
         set status = 'submitted', submitted_at = now(),
             updated_by = ${input.actorId}::uuid, updated_at = now()
       where org_id = ${orgId}::uuid and id = ${runId}::uuid and status = 'generated'
      returning id::text as id
    `)
  ).rows[0];
  if (!updated) {
    throw new HrmConstructionError(
      `Certified run ${runId} cannot be submitted — it does not exist here or is not generated.`,
    );
  }
  return loadRun(exec, orgId, String(updated.id));
}

/** Amend: a new run linked to the original with a freshly rebuilt payload; the original reads amended. */
export async function amendRun(
  exec: SqlExecutor,
  input: { orgId: string; actorId: string; runId: string },
): Promise<CertifiedRun> {
  const orgId = requireId(input.orgId, "orgId");
  const actorId = requireId(input.actorId, "actorId");
  const runId = requireId(input.runId, "runId");
  await assertConstructionFeature(exec, orgId, HRM_CERTIFIED_PAYROLL_FEATURE, "Certified payroll");
  await requireHrmConstructionManage(exec, orgId, actorId);
  const source = await loadRun(exec, orgId, runId);
  if (source.status !== "submitted" && source.status !== "generated") {
    throw new HrmConstructionError(
      `Certified run ${runId} is ${source.status} — only generated or submitted runs amend.`,
    );
  }
  if (!source.projectId) {
    throw new HrmConstructionError(`Certified run ${runId} names no project — amendments need a project to rebuild.`);
  }
  const pack = await packForOrg(exec, orgId);
  const built = await buildPayload(exec, orgId, actorId, source.projectId, source.weekEnding);
  (built as { projectId?: string }).projectId = source.projectId;
  const rendered = await renderAndFile(exec, orgId, actorId, pack, source.formatKey, built, source.weekEnding);
  const amended = await insertRun(exec, orgId, actorId, {
    projectId: source.projectId,
    weekEnding: source.weekEnding,
    scheduleId: null,
    formatKey: source.formatKey,
    built,
    rendered,
    fileId: rendered.fileId,
    amendsRunId: runId,
  });
  await exec.execute(sql`
    update hrm_certified_payroll_runs
       set status = 'amended', updated_by = ${actorId}::uuid, updated_at = now()
     where org_id = ${orgId}::uuid and id = ${runId}::uuid
  `);
  return amended;
}

export interface ProjectComplianceSummary {
  readonly schedules: ReadonlyArray<{ id: string; name: string; kind: string }>;
  readonly openFindings: number;
  readonly ratioBreachThisWeek: boolean;
  readonly lastRun: {
    id: string;
    weekEnding: string;
    status: string;
    formatKey: string;
  } | null;
}

/**
 * Project cockpit data contract (HR-13): the project's schedules, open
 * finding count, whether an open ratio breach flags the current week,
 * and the last certified run. Reads only — the cockpit renders this,
 * it never runs checks (checks write findings and belong to actions).
 */
export async function projectComplianceSummary(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  projectId: string,
): Promise<ProjectComplianceSummary> {
  requireId(actorId, "actorId");
  const project = requireId(projectId, "projectId");
  await assertConstructionFeature(exec, orgId, HRM_CERTIFIED_PAYROLL_FEATURE, "Certified payroll");
  await requireHrmConstructionRead(exec, orgId, actorId);
  const schedules = (
    await exec.execute<{ id: string; name: string; kind: string }>(sql`
      select id::text as id, name, kind from hrm_rate_schedules
       where org_id = ${orgId}::uuid and is_active
         and (applies_to->'project_ids' is null
              or applies_to->'project_ids' @> to_jsonb(${project}::text))
       order by name
    `)
  ).rows;
  const openFindings = (
    await exec.execute<{ n: string }>(sql`
      select count(*)::text as n from hrm_compliance_findings
       where org_id = ${orgId}::uuid and status = 'open'
         and project_id is not distinct from ${project}::uuid
    `)
  ).rows[0];
  const weekEnd = weekEndingSunday(todayIso());
  const breach = (
    await exec.execute<{ id: string }>(sql`
      select id from hrm_compliance_findings
       where org_id = ${orgId}::uuid and kind = 'ratio_breach' and status = 'open'
         and project_id is not distinct from ${project}::uuid
         and worked_on >= (${weekEnd}::date - interval '6 days') and worked_on <= ${weekEnd}::date
       limit 1
    `)
  ).rows[0];
  const lastRun = (
    await exec.execute<{
      id: string;
      weekEnding: string;
      status: string;
      formatKey: string;
    }>(sql`
      select id::text as id, week_ending::text as "weekEnding", status,
             format_key as "formatKey"
        from hrm_certified_payroll_runs
       where org_id = ${orgId}::uuid and project_id is not distinct from ${project}::uuid
       order by week_ending desc limit 1
    `)
  ).rows[0];
  return {
    schedules,
    openFindings: Number(openFindings?.n ?? 0),
    ratioBreachThisWeek: !!breach,
    lastRun: lastRun ?? null,
  };
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Sunday closing the week that holds the given day. */
function weekEndingSunday(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  const add = (7 - date.getUTCDay()) % 7;
  return new Date(date.getTime() + add * 86_400_000).toISOString().slice(0, 10);
}

/** Download the frozen rendered file — the payload's copy, never a re-render. */
export async function downloadRun(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  runId: string,
): Promise<{ filename: string; contentType: string; body: string }> {
  requireId(actorId, "actorId");
  requireId(runId, "runId");
  await assertConstructionFeature(exec, orgId, HRM_CERTIFIED_PAYROLL_FEATURE, "Certified payroll");
  await requireHrmConstructionRead(exec, orgId, actorId);
  const row = (
    await exec.execute<{ payload: { rendered?: { filename: string; contentType: string; body: string } } }>(sql`
      select payload from hrm_certified_payroll_runs
       where org_id = ${orgId}::uuid and id = ${runId}::uuid
    `)
  ).rows[0];
  const rendered = row?.payload?.rendered;
  if (!rendered) {
    throw new HrmConstructionError(
      `Certified run ${runId} has no rendered file — regenerate it before downloading.`,
    );
  }
  return rendered;
}
