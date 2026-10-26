import "server-only";

import { sql } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import {
  ContractorWithholdingError,
  listWithholdingDeposits,
  listWithholdingPeriods,
  type WithholdingPeriodSummary,
} from "@openbooks/engine/contractor-withholding";
import { db, withOrgTransaction } from "@openbooks/engine/platform/database";
import { can, requirePermission } from "../../../lib/authz";
import { requireFeatureEnabled } from "../../../lib/feature-gates";
import {
  withholdingEnrollments,
  type WithholdingEnrollmentOption,
} from "../../../lib/contractor-withholding";

const BASE = "/contractor-withholding";
type Tab = "periods" | "deposits" | "standings";
type DepositRow = Awaited<ReturnType<typeof listWithholdingDeposits>>[number];
type StandingRow = {
  id: string;
  entityName: string | null;
  partyName: string;
  schemeCode: string;
  bandCode: string;
  status: string;
  validFrom: string;
  validTo: string | null;
};

export interface ContractorWithholdingData {
  title: string;
  description: string;
  setupLabel: string;
  tabs: { href: string; label: string; active: boolean }[];
  canManage: boolean;
  canReadJournal: boolean;
  canSetup: boolean;
  selected: string;
  activeTab: Tab;
  enrollments: WithholdingEnrollmentOption[];
  periods: WithholdingPeriodSummary[];
  deposits: DepositRow[];
  standings: StandingRow[];
  loadFailure: string | null;
  returnId: string | null;
}

function pickString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function tabHref(tab: Tab, selected: string): string {
  const query = new URLSearchParams();
  if (selected) query.set("enrollment", selected);
  if (tab !== "periods") query.set("tab", tab);
  return query.size ? `${BASE}?${query}` : BASE;
}

export async function loadContractorWithholding(
  sp: Record<string, string | string[] | undefined>,
): Promise<ContractorWithholdingData> {
  const authz = await requirePermission("ap.read");
  await requireFeatureEnabled(authz.user.orgId, "contractorWithholding");
  const [t, enrollments] = await Promise.all([
    getTranslations("ap.withholding"),
    withholdingEnrollments(authz),
  ]);
  const canSetup = can(authz, "admin.setup.manage");
  const canStandings = canSetup && authz.allowedSubsidiaryIds === null;
  const requested = pickString(sp.enrollment);
  const enrollment = enrollments.find((row) => row.id === requested) ?? enrollments[0];
  const selected = enrollment?.id ?? "";
  const requestedTab = pickString(sp.tab);
  const activeTab: Tab =
    requestedTab === "standings" && canStandings
      ? "standings"
      : requestedTab === "deposits" && enrollment?.canDeposit
        ? "deposits"
        : "periods";
  let periods: WithholdingPeriodSummary[] = [];
  let deposits: DepositRow[] = [];
  let standings: StandingRow[] = [];
  let loadFailure: string | null = null;

  if (activeTab === "standings" && canStandings) {
    standings = await db.execute<StandingRow>(
      sql`
      select w.id, s.name as "entityName", p.display_name as "partyName", w.scheme_code as "schemeCode",
             w.band_code as "bandCode", w.status, w.valid_from::text as "validFrom", w.valid_to::text as "validTo"
        from withholding_standings w
        join parties p on p.org_id=w.org_id and p.id=w.party_id
        left join subsidiaries s on s.org_id=w.org_id and s.id=w.subsidiary_id
       where w.org_id=${authz.user.orgId}
       order by p.display_name, w.scheme_code, w.valid_from desc`,
      "objects",
    );
  } else if (enrollment) {
    try {
      if (activeTab === "periods") {
        periods = await withOrgTransaction(authz.user.orgId, () =>
          listWithholdingPeriods(db, authz.user.orgId, enrollment.id),
        );
      } else {
        deposits = await withOrgTransaction(authz.user.orgId, () =>
          listWithholdingDeposits(db, authz.user.orgId, enrollment.id),
        );
      }
    } catch (error) {
      if (!(error instanceof ContractorWithholdingError)) throw error;
      loadFailure = [error.message, error.remedy].filter(Boolean).join(" ");
    }
  }

  const tabs = [
    { href: tabHref("periods", selected), label: t("periods"), active: activeTab === "periods" },
    ...(enrollment?.canDeposit
      ? [
          {
            href: tabHref("deposits", selected),
            label: t("deposits"),
            active: activeTab === "deposits",
          },
        ]
      : []),
    ...(canStandings
      ? [
          {
            href: tabHref("standings", selected),
            label: t("standings"),
            active: activeTab === "standings",
          },
        ]
      : []),
  ];
  const returnId = pickString(sp.return) ?? null;
  return {
    title: t("title"),
    description: t("description"),
    setupLabel: t("enrollments"),
    tabs,
    canManage: can(authz, "ap.pay"),
    canReadJournal: can(authz, "gl.read"),
    canSetup,
    selected,
    activeTab,
    enrollments,
    periods,
    deposits,
    standings,
    loadFailure,
    returnId,
  };
}

const f = ref<ContractorWithholdingData>();

export function contractorWithholdingSpec(data: ContractorWithholdingData): PageSpec {
  return page({
    route: "/contractor-withholding",
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actions: [
          widget("module-home-tabs", { tabs: data.tabs, placement: "local" }),
          widget(
            "link-button",
            {
              href: "/admin/setup/withholding-enrollments",
              label: f("setupLabel"),
              variant: "outline",
            },
            f("canSetup"),
          ),
        ],
      }),
    ],
    body: [
      widgetBlock("contractor-withholding-workspace", data as unknown as Record<string, unknown>),
    ],
  });
}
