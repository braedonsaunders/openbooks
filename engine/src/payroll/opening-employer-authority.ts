import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { requirePayrollFeature } from "./feature-gate.ts";
import { employeeTaxYearFenceKey, takeEmployeeTaxYearFences } from "./fences.ts";
import { payrollSubsidiaryScopeFilter, type PayrollSubsidiaryScope } from "./scope.ts";
import { PayrollError } from "./error.ts";
import { requireNativeFileReadAuthority } from "../records/file-read-authority.ts";
export type OpeningEmployerAuthorityInput = {
  orgId: string;
  actorId: string;
  openingBalanceId: string;
  subsidiaryId: string;
  expectedOpeningSha256: string;
  sourceFileId: string;
  sourceVersionId: string;
  sourceSha256: string;
  sourceReference: string;
  reason: string;
  allowedSubsidiaryIds: PayrollSubsidiaryScope;
};
/** Qualifies retained source ownership without replacing opening amounts or posted history. */
export async function qualifyOpeningEmployerAuthority(
  input: OpeningEmployerAuthorityInput,
): Promise<{ id: string; openingBalanceId: string; subsidiaryId: string; openingSha256: string }> {
  if (
    ![
      input.orgId,
      input.actorId,
      input.openingBalanceId,
      input.subsidiaryId,
      input.sourceFileId,
      input.sourceVersionId,
    ].every(isUuid) ||
    input.allowedSubsidiaryIds === undefined ||
    !/^[a-f0-9]{64}$/.test(input.sourceSha256) ||
    !/^[a-f0-9]{64}$/.test(input.expectedOpeningSha256)
  )
    throw new PayrollError(
      "Choose the native opening record, legal employer and exact source file version",
    );
  if (typeof input.sourceReference !== "string" || typeof input.reason !== "string")
    throw new PayrollError("Record the original employer evidence and a qualification reason");
  const sourceReference = input.sourceReference.trim(),
    reason = input.reason.trim();
  if (!sourceReference || sourceReference.length > 2000 || !reason || reason.length > 2000)
    throw new PayrollError(
      "Record the original employer evidence and a qualification reason within 2000 characters",
    );
  return withOrgTransaction(input.orgId, async () => {
    await requirePayrollFeature(db, input.orgId);
    if (!(await actorHasPermission(db, input.orgId, input.actorId, "payroll.run")))
      throw new PayrollError(
        "Payroll run permission is required to qualify opening employer authority",
      );
    await requireNativeFileReadAuthority(
      { orgId: input.orgId, actorId: input.actorId, fileId: input.sourceFileId },
      db,
    );
    const authority = await lockActorCommandAuthority(
      db,
      input.orgId,
      input.actorId,
      input.subsidiaryId,
      "payroll.run",
    );
    const employer = await db.execute(
      sql`select id from subsidiaries where org_id=${input.orgId} and id=${input.subsidiaryId}
    ${payrollSubsidiaryScopeFilter(sql`id`, input.allowedSubsidiaryIds)} ${payrollSubsidiaryScopeFilter(sql`id`, authority)} for share`,
      "objects",
    );
    if (employer.length !== 1)
      throw new PayrollError("The opening legal employer is outside your payroll authority");
    const opening = await db.execute<{ employeePartyId: string; taxYear: number }>(
      sql`select employee_party_id as "employeePartyId",tax_year as "taxYear"
   from payroll_opening_balances where org_id=${input.orgId} and id=${input.openingBalanceId}`,
      "objects",
    );
    if (opening.length !== 1) throw new PayrollError("The native opening record is unavailable");
    await takeEmployeeTaxYearFences(db, [
      employeeTaxYearFenceKey(input.orgId, opening[0]!.employeePartyId, opening[0]!.taxYear),
    ]);
    const employment = await db.execute(
      sql`select id from worker_employments
    where org_id=${input.orgId} and worker_party_id=${opening[0]!.employeePartyId}
      and employer_subsidiary_id=${input.subsidiaryId} limit 1 for share`,
      "objects",
    );
    if (employment.length !== 1)
      throw new PayrollError(
        "The original opening employer needs a retained native employment for this employee — qualify that employment before its opening source",
      );
    const existing = await db.execute<{
      id: string;
      openingBalanceId: string;
      subsidiaryId: string;
      openingSha256: string;
      matches: boolean;
    }>(
      sql`
   select a.id,a.opening_balance_id as "openingBalanceId",a.subsidiary_id as "subsidiaryId",a.opening_sha256 as "openingSha256",
    (a.subsidiary_id=${input.subsidiaryId} and a.source_file_id=${input.sourceFileId} and a.source_version_id=${input.sourceVersionId}
     and a.source_sha256=${input.sourceSha256} and a.source_reference=${sourceReference} and a.change_reason=${reason}
     and a.opening_snapshot=to_jsonb(b) and a.opening_sha256=${input.expectedOpeningSha256}) as matches
   from payroll_opening_employer_authorities a join payroll_opening_balances b on b.org_id=a.org_id and b.id=a.opening_balance_id
   where a.org_id=${input.orgId} and a.opening_balance_id=${input.openingBalanceId}`,
      "objects",
    );
    if (existing.length) {
      if (existing.length !== 1 || !existing[0]!.matches)
        throw new PayrollError(
          "Opening employer authority already retains different source evidence — preserve the original qualification",
        );
      const { matches: _, ...result } = existing[0]!;
      return result;
    }
    const retainedFile = await db.execute(
      sql`select v.id from files f join file_versions v on v.file_id=f.id
    where f.org_id=${input.orgId} and f.id=${input.sourceFileId} and not f.is_inactive and v.id=${input.sourceVersionId}
      and v.content_hash=${input.sourceSha256} and v.created_by=${input.actorId} for share of f,v`,
      "objects",
    );
    if (retainedFile.length !== 1)
      throw new PayrollError(
        "Select the active original Cabinet file and its exact retained version and hash",
      );
    const rows = await db.execute<{
      id: string;
      openingBalanceId: string;
      subsidiaryId: string;
      openingSha256: string;
    }>(
      sql`
   insert into payroll_opening_employer_authorities(org_id,opening_balance_id,employee_party_id,tax_year,subsidiary_id,
    source_file_id,source_version_id,source_sha256,source_reference,change_reason,opening_snapshot,opening_sha256,created_by)
   select b.org_id,b.id,b.employee_party_id,b.tax_year,${input.subsidiaryId},${input.sourceFileId},${input.sourceVersionId},
    ${input.sourceSha256},${sourceReference},${reason},to_jsonb(b),encode(public.digest(to_jsonb(b)::text,'sha256'),'hex'),${input.actorId}
   from payroll_opening_balances b where b.org_id=${input.orgId} and b.id=${input.openingBalanceId}
    and encode(public.digest(to_jsonb(b)::text,'sha256'),'hex')=${input.expectedOpeningSha256}
   returning id,opening_balance_id as "openingBalanceId",subsidiary_id as "subsidiaryId",opening_sha256 as "openingSha256"`,
      "objects",
    );
    if (rows.length !== 1)
      throw new PayrollError(
        "The opening source changed — reload the exact amounts before qualifying employer authority",
      );
    const audit = await db.execute(
      sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
   select a.org_id,'payroll_opening_employer_authorities',a.id,'insert',jsonb_build_object('after',to_jsonb(a),'reason',${reason}::text),${input.actorId}
   from payroll_opening_employer_authorities a where a.org_id=${input.orgId} and a.id=${rows[0]!.id} returning id`,
      "objects",
    );
    if (audit.length !== 1)
      throw new PayrollError("The opening employer source qualification audit was not retained");
    return rows[0]!;
  });
}

/** Returns source identity and scoped historical employer choices, never protected opening snapshots. */
export async function readOpeningEmployerContext(input: {
  orgId: string;
  actorId: string;
  employeePartyId: string;
  taxYear: number;
  sourceFileId?: string;
  allowedSubsidiaryIds: PayrollSubsidiaryScope;
}) {
  if (
    ![input.orgId, input.actorId, input.employeePartyId].every(isUuid) ||
    input.allowedSubsidiaryIds === undefined ||
    (input.sourceFileId !== undefined && !isUuid(input.sourceFileId))
  )
    throw new PayrollError("Choose a native employee opening and source file");
  const { assertTaxYear } = await import("./opening-balances.ts");
  assertTaxYear(input.taxYear);
  return withOrgTransaction(input.orgId, async () => {
    await requirePayrollFeature(db, input.orgId);
    const authority = await lockActorCommandAuthority(
      db,
      input.orgId,
      input.actorId,
      null,
      "payroll.read",
    );
    const employers = await db.execute<{ id: string; name: string }>(
      sql`select distinct employer.id,employer.name from worker_employments e
   join subsidiaries employer on employer.org_id=e.org_id and employer.id=e.employer_subsidiary_id
   where e.org_id=${input.orgId} and e.worker_party_id=${input.employeePartyId}
    ${payrollSubsidiaryScopeFilter(sql`employer.id`, input.allowedSubsidiaryIds)} ${payrollSubsidiaryScopeFilter(sql`employer.id`, authority)}
   order by employer.name,employer.id`,
      "objects",
    );
    if (!employers.length)
      throw new PayrollError(
        "The employee opening has no native employer in your payroll authority",
      );
    const rows = await db.execute<{
      id: string;
      openingSha256: string;
      authorityId: string | null;
      subsidiaryId: string | null;
      sourceReference: string | null;
    }>(
      sql`
   select b.id,encode(public.digest(to_jsonb(b)::text,'sha256'),'hex') as "openingSha256",
    a.id as "authorityId",a.subsidiary_id as "subsidiaryId",a.source_reference as "sourceReference"
   from payroll_opening_balances b left join payroll_opening_employer_authorities a on a.org_id=b.org_id and a.opening_balance_id=b.id
   where b.org_id=${input.orgId} and b.employee_party_id=${input.employeePartyId} and b.tax_year=${input.taxYear}`,
      "objects",
    );
    if (rows.length > 1) throw new PayrollError("The employee/year opening identity is ambiguous");
    const record = rows[0] ?? null;
    if (record?.subsidiaryId && !employers.some((employer) => employer.id === record.subsidiaryId))
      throw new PayrollError("The qualified opening employer is outside your payroll authority");
    if (input.sourceFileId)
      await requireNativeFileReadAuthority(
        { orgId: input.orgId, actorId: input.actorId, fileId: input.sourceFileId },
        db,
      );
    const source = input.sourceFileId
      ? ((
          await db.execute<{ id: string; versionId: string; sha256: string; name: string }>(
            sql`
   select f.id,v.id as "versionId",v.content_hash as sha256,f.name from files f
   join file_versions v on v.file_id=f.id and v.id=f.current_version_id
   where f.org_id=${input.orgId} and f.id=${input.sourceFileId} and not f.is_inactive and v.created_by=${input.actorId}`,
            "objects",
          )
        )[0] ?? null)
      : null;
    if (input.sourceFileId && (!source || !/^[a-f0-9]{64}$/.test(source.sha256)))
      throw new PayrollError(
        "Select the exact original file uploaded to Cabinet by the qualifying operator",
      );
    return { record, employers, source };
  });
}
