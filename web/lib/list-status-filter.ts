import type { FilterClause, ListViewConfig } from "@openbooks/customization";

/** Explicit toolbar choices replace the saved status predicate, keeping other filters. */
export function resolveListStatusFilter(
  view: ListViewConfig,
  raw: string | undefined,
  excluded: readonly string[] = [],
) {
  if (raw !== undefined) {
    const statuses =
      raw === "all"
        ? undefined
        : raw === "none" || raw === ""
          ? []
          : [
              ...new Set(
                raw
                  .split(",")
                  .map((value) => value.trim())
                  .filter(Boolean),
              ),
            ];
    return {
      view: { ...view, filters: view.filters.filter((filter) => filter.key !== "status") },
      statuses,
    };
  }
  if (view.filters.some((filter) => filter.key === "status") || excluded.length === 0)
    return { view, statuses: undefined };
  return {
    view: {
      ...view,
      filters: [
        ...view.filters,
        { key: "status", operator: "not_in", value: [...excluded] } satisfies FilterClause,
      ],
    },
    statuses: undefined,
  };
}

/** Resolve the checks from the same predicates used by the list query. */
export function selectedListStatuses(
  values: readonly string[],
  filters: readonly FilterClause[],
  statuses?: readonly string[],
) {
  if (statuses !== undefined) return values.filter((value) => statuses.includes(value));
  return values.filter((value) =>
    filters
      .filter((filter) => filter.key === "status")
      .every((filter) => {
        const choices = Array.isArray(filter.value)
          ? filter.value.map(String)
          : [String(filter.value ?? "")];
        switch (filter.operator) {
          case "eq":
            return value === choices[0];
          case "ne":
            return value !== choices[0];
          case "in":
            return choices.includes(value);
          case "not_in":
            return !choices.includes(value);
          default:
            return false;
        }
      }),
  );
}
