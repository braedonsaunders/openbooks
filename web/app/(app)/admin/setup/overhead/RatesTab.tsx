import {
  SETUP_ENTITY_BY_KEY,
  OVERHEAD_RATE_KINDS,
} from "../../../../../lib/setup/registry";
import { SetupEntitySection } from "../[entity]/SetupEntitySection";
import { getMoneyFormatter } from "@/lib/money-server";
import { formatDecimal } from "@/lib/money-format";

/** Published rates use the same registry, pagination and drawer as other setup lists. */
export async function RatesTab({
  orgId,
  searchParams,
}: {
  orgId: string;
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const { money, locale } = await getMoneyFormatter(orgId);
  const entity = SETUP_ENTITY_BY_KEY.get("overhead-rates")!;
  return (
    <SetupEntitySection
      entity={{
        ...entity,
        columns: [
          { key: "departmentId", kind: "ref", ref: "departments" },
          { key: "rateKind", kind: "badge", options: OVERHEAD_RATE_KINDS },
          ...entity.columns.filter(
            (column) => !["departmentId", "category"].includes(column.key),
          ),
        ],
      }}
      orgId={orgId}
      searchParams={searchParams}
      basePath="/admin/setup/overhead"
      canManage
      renderColumn={(column, row) => {
        if (column.key !== "ratePercent") return undefined;
        if (row.rate_percent == null) return "—";
        const value = String(row.rate_percent);
        return row.rate_kind === "percent"
          ? `${formatDecimal(locale, value, { maximumFractionDigits: 2 })}%`
          : `${money(value)}/hr`;
      }}
    />
  );
}
