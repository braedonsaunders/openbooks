import "server-only";
import {
  yearEndFiling,
  type PayrollFilingRevision,
} from "@openbooks/engine/payroll/filing-registry";
import { orgYearEndFilings } from "@openbooks/engine/payroll/yearend";
import {
  recordFilingIssue,
  type RecordFilingIssueResult,
} from "@openbooks/engine/payroll/yearend-amendments";
import type { Authz } from "../authz";
import {
  FilingScopeDenied,
  guardPayrollFilingData,
  guardPayrollFilingRowIds,
} from "./subsidiary-scope";

export interface PayrollFilingIssueRequest {
  country: string;
  filing: string;
  year: number;
  revision: PayrollFilingRevision;
  rowIds?: string[];
  params?: Record<string, string>;
  note?: string;
  reason?: string;
}

async function requireFilingScope(response: Response | null): Promise<void> {
  if (response) throw new FilingScopeDenied(response);
}

/** Pack registry selection, scope checks and the persisted issue share one path. */
export async function recordPayrollFilingIssue(
  gate: Authz,
  input: PayrollFilingIssueRequest,
): Promise<RecordFilingIssueResult> {
  const { country, filing, year, revision } = input;
  if (revision === "original") {
    const declared = yearEndFiling(country, filing);
    if (declared.originalIssueRowIds) {
      const selected = await declared.originalIssueRowIds(input.params ?? {}, gate.user.orgId);
      await requireFilingScope(
        await guardPayrollFilingRowIds(gate, country, filing, [...selected], year),
      );
    } else {
      const section = (await orgYearEndFilings(gate.user.orgId, year)).find(
        (candidate) => candidate.country === country && candidate.key === filing,
      );
      if (section)
        await requireFilingScope(
          await guardPayrollFilingData(gate, country, filing, section.data, year),
        );
    }
  } else {
    await requireFilingScope(
      await guardPayrollFilingRowIds(gate, country, filing, input.rowIds ?? [], year),
    );
  }

  const authorizeRowIds = async (rowIds: readonly string[]) => {
    await requireFilingScope(
      await guardPayrollFilingRowIds(gate, country, filing, [...rowIds], year),
    );
  };
  return recordFilingIssue({
    orgId: gate.user.orgId,
    actorId: gate.user.id,
    country,
    filingKey: filing,
    taxYear: year,
    revision,
    ...(revision === "original" ? { params: input.params } : {}),
    rowIds: input.rowIds,
    scope: gate.allowedSubsidiaryIds ?? undefined,
    authorizeRowIds,
    note: revision === "cancelled" ? input.reason : input.note?.trim() || null,
    ...(revision === "cancelled" ? { reason: input.reason } : {}),
  });
}

export { FilingScopeDenied };
