import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { canonicalJson } from "../../platform/canonical-json.ts";
import { db, withOrgTransaction } from "../../platform/db.ts";
import { isUuid } from "../../platform/uuid.ts";
import { lockActorCommandAuthority } from "../../organization/actor-command-authority.ts";
import { actorHasPermission } from "../../organization/actor-permissions.ts";
import { requireNativeFileReadAuthority } from "../../records/file-read-authority.ts";
import { requirePayrollFeature } from "../feature-gate.ts";
import { employeeTaxYearFenceKey, takeEmployeeTaxYearFences } from "../fences.ts";
import { payrollSubsidiaryScopeFilter, type PayrollSubsidiaryScope } from "../scope.ts";
import { PayrollError } from "../error.ts";
import { takeOpeningSourceYearFence } from "../../organization/payroll-source-fence.ts";
import {
  currentOpeningLevySourceSql,
  requireUnconsumedOpeningLevySource,
} from "../opening-levy-source-correction-authority.ts";
import { readEmployeeOpeningLevySources } from "../opening-levy-source-reader.ts";
import {
  canonicalCanadianOpeningReportingAllocations,
  openingReportingAllocationChildren,
  type CanadianOpeningReportingAllocation,
} from "./opening-reporting-source.ts";
import { readCanadianOpeningReportingCatalogue } from "./opening-reporting-catalogue.ts";
import { readEmployeeCanadianOpeningReportingSource } from "./opening-reporting-reader.ts";

export type CanadianOpeningReportingSourceInput = {
  orgId: string;
  actorId: string;
  openingBalanceId: string;
  requestId: string;
  expectedLevyAuthorityId: string;
  expectedLevyAllocationSha256: string;
  expectedOpeningSha256: string;
  expectedOpeningChildrenSha256: string;
  sourceFileId: string;
  sourceVersionId: string;
  sourceSha256: string;
  sourceReference: string;
  allocations: readonly CanadianOpeningReportingAllocation[];
  reason: string;
  allowedSubsidiaryIds: PayrollSubsidiaryScope;
};
export type CanadianOpeningReportingSourceResult = {
  id: string;
  openingBalanceId: string;
  levyAuthorityId: string;
  subsidiaryId: string;
  allocationSha256: string;
};

