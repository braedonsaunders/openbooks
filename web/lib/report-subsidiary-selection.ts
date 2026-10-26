import { isUuid } from "@openbooks/engine/platform/identifiers";

export class ReportSubsidiarySelectionError extends Error {
  readonly status = 404;
  readonly code = "report-subsidiary-unavailable";
  readonly remedy = "Choose a subsidiary available in the report filter.";

  constructor() {
    super("The selected report subsidiary is unavailable.");
    this.name = "ReportSubsidiarySelectionError";
  }
}

/** Only an omitted filter may select the default reporting entity. */
export function reportSubsidiaryParam(value: string | null | undefined): string | undefined {
  if (value == null) return undefined;
  if (!isUuid(value)) throw new ReportSubsidiarySelectionError();
  return value.toLowerCase();
}

export function selectReportSubsidiary<
  T extends {
    id: string;
    parentId: string | null;
    isActive: boolean;
    isElimination: boolean;
  },
>(
  requested: string | undefined,
  all: readonly T[],
  allowed: ReadonlySet<string> | null,
): { options: T[]; node: T | undefined } {
  const id = reportSubsidiaryParam(requested);
  const options = all.filter(
    (row) => row.isActive && !row.isElimination && (allowed === null || allowed.has(row.id)),
  );
  if (id !== undefined) {
    const node = options.find((row) => row.id === id);
    if (!node) throw new ReportSubsidiarySelectionError();
    return { options, node };
  }
  return {
    options,
    node:
      (allowed === null ? options.find((row) => row.parentId === null) : undefined) ?? options[0],
  };
}