function validateInput(input: CanadianOpeningReportingSourceInput): void {
  if (
    ![
      input.orgId,
      input.actorId,
      input.openingBalanceId,
      input.requestId,
      input.expectedLevyAuthorityId,
      input.sourceFileId,
      input.sourceVersionId,
    ].every(isUuid) ||
    ![
      input.expectedLevyAllocationSha256,
      input.expectedOpeningSha256,
      input.expectedOpeningChildrenSha256,
      input.sourceSha256,
    ].every((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) ||
    input.allowedSubsidiaryIds === undefined
  ) {
    throw new PayrollError(
      "Reload the native original opening, exact current levy certificate and original Cabinet source",
    );
  }
  if (
    [input.reason, input.sourceReference].some(
      (value) => typeof value !== "string" || !value.trim() || value.trim().length > 2000,
    )
  ) {
    throw new PayrollError(
      "Record the original reporting source reference and reason, each within 2000 characters",
    );
  }
}

/** Initial reporting qualification requires payroll.run; replacing its levy parent is a separate payroll.manage command. */
export async function qualifyCanadianOpeningReportingSource(
  input: CanadianOpeningReportingSourceInput,
): Promise<CanadianOpeningReportingSourceResult> {
  validateInput(input);
  return withOrgTransaction(input.orgId, async () => {
    await requirePayrollFeature(db, input.orgId);
    if (!(await actorHasPermission(db, input.orgId, input.actorId, "payroll.run"))) {
      throw new PayrollError(
        "Payroll run permission is required to qualify original Canadian reporting history",
      );
    }
    const initial = await db.execute<{ employeePartyId: string; taxYear: number }>(
      sql`
      select employee_party_id as "employeePartyId",tax_year as "taxYear" from payroll_opening_balances
       where org_id=${input.orgId} and id=${input.openingBalanceId}
    `,
      "objects",
    );
    if (initial.length !== 1) throw new PayrollError("The native original opening is unavailable");
    const identity = initial[0]!;
    await takeOpeningSourceYearFence(db, input.orgId, identity.taxYear);
    const commandScope = await lockActorCommandAuthority(
      db,
      input.orgId,
      input.actorId,
      null,
      "payroll.run",
    );
    await takeEmployeeTaxYearFences(db, [
      employeeTaxYearFenceKey(input.orgId, identity.employeePartyId, identity.taxYear),
    ]);
    const locked = await db.execute<{ employeePartyId: string; taxYear: number }>(
      sql`
      select employee_party_id as "employeePartyId",tax_year as "taxYear" from payroll_opening_balances
       where org_id=${input.orgId} and id=${input.openingBalanceId} for update
    `,
      "objects",
    );
    if (
      locked.length !== 1 ||
      locked[0]!.employeePartyId !== identity.employeePartyId ||
      locked[0]!.taxYear !== identity.taxYear
    ) {
      throw new PayrollError("The original opening identity changed; reload its reporting source");
    }
    const source = await readEmployeeOpeningLevySources(db, { orgId: input.orgId, ...identity });
    if (
      !source.authority ||
      !source.facts ||
      source.facts.originalCountry !== "CA" ||
      source.facts.originalCurrency !== "CAD" ||
      !source.openingSnapshot ||
      !source.openingChildren ||
      source.authority.openingBalanceId !== input.openingBalanceId ||
      source.authority.authorityId !== input.expectedLevyAuthorityId ||
      source.authority.openingSha256 !== input.expectedOpeningSha256
    ) {
      throw new PayrollError(
        "Resolve the exact current Canadian CAD original levy certificate before qualifying reporting allocations",
      );
    }
    const parent = await db.execute<{
      levyAllocationSha256: string;
      openingChildrenSha256: string;
      employerSourceFileId: string;
    }>(
      sql`
      select h.allocation_sha256 as "levyAllocationSha256",h.opening_children_sha256 as "openingChildrenSha256",
        e.source_file_id as "employerSourceFileId"
       from payroll_opening_levy_source_authorities h
       join payroll_opening_employer_authorities e on e.org_id=h.org_id and e.id=h.employer_authority_id
       where h.org_id=${input.orgId} and h.id=${input.expectedLevyAuthorityId} and ${currentOpeningLevySourceSql("h")}
       for share of h,e
    `,
      "objects",
    );
    if (
      parent.length !== 1 ||
      parent[0]!.levyAllocationSha256 !== input.expectedLevyAllocationSha256 ||
      parent[0]!.openingChildrenSha256 !== input.expectedOpeningChildrenSha256
    ) {
      throw new PayrollError(
        "The current levy allocation or original child snapshot changed; reload before qualifying reporting history",
      );
    }
    const scoped = await db.execute(
      sql`select id from subsidiaries
      where org_id=${input.orgId} and id=${source.authority.subsidiaryId}
        ${payrollSubsidiaryScopeFilter(sql`id`, input.allowedSubsidiaryIds)}
        ${payrollSubsidiaryScopeFilter(sql`id`, commandScope)} for share`,
      "objects",
    );
    if (scoped.length !== 1)
      throw new PayrollError(
        "The source-qualified original legal employer is outside your payroll authority",
      );
    for (const fileId of new Set([
      source.authority.sourceFileId,
      parent[0]!.employerSourceFileId,
      input.sourceFileId,
    ])) {
      await requireNativeFileReadAuthority(
        { orgId: input.orgId, actorId: input.actorId, fileId },
        db,
      );
    }
    const catalogue = await readCanadianOpeningReportingCatalogue(db, input.orgId);
    const annualAmounts: Record<string, string> = {};
    for (const field of catalogue.annualFields) {
      const value = source.openingSnapshot[field.column];
      if (typeof value !== "string")
        throw new PayrollError(
          `The original ${field.column} is unavailable as an exact native decimal`,
        );
      annualAmounts[field.column] = value;
    }
    const allocations = canonicalCanadianOpeningReportingAllocations(
      {
        orgId: input.orgId,
        subsidiaryId: source.authority.subsidiaryId,
        originalCountry: source.facts.originalCountry,
        originalCurrency: source.facts.originalCurrency,
        coverageStart: source.facts.coverageStart,
        coverageEnd: source.facts.coverageEnd,
        annualAmounts,
        children: source.openingChildren,
      },
      input.allocations,
      catalogue,
    );
    const reason = input.reason.trim(),
      sourceReference = input.sourceReference.trim();
    const requestSha256 = createHash("sha256")
      .update(
        canonicalJson({
          version: 1,
          orgId: input.orgId,
          actorId: input.actorId,
          openingBalanceId: input.openingBalanceId,
          requestId: input.requestId,
          expectedLevyAuthorityId: input.expectedLevyAuthorityId,
          expectedLevyAllocationSha256: input.expectedLevyAllocationSha256,
          expectedOpeningSha256: input.expectedOpeningSha256,
          expectedOpeningChildrenSha256: input.expectedOpeningChildrenSha256,
          sourceFileId: input.sourceFileId,
          sourceVersionId: input.sourceVersionId,
          sourceSha256: input.sourceSha256,
          sourceReference,
          allocations,
          reason,
        }),
      )
      .digest("hex");
    const prior = await db.execute<CanadianOpeningReportingSourceResult & { matches: boolean }>(
      sql`
      select id,opening_balance_id as "openingBalanceId",levy_authority_id as "levyAuthorityId",subsidiary_id as "subsidiaryId",
        allocation_sha256 as "allocationSha256",
        (request_id=${input.requestId} and request_sha256=${requestSha256} and created_by=${input.actorId}
          and levy_authority_id=${input.expectedLevyAuthorityId} and sealed) as matches
       from payroll_ca_opening_reporting_authorities where org_id=${input.orgId}
        and (request_id=${input.requestId} or levy_authority_id=${input.expectedLevyAuthorityId}) for share
    `,
      "objects",
    );
    if (prior.length) {
      if (prior.length !== 1 || !prior[0]!.matches)
        throw new PayrollError(
          "This original reporting certificate or request already preserves different evidence; reload its retained result",
        );
      const resolved = await readEmployeeCanadianOpeningReportingSource(db, {
        orgId: input.orgId,
        ...identity,
        subsidiaryId: source.authority.subsidiaryId,
      });
      if (resolved.authority?.id !== prior[0]!.id)
        throw new PayrollError("The retained reporting certificate is no longer current");
      const { matches: _matches, ...result } = prior[0]!;
      return result;
    }
    const file = await db.execute(
      sql`select v.id from files f join file_versions v on v.file_id=f.id
      where f.org_id=${input.orgId} and f.id=${input.sourceFileId} and not f.is_inactive
        and f.current_version_id=${input.sourceVersionId} and v.id=${input.sourceVersionId}
        and v.content_hash=${input.sourceSha256} and v.created_by=${input.actorId} for share of f,v`,
      "objects",
    );
    if (file.length !== 1)
      throw new PayrollError(
        "Select the current exact original Cabinet version uploaded by the qualifying operator",
      );
    await requireUnconsumedOpeningLevySource(db, {
      orgId: input.orgId,
      taxYear: identity.taxYear,
      subsidiaryId: source.authority.subsidiaryId,
      employeePartyId: identity.employeePartyId,
      openingBalanceId: input.openingBalanceId,
      authorityId: input.expectedLevyAuthorityId,
    });
    const created = await db.execute<{ id: string }>(
      sql`
      insert into payroll_ca_opening_reporting_authorities
       (org_id,opening_balance_id,levy_authority_id,employer_authority_id,levy_allocation_sha256,
        employee_party_id,tax_year,subsidiary_id,original_country,original_currency,coverage_start,coverage_end,
        source_file_id,source_version_id,source_sha256,source_reference,opening_sha256,opening_snapshot,
        opening_children_sha256,opening_children_snapshot,annual_amounts,allocation_snapshot,allocation_sha256,
        request_id,request_sha256,change_reason,sealed,created_by)
      select ${input.orgId},b.id,${input.expectedLevyAuthorityId},${source.authority.employerAuthorityId},${input.expectedLevyAllocationSha256},
        b.employee_party_id,b.tax_year,${source.authority.subsidiaryId},'CA','CAD',${source.facts.coverageStart}::date,${source.facts.coverageEnd}::date,
        ${input.sourceFileId},${input.sourceVersionId},${input.sourceSha256},${sourceReference},${input.expectedOpeningSha256},to_jsonb(b),
        ${input.expectedOpeningChildrenSha256},public.payroll_opening_source_children(b.org_id,b.id,b.employee_party_id,b.tax_year),
        ${JSON.stringify(annualAmounts)}::jsonb,'[]'::jsonb,repeat('0',64),${input.requestId},${requestSha256},${reason},false,${input.actorId}
       from payroll_opening_balances b where b.org_id=${input.orgId} and b.id=${input.openingBalanceId} returning id
    `,
      "objects",
    );
    if (created.length !== 1)
      throw new PayrollError("The original Canadian reporting authority was not saved");
    const id = created[0]!.id;
    for (const allocation of allocations) {
      const saved = await db.execute(
        sql`insert into payroll_ca_opening_reporting_allocations
        (org_id,authority_id,filing_account_id,province,source_ordinal,first_covered_pay_date,annual_amounts,reportable_bases,children,created_by)
        values (${input.orgId},${id},${allocation.filingAccountId},${allocation.province},${allocation.sourceOrdinal},
          ${allocation.firstCoveredPayDate}::date,${JSON.stringify(allocation.annualAmounts)}::jsonb,${JSON.stringify(allocation.reportableBases)}::jsonb,${JSON.stringify(allocation.children)}::jsonb,${input.actorId}) returning id`,
        "objects",
      );
      if (saved.length !== 1)
        throw new PayrollError("An exact original RP/province reporting slice was not saved");
    }
    const sealed = await db.execute<{ allocationSha256: string }>(
      sql`update payroll_ca_opening_reporting_authorities h
      set allocation_snapshot=public.payroll_ca_opening_reporting_allocations_snapshot(h.org_id,h.id),
        allocation_sha256=encode(public.digest(public.payroll_ca_opening_reporting_allocations_snapshot(h.org_id,h.id)::text,'sha256'),'hex'),sealed=true
      where h.org_id=${input.orgId} and h.id=${id} and not h.sealed returning allocation_sha256 as "allocationSha256"`,
      "objects",
    );
    if (sealed.length !== 1)
      throw new PayrollError("The original reporting allocations could not be sealed");
    const audit = await db.execute(
      sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
      select h.org_id,'payroll_ca_opening_reporting_authorities',h.id,'insert',
        jsonb_build_object('before',null,'after',to_jsonb(h),'allocations',h.allocation_snapshot,'reason',h.change_reason,
          'requestId',h.request_id,'requestSha256',h.request_sha256),${input.actorId}
       from payroll_ca_opening_reporting_authorities h where h.org_id=${input.orgId} and h.id=${id} returning id`,
      "objects",
    );
    if (audit.length !== 1)
      throw new PayrollError("The original Canadian reporting source audit was not retained");
    const resolved = await readEmployeeCanadianOpeningReportingSource(db, {
      orgId: input.orgId,
      ...identity,
      subsidiaryId: source.authority.subsidiaryId,
    });
    if (
      resolved.authority?.id !== id ||
      resolved.authority.allocationSha256 !== sealed[0]!.allocationSha256
    ) {
      throw new PayrollError(
        "The saved original reporting source did not resolve through its native read path",
      );
    }
    return {
      id,
      openingBalanceId: input.openingBalanceId,
      levyAuthorityId: input.expectedLevyAuthorityId,
      subsidiaryId: source.authority.subsidiaryId,
      allocationSha256: sealed[0]!.allocationSha256,
    };
  });
}

export async function readCanadianOpeningReportingSourceContext(input: {
  orgId: string;
  actorId: string;
  employeePartyId: string;
  taxYear: number;
  sourceFileId?: string;
  allowedSubsidiaryIds: PayrollSubsidiaryScope;
}) {
  if (
    ![input.orgId, input.actorId, input.employeePartyId].every(isUuid) ||
    !Number.isInteger(input.taxYear) ||
    input.allowedSubsidiaryIds === undefined ||
    (input.sourceFileId !== undefined && !isUuid(input.sourceFileId))
  ) {
    throw new PayrollError("Choose a native employee opening and tax year");
  }
  const { assertTaxYear } = await import("../opening-balances.ts");
  assertTaxYear(input.taxYear);
  return withOrgTransaction(input.orgId, async () => {
    await requirePayrollFeature(db, input.orgId);
    await takeOpeningSourceYearFence(db, input.orgId, input.taxYear);
    const scope = await lockActorCommandAuthority(
      db,
      input.orgId,
      input.actorId,
      null,
      "payroll.read",
    );
    const original = await readEmployeeOpeningLevySources(db, input);
    if (
      !original.authority ||
      !original.facts ||
      !original.openingChildren ||
      original.facts.originalCountry !== "CA"
    ) {
      throw new PayrollError(
        "Qualify the original Canadian opening legal employer and levy source before opening its reporting allocations",
      );
    }
    const scoped = await db.execute(
      sql`select id from subsidiaries where org_id=${input.orgId} and id=${original.authority.subsidiaryId}
      ${payrollSubsidiaryScopeFilter(sql`id`, input.allowedSubsidiaryIds)} ${payrollSubsidiaryScopeFilter(sql`id`, scope)} for share`,
      "objects",
    );
    if (scoped.length !== 1)
      throw new PayrollError(
        "The original opening legal employer is outside your payroll authority",
      );
    await requireNativeFileReadAuthority(
      { orgId: input.orgId, actorId: input.actorId, fileId: original.authority.sourceFileId },
      db,
    );
    const parent = await db.execute<{
      levyAllocationSha256: string;
      openingChildrenSha256: string;
      employerSourceFileId: string;
    }>(
      sql`
      select h.allocation_sha256 as "levyAllocationSha256",h.opening_children_sha256 as "openingChildrenSha256",e.source_file_id as "employerSourceFileId"
      from payroll_opening_levy_source_authorities h join payroll_opening_employer_authorities e on e.org_id=h.org_id and e.id=h.employer_authority_id
      where h.org_id=${input.orgId} and h.id=${original.authority.authorityId} and ${currentOpeningLevySourceSql("h")} for share of h,e`,
      "objects",
    );
    if (parent.length !== 1)
      throw new PayrollError("The current original levy reporting parent is unavailable");
    await requireNativeFileReadAuthority(
      { orgId: input.orgId, actorId: input.actorId, fileId: parent[0]!.employerSourceFileId },
      db,
    );
    const retained = await db.execute<{ sourceFileId: string }>(
      sql`select source_file_id as "sourceFileId" from payroll_ca_opening_reporting_authorities
      where org_id=${input.orgId} and levy_authority_id=${original.authority.authorityId} for share`,
      "objects",
    );
    let reporting = null;
    if (retained.length) {
      reporting = await readEmployeeCanadianOpeningReportingSource(db, input);
      if (reporting.authority)
        await requireNativeFileReadAuthority(
          { orgId: input.orgId, actorId: input.actorId, fileId: reporting.authority.sourceFileId },
          db,
        );
    }
    const catalogue = await readCanadianOpeningReportingCatalogue(db, input.orgId);
    let selectedSource: { id: string; versionId: string; sha256: string; name: string } | null =
      null;
    if (input.sourceFileId) {
      await requireNativeFileReadAuthority(
        { orgId: input.orgId, actorId: input.actorId, fileId: input.sourceFileId },
        db,
      );
      selectedSource =
        (
          await db.execute<{ id: string; versionId: string; sha256: string; name: string }>(
            sql`
        select f.id,v.id as "versionId",v.content_hash as sha256,f.name from files f join file_versions v on v.file_id=f.id and v.id=f.current_version_id
         where f.org_id=${input.orgId} and f.id=${input.sourceFileId} and not f.is_inactive and v.created_by=${input.actorId} for share of f,v`,
            "objects",
          )
        )[0] ?? null;
      if (!selectedSource || !/^[a-f0-9]{64}$/.test(selectedSource.sha256))
        throw new PayrollError(
          "Select the current original source version uploaded to Cabinet by this operator",
        );
    }
    const annualAmounts: Record<string, string> = {};
    for (const field of catalogue.annualFields) {
      const value = original.openingSnapshot?.[field.column];
      if (typeof value !== "string")
        throw new PayrollError(
          "The original annual opening amounts are unavailable as exact decimals",
        );
      annualAmounts[field.column] = value;
    }
    return {
      original: {
        ...original.authority,
        ...original.facts,
        ...parent[0],
        employeePartyId: input.employeePartyId,
        taxYear: input.taxYear,
        annualAmounts,
        children: openingReportingAllocationChildren(original.openingChildren),
      },
      reporting: reporting?.authority ?? null,
      allocations: reporting?.allocations ?? [],
      filingAccounts: catalogue.filingAccounts.filter(
        (row) =>
          row.country === "CA" &&
          row.programType === "ca_rp" &&
          row.subsidiaryId === original.authority!.subsidiaryId,
      ),
      selectedSource,
    };
  });
}
