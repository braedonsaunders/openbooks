import "server-only";

import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { sql } from "drizzle-orm";
import {
  grid,
  page,
  pageHeader,
  panel,
  ref,
  statTile,
  widget,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { POINT_IN_TIME_PERIOD_PRESETS } from "@openbooks/reports";
import {
  CONSIDERATION_ACCOUNT_TYPES,
  EquityError,
  listCompensationRuns,
  listEquityEntities,
  listInterestRuns,
  listRestrictedReleases,
  listSecurities,
  listStakeholders,
  loadCapTableView,
  loadEquityOverview,
  locateEquityAction,
  pendingEquityActions,
  loadSecurityDetail,
  loadStructure,
  equityRunCatchUp,
  nextEquityRunPeriod,
  previewCompensationRun,
  previewInterestRun,
  runEntityWaterfallScenario,
  type CapTable,
  type CompensationPreview,
  type CompensationRunRow,
  type EquityAttention,
  type EquityOverview,
  type InterestPreview,
  type InterestRunRow,
  type PendingRequest,
  type RestrictedReleaseRow,
  type SecurityDetail,
  type SecurityKind,
  type SecurityRow,
  type StructureView,
  type WaterfallScenario,
} from "@openbooks/engine/equity";
import { cmp } from "@openbooks/engine/money/money";
import { normalizeDecimal, roundMoney } from "@openbooks/engine/money";
import { db, memoizedRead, withReadMemo } from "@openbooks/engine/platform/database";
import { businessToday } from "@openbooks/engine/platform/business-date";
import { canonicalPeriodLabel, periodDisplayLabel } from "@openbooks/engine/periods/period-policy";
import { APPROVALS_HOME_HREF } from "@openbooks/engine/navigation/approvals-home";
import { can, requirePermission } from "../../../lib/authz";
import { requireFeatureEnabled } from "../../../lib/feature-gates";
import { isUuid, pickString } from "../../../lib/list-params";
import { equityHref, parseEquityListSort, type EquityListSort } from "../../../lib/equity-url";
import { perShareFormatOptions } from "../../../lib/equity-price";
import { subsidiaryVisibleFilter } from "../../../lib/subsidiaries";
import { builtInReportDefinitionIds } from "../../../lib/custom-reports";
import { resolvePeriod } from "../../../lib/periods";
import { ownershipSliceColor } from "../../../lib/equity-colors";
import { getMoneyFormatter } from "../../../lib/money-server";
import { formatCivilDate, formatExactPercent } from "../../../lib/format";
import { additiveRounding } from "../../../lib/additive-rounding";
import { readerRefusal } from "../../../lib/reader-refusal";
import {
  capTableFilters,
  type CapTableDimension,
  type CapTableInstrument,
} from "../../../lib/equity-cap-table";
import { defaultExitAnchor, exitPresets } from "../../../lib/equity-waterfall";
import type { DirectoryItem } from "../../../components/module-home/ui";
import type { AttentionItem } from "../purchasing/sections";

/**
 * Equity & cap table, one legal entity at a time.
 *
 * The overview comes first: the capitalization, how it divides, the latest
 * priced round, the money raised, the year's stock compensation, the work
 * needing attention and the latest activity. The working views follow as
 * URL views of the same route, placed in the shell's local navigation: the
 * cap table (by class or holder, filtered by instrument), the securities
 * register with its drawer, financing rounds with the round modeller, the
 * exit waterfall, and the periodic stock compensation and note interest
 * runs; share classes, plans and stakeholders sit one step away in More.
 * The legal entity and the as-of date travel in the URL. Every read checks
 * equity.read and the reader's reach to the legal entity in the engine;
 * every command does the same for its own duty. Governed actions an Equity
 * action Flow holds for approval are listed with the views they concern
 * until decided in the Inbox; `?request=<id>` (the Flow's link) opens the
 * view an action request concerns.
 */

export const EQUITY_BASE = "/equity";
export const EQUITY_VIEWS = [
  "overview",
  "captable",
  "securities",
  "rounds",
  "waterfall",
  "compensation",
  "classes",
  "plans",
  "stakeholders",
] as const;
export type EquityView = (typeof EQUITY_VIEWS)[number];
const KINDS: readonly SecurityKind[] = ["share", "option", "rsu", "warrant", "safe", "note"];
const STATUSES = [
  "outstanding",
  "exercised",
  "settled",
  "converted",
  "transferred",
  "forfeited",
  "expired",
  "cancelled",
  "repurchased",
  "repaid",
  "void",
] as const;
export const NEW_RECORD_KINDS = ["security", "class", "plan", "round", "stakeholder"] as const;
export type NewRecordKind = (typeof NEW_RECORD_KINDS)[number];
export type RunKind = "compensation" | "interest";

/** The one primary New action of each view, labelled with the record it creates. */
export const VIEW_NEW_ACTION: Record<EquityView, NewRecordKind | null> = {
  overview: "security",
  captable: "security",
  securities: "security",
  rounds: "round",
  waterfall: null,
  compensation: null,
  classes: "class",
  plans: "plan",
  stakeholders: "stakeholder",
};

export interface Option {
  value: string;
  label: string;
}

export interface EquityContext {
  subsidiaryId: string;
  currency: string;
  asOf: string;
  canManage: boolean;
  /** The signed-in user: the requester of a pending action may withdraw it. */
  actorId: string;
  /** Governed actions of the legal entity awaiting a Flow decision. */
  pending: PendingRequest[];
  /** The list's page, search and sort from the URL, so a reload or a shared link reopens them. */
  list: { page: number; query: string } & EquityListSort;
  /** The current URL parameters, so in-page links keep the entity, the date and the filters. */
  params: Record<string, string | string[] | undefined>;
}

/** The native as-of control's state: a point-in-time preset, or a custom date. */
export interface AsOfControl {
  defaultPeriod: string;
  periodPresets: string[];
}

export interface CapTableViewData {
  context: EquityContext;
  asOfControl: AsOfControl;
  dimension: CapTableDimension;
  instrument: CapTableInstrument;
  /** The table's search, in the URL so the export applies it too. */
  query: string;
  table: CapTable;
  parties: Record<string, string>;
  hasAccountPolicy: boolean;
  accountsSetupHref: string;
  reportHref: string | null;
  /** The Reports-hub cap table on the as-of date, from the position ledger. */
  asOfReportHref: string | null;
}

export interface SecuritiesViewData {
  context: EquityContext;
  asOfControl: AsOfControl;
  kind: SecurityKind | null;
  status: string | null;
  holderPartyId: string | null;
  holders: Option[];
  rows: (SecurityRow & { href: string })[];
  /** The convertibles' terms on the date, for the SAFE and note columns. */
  convertibles: CapTable["convertibles"];
  reportHref: string | null;
}

export interface StakeholdersViewData {
  context: EquityContext;
  asOfControl: AsOfControl;
  table: CapTable;
  parties: Record<string, { name: string; kind: string; email: string | null }>;
}

export interface StructureViewData {
  context: EquityContext;
  asOfControl: AsOfControl;
  structure: StructureView;
  /** The cap table's class rows on the date (outstanding and fully diluted), for the share classes view. */
  classRows: CapTable["classes"];
}

export interface RoundsViewData {
  context: EquityContext;
  structure: StructureView;
  /** The round whose drawer is open (`?round=<id>`): its terms, corrections and governed amend and void. */
  roundId: string | null;
  roundCloseHref: string;
  modelOpen: boolean;
  modelHref: string;
  modelCloseHref: string;
}

export interface WaterfallViewData {
  context: EquityContext;
  asOfControl: AsOfControl;
  /** The latest priced round in the functional currency, the default exit and the preset anchor. */
  anchor: { roundName: string; closedOn: string; postMoney: string } | null;
  presets: { multiple: string; value: string }[];
  inputs: {
    exitValue: string;
    transactionFees: string;
    unvestedAwards: "participate" | "cancel";
    changeOfControl: boolean;
    terminated: boolean;
    payoutsBy?: "class" | "holder";
  };
  /** The legal entity's share classes in creation order: each class's stable chart colour. */
  classOrder: string[];
  /** The scenario computed for the first paint; null until an exit value is known. */
  scenario: WaterfallScenario | null;
  refusal: { message: string; remedy: string } | null;
}

export interface RunPeriod {
  id: string;
  /** The native fiscal period label (P03 FY2026), with the stored name when it differs. */
  label: string;
  endsOn: string;
  /** The period's close: its close run when one is started, else the period in the close list. */
  closeHref: string;
}

export interface RunsViewData {
  context: EquityContext;
  run: RunKind;
  lines: "expense" | "releases";
  periods: RunPeriod[];
  periodId: string | null;
  throughDate: string | null;
  compensation: CompensationPreview | null;
  interest: InterestPreview | null;
  refusal: { message: string; remedy: string } | null;
  /** Where the refusal of the body is resolved, when the reader can act on it (generating the next fiscal year's periods). */
  refusalAction: { href: string; label: string } | null;
  /** What the next run catches up (recorded after the last run for the periods it measured), in the reader's words. */
  catchUp: string | null;
  /** Why the selected period cannot be posted yet (not ended, or closed), in the reader's locale. */
  blocked: { message: string; remedy: string } | null;
  compensationRuns: CompensationRunRow[];
  interestRuns: InterestRunRow[];
  parties: Record<string, string>;
  historyOpen: boolean;
  historyHref: string;
  historyCloseHref: string;
  reportHref: string | null;
  periodsSetupHref: string;
}

export interface SecurityDrawerData {
  context: EquityContext;
  detail: SecurityDetail;
  /** The certificate's restricted-stock releases with the entries that posted them (early-exercise certificates only). */
  releases: RestrictedReleaseRow[];
  closeHref: string;
  holders: Option[];
  rounds: Option[];
  commonClasses: Option[];
  considerationAccounts: Option[];
}

export interface SecurityDrawerRefusal {
  securityId: string;
  closeHref: string;
  refusal: { message: string; remedy: string };
}

export interface NewRecordData {
  context: EquityContext;
  kind: NewRecordKind;
  closeHref: string;
  /** Preselections carried in the URL (a holder from the stakeholder form, a SAFE from the convertibles filter). */
  holderPartyId: string | null;
  securityKind: SecurityKind | null;
  holders: Option[];
  classes: (Option & { kind: string })[];
  /** Common classes a preferred class can convert into. */
  commonClasses: Option[];
  plans: (Option & { shareClassId: string })[];
  rounds: (Option & { shareClassId: string; pricePerShare: string; currency: string })[];
  considerationAccounts: Option[];
  currencies: Option[];
  /** Stakeholders are parties: creating one needs parties.manage beside equity.manage. */
  canCreateParty: boolean;
}

export interface OverviewData {
  tiles: {
    fullyDiluted: string;
    fullyDilutedSub: string;
    pool: string;
    poolSub: string;
    price: string;
    priceSub: string;
    raised: string;
    raisedSub: string;
    compensation: string;
    compensationSub: string;
  };
  ownershipHint: string;
  ownership: { key: string; label: string; shares: string; percent: string; color: string }[];
  roundPulse: { postMoney: string; preMoney: string; raised: string } | null;
  attention: AttentionItem[];
  directory: DirectoryItem[];
  activity: { key: string; date: string; text: string; href: string | null }[];
  roundHref: string;
}

export interface EquityPageData {
  title: string;
  description: string;
  view: EquityView;
  entityPicker: { id: string; label: string }[];
  entityLabel: string;
  subsidiaryId: string;
  asOf: string;
  asOfControl: AsOfControl;
  hasEntity: boolean;
  noEntity: boolean;
  emptyTitle: string;
  emptyDescription: string;
  newAction: { href: string; label: string } | null;
  hasNewAction: boolean;
  onOverview: boolean;
  onCapTable: boolean;
  onSecurities: boolean;
  onRounds: boolean;
  onWaterfall: boolean;
  onCompensation: boolean;
  onClasses: boolean;
  onPlans: boolean;
  onStakeholders: boolean;
  overview: OverviewData | null;
  hasRoundPulse: boolean;
  labels: Record<string, string>;
  capTable: CapTableViewData | null;
  securities: SecuritiesViewData | null;
  stakeholders: StakeholdersViewData | null;
  structure: StructureViewData | null;
  rounds: RoundsViewData | null;
  waterfall: WaterfallViewData | null;
  runs: RunsViewData | null;
  drawerOpen: boolean;
  drawer: SecurityDrawerData | SecurityDrawerRefusal | null;
  newOpen: boolean;
  newRecord: NewRecordData | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * Drawer and redirect parameters, including the shell's stacked overlays (a
 * journal entry, a related record): they open one thing once and never
 * travel with a link.
 */
const TRANSIENT_PARAMS = new Set([
  "request",
  "security",
  "new",
  "newHolder",
  "newKind",
  "history",
  "model",
  "amend",
  "reserve",
  "round",
  "txn",
  "journalEntry",
  "reportRecord",
  "reportRecordKind",
  "drawerReturn",
  "transactionTab",
]);

async function holderOptions(
  orgId: string,
  allowed: ReadonlySet<string> | null,
): Promise<Option[]> {
  // The org-wide party rule: parties without an entity are eligible to every
  // caller; entity-bound parties stay inside their entity.
  return (
    await db.execute<{ id: string; name: string }>(
      sql`
    select id, display_name as name from parties
     where org_id = ${orgId} and is_active
     ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowed, { orgWideNull: true })}
     order by display_name limit 2000`,
      "objects",
    )
  ).map((row) => ({ value: row.id, label: row.name }));
}

async function currencyOptions(): Promise<Option[]> {
  return (
    await db.execute<{ code: string; name: string }>(
      sql`
    select code, name from currencies order by code`,
      "objects",
    )
  ).map((row) => ({ value: row.code, label: `${row.code} · ${row.name}` }));
}

async function considerationAccounts(orgId: string): Promise<Option[]> {
  return (
    await db.execute<{ id: string; label: string }>(
      sql`
    select id, concat_ws(' · ', number, name) as label from accounts
     where org_id = ${orgId} and is_active and not is_summary and type = any(${`{${CONSIDERATION_ACCOUNT_TYPES.join(",")}}`}::text[])
     order by number nulls last, name`,
      "objects",
    )
  ).map((row) => ({ value: row.id, label: row.label }));
}

async function partyNames(orgId: string, ids: readonly string[]): Promise<Record<string, string>> {
  const list = [...new Set(ids)].filter(isUuid);
  if (list.length === 0) return {};
  const rows = await db.execute<{ id: string; display_name: string }>(
    sql`
    select id, display_name from parties where org_id = ${orgId} and id = any(${`{${list.join(",")}}`}::uuid[])`,
    "objects",
  );
  return Object.fromEntries(rows.map((row) => [row.id, row.display_name]));
}

/**
 * The as-of date from the native as-of control: a point-in-time preset
 * (`asOfPeriod`), or a custom date (`asOf`, which the Flow links carry), or
 * the business date when neither is set.
 */
async function resolveAsOf(
  sp: Record<string, string | string[] | undefined>,
  orgId: string,
  today: string,
): Promise<{ asOf: string; control: AsOfControl }> {
  const presets = [...POINT_IN_TIME_PERIOD_PRESETS];
  const preset = pickString(sp.asOfPeriod);
  const custom = pickString(sp.asOf);
  if (preset && preset !== "custom" && presets.includes(preset)) {
    const resolved = await resolvePeriod(preset, { orgId, today });
    return { asOf: resolved.to, control: { defaultPeriod: "today", periodPresets: presets } };
  }
  if (custom && DATE_RE.test(custom))
    return { asOf: custom, control: { defaultPeriod: "custom", periodPresets: presets } };
  return { asOf: today, control: { defaultPeriod: "today", periodPresets: presets } };
}

const shareCount = (value: string, locale: string): string =>
  new Intl.NumberFormat(locale).format(BigInt(value));

/**
 * The page's data. The views read in parallel inside one read memo, so a
 * legal entity's records, its reader's authority and the report links load
 * once however many views of them the page composes.
 */
export function loadEquity(
  sp: Record<string, string | string[] | undefined>,
): Promise<EquityPageData> {
  return withReadMemo(() => loadEquityPage(sp));
}

async function loadEquityPage(
  sp: Record<string, string | string[] | undefined>,
): Promise<EquityPageData> {
  const t = await getTranslations("equity");
  const authz = await requirePermission("equity.read");
  const orgId = authz.user.orgId;
  await requireFeatureEnabled(orgId, "equity");
  const actor = { orgId, actorId: authz.user.id };
  const canManage = can(authz, "equity.manage");
  const locale = await getLocale();

  const requestParam = pickString(sp.request);
  if (requestParam) {
    let target: string | null = null;
    try {
      target = await locateEquityAction({ ...actor, requestId: requestParam });
    } catch (error) {
      if (!(error instanceof EquityError) || error.status !== 404) throw error;
    }
    redirect(target ?? EQUITY_BASE);
  }

  const [entities, today] = await Promise.all([listEquityEntities(actor), businessToday(orgId)]);
  const requestedSub = pickString(sp.sub);
  const entity = requestedSub
    ? (entities.find((row) => row.id === requestedSub) ?? null)
    : (entities[0] ?? null);
  if (requestedSub && !entity) throw new EquityError("entityOutsideAccess");
  const { asOf, control: asOfControl } = await resolveAsOf(sp, orgId, today);
  const securityParam = pickString(sp.security);
  const requestedView = pickString(sp.view);
  const view: EquityView = (EQUITY_VIEWS as readonly string[]).includes(requestedView ?? "")
    ? (requestedView as EquityView)
    : securityParam
      ? "securities"
      : "overview";
  const on = (key: EquityView) => entity !== null && view === key;

  const labels = {
    ownershipTitle: t("overview.ownership.title"),
    roundTitle: t("overview.round.title"),
    attentionTitle: t("overview.attention.title"),
    attentionAllClear: t("overview.attention.allClear"),
    activityTitle: t("overview.activity.title"),
    activityEmpty: t("overview.activity.empty"),
    directoryTitle: t("overview.directory.title"),
    fullyDiluted: t("overview.tiles.fullyDiluted"),
    pool: t("overview.tiles.pool"),
    price: t("overview.tiles.price"),
    raised: t("overview.tiles.raised"),
    compensation: t("overview.tiles.compensation"),
    ownershipEmpty: t("overview.ownership.empty"),
    roundPostMoney: t("overview.round.postMoney"),
    roundPreMoney: t("overview.round.preMoney"),
    roundRaised: t("overview.round.raised"),
    roundCta: t("overview.round.cta"),
  };
  const base = {
    title: t("home.title"),
    description: t("home.description"),
    view,
    entityPicker: entities.map((row) => ({ id: row.id, label: row.name })),
    entityLabel: t("entity.label"),
    subsidiaryId: entity?.id ?? "",
    asOf,
    asOfControl,
    hasEntity: entity !== null,
    noEntity: entity === null,
    emptyTitle: t("empty.noEntities"),
    emptyDescription: t("empty.noEntitiesDescription"),
    onOverview: on("overview"),
    onCapTable: on("captable"),
    onSecurities: on("securities"),
    onRounds: on("rounds"),
    onWaterfall: on("waterfall"),
    onCompensation: on("compensation"),
    onClasses: on("classes"),
    onPlans: on("plans"),
    onStakeholders: on("stakeholders"),
    labels,
  };
  if (!entity) {
    return {
      ...base,
      newAction: null,
      hasNewAction: false,
      overview: null,
      hasRoundPulse: false,
      capTable: null,
      securities: null,
      stakeholders: null,
      structure: null,
      rounds: null,
      waterfall: null,
      runs: null,
      drawerOpen: false,
      drawer: null,
      newOpen: false,
      newRecord: null,
    };
  }

  // In-page links keep the entity, the date control and the view's own
  // filters; an open drawer is never carried into another link.
  const params: Record<string, string | string[] | undefined> = Object.fromEntries(
    Object.entries(sp).filter(([key]) => !TRANSIENT_PARAMS.has(key)),
  );
  const keep = (overrides: Record<string, string | undefined>) =>
    equityHref(EQUITY_BASE, params, overrides);
  const scope = { ...actor, subsidiaryId: entity.id, asOf };
  const requestedPage = Number(pickString(sp.page) ?? "1");
  const pendingRead = pendingEquityActions({ ...actor, subsidiaryId: entity.id });
  // The context waits only on the pending actions; every read below starts
  // at once and shares the legal entity's book through the render's memo.
  const contextRead = pendingRead.then((pending): EquityContext => ({
    subsidiaryId: entity.id,
    currency: entity.currency,
    asOf,
    canManage,
    actorId: authz.user.id,
    pending,
    params,
    list: {
      page: Number.isInteger(requestedPage) && requestedPage >= 1 ? requestedPage : 1,
      query: pickString(sp.q) ?? "",
      ...parseEquityListSort(pickString(sp.sort), pickString(sp.dir)),
    },
  }));

  const newKind = VIEW_NEW_ACTION[view];
  const canCreateParty = can(authz, "parties.manage");
  const newAction =
    canManage && newKind && (newKind !== "stakeholder" || canCreateParty)
      ? { href: keep({ new: newKind, security: undefined }), label: t(`new.actions.${newKind}`) }
      : null;

  // Point-in-time reports open on this page's date through their as-of control.
  const asOfReport = (key: EquityReportSlug) =>
    reportHref(orgId, key, { period: "custom", from: asOf, to: asOf });

  const overviewRead = async (): Promise<OverviewData | null> => {
    if (view !== "overview") return null;
    const [yearStart, capView, classOrder, capTableReport, registerReport, compensationReport] =
      await Promise.all([
        resolvePeriod("this_fiscal_year_to_date", { orgId, today: asOf }).then(
          (period) => period.from,
        ),
        loadCapTableView(scope),
        classColorOrder(orgId, entity.id),
        asOfReport("equity-cap-table"),
        asOfReport("equity-securities-register"),
        reportHref(orgId, "equity-stock-compensation-schedule"),
      ]);
    const [data, pending] = await Promise.all([
      loadEquityOverview({ ...scope, yearStart }),
      pendingRead,
    ]);
    return overviewData(data, {
      locale,
      keep,
      pending,
      hasAccountPolicy: capView.hasAccountPolicy,
      orgId,
      classOrder,
      reports: {
        capTable: capTableReport,
        register: registerReport,
        compensation: compensationReport,
      },
    });
  };

  const capTableRead = async (): Promise<CapTableViewData | null> => {
    if (view !== "captable") return null;
    const [capView, register, asOfCapTable, context] = await Promise.all([
      loadCapTableView(scope),
      asOfReport("equity-securities-register"),
      asOfReport("equity-cap-table"),
      contextRead,
    ]);
    return {
      context,
      asOfControl,
      ...capTableFilters({
        by: pickString(sp.by),
        instrument: pickString(sp.instrument),
        q: pickString(sp.q),
      }),
      table: capView.table,
      parties: capView.parties,
      hasAccountPolicy: capView.hasAccountPolicy,
      accountsSetupHref: "/admin/setup/equity-account-policies",
      reportHref: register,
      // The report's as-of control, set to this page's date.
      asOfReportHref: asOfCapTable,
    };
  };

  const securitiesRead = async (): Promise<SecuritiesViewData | null> => {
    if (view !== "securities") return null;
    const requestedKind = pickString(sp.kind);
    const kind = KINDS.find((value) => value === requestedKind) ?? null;
    const requestedStatus = pickString(sp.status);
    const status = (STATUSES as readonly string[]).includes(requestedStatus ?? "")
      ? requestedStatus!
      : null;
    const holder = pickString(sp.holder);
    const holderPartyId = holder && isUuid(holder) ? holder : null;
    const [all, capView, register, context] = await Promise.all([
      listSecurities({ ...scope, kind: null, holderPartyId: null }),
      loadCapTableView(scope),
      asOfReport("equity-securities-register"),
      contextRead,
    ]);
    const holders = [
      ...new Map(all.rows.map((row) => [row.holderPartyId, row.holderName])).entries(),
    ]
      .sort(([, a], [, b]) => a.localeCompare(b, locale))
      .map(([value, label]) => ({ value, label }));
    return {
      context,
      asOfControl,
      kind,
      status,
      holderPartyId,
      holders,
      rows: all.rows
        .filter(
          (row) =>
            (!kind || row.kind === kind) &&
            (!holderPartyId || row.holderPartyId === holderPartyId) &&
            (!status || row.status === status),
        )
        .map((row) => ({
          ...row,
          href: keep({ view: "securities", security: row.id, new: undefined }),
        })),
      convertibles: capView.table.convertibles,
      reportHref: register,
    };
  };

  const stakeholdersRead = async (): Promise<StakeholdersViewData | null> => {
    if (view !== "stakeholders") return null;
    const [listed, context] = await Promise.all([listStakeholders(scope), contextRead]);
    return { context, asOfControl, table: listed.table, parties: listed.parties };
  };

  const structureRead = async (): Promise<StructureViewData | null> => {
    if (view !== "classes" && view !== "plans") return null;
    const [capView, structureView, context] = await Promise.all([
      loadCapTableView(scope),
      loadStructure(scope),
      contextRead,
    ]);
    return { context, asOfControl, structure: structureView, classRows: capView.table.classes };
  };

  const roundsRead = async (): Promise<RoundsViewData | null> => {
    if (view !== "rounds") return null;
    const [structureView, context] = await Promise.all([loadStructure(scope), contextRead]);
    return {
      context,
      structure: structureView,
      roundId: (() => {
        const id = pickString(sp.round);
        return id && isUuid(id) ? id : null;
      })(),
      roundCloseHref: keep({ round: undefined }),
      modelOpen: pickString(sp.model) === "round",
      modelHref: keep({ model: "round", new: undefined }),
      modelCloseHref: keep({ model: undefined }),
    };
  };

  const waterfallRead = async (): Promise<WaterfallViewData | null> => {
    if (view !== "waterfall") return null;
    return waterfallData(sp, await contextRead, asOfControl, scope);
  };

  const runsRead = async (): Promise<RunsViewData | null> => {
    if (view !== "compensation") return null;
    return runsData(
      sp,
      await contextRead,
      keep,
      orgId,
      actor,
      entity.id,
      today,
      can(authz, "periods.manage"),
    );
  };

  const drawerRead = async (): Promise<SecurityDrawerData | SecurityDrawerRefusal | null> => {
    if (!securityParam) return null;
    const missing = async (): Promise<SecurityDrawerRefusal> => ({
      securityId: securityParam,
      closeHref: keep({ security: undefined }),
      refusal: await readerRefusal(new EquityError("securityUnknown")),
    });
    if (!isUuid(securityParam)) return missing();
    try {
      const [detail, structureView, holders, accounts, context] = await Promise.all([
        loadSecurityDetail({ ...actor, securityId: securityParam, asOf }),
        canManage ? loadStructure(scope) : null,
        canManage ? holderOptions(orgId, authz.allowedSubsidiaryIds) : [],
        canManage ? considerationAccounts(orgId) : [],
        contextRead,
      ]);
      if (detail.entity.id !== entity.id) return missing();
      return {
        context,
        detail,
        releases: detail.restricted
          ? await listRestrictedReleases({ ...actor, securityId: securityParam })
          : [],
        closeHref: keep({ security: undefined }),
        holders,
        rounds:
          structureView?.rounds.map((row) => ({
            value: row.id,
            label: `${row.name} · ${formatCivilDate(row.closedOn, locale)}`,
          })) ?? [],
        commonClasses:
          structureView?.classes
            .filter((row) => row.kind === "common")
            .map((row) => ({ value: row.id, label: `${row.code} · ${row.name}` })) ?? [],
        considerationAccounts: accounts,
      };
    } catch (error) {
      if (!(error instanceof EquityError)) throw error;
      return {
        securityId: securityParam,
        closeHref: keep({ security: undefined }),
        refusal: await readerRefusal(error),
      };
    }
  };

  const requestedNew = pickString(sp.new);
  const newRecordKind = NEW_RECORD_KINDS.find((value) => value === requestedNew) ?? null;
  const newRecordRead = async (): Promise<NewRecordData | null> => {
    if (!canManage || !newRecordKind || (newRecordKind === "stakeholder" && !canCreateParty))
      return null;
    const requestedHolder = pickString(sp.newHolder);
    const requestedKind = pickString(sp.newKind);
    const [structureView, holders, accounts, currencies, context] = await Promise.all([
      loadStructure(scope),
      holderOptions(orgId, authz.allowedSubsidiaryIds),
      considerationAccounts(orgId),
      currencyOptions(),
      contextRead,
    ]);
    return {
      context,
      kind: newRecordKind,
      closeHref: keep({ new: undefined, newHolder: undefined, newKind: undefined }),
      holderPartyId: requestedHolder && isUuid(requestedHolder) ? requestedHolder : null,
      securityKind: KINDS.find((value) => value === requestedKind) ?? null,
      holders,
      classes: structureView.classes.map((row) => ({
        value: row.id,
        label: `${row.code} · ${row.name}`,
        kind: row.kind,
      })),
      commonClasses: structureView.classes
        .filter((row) => row.kind === "common")
        .map((row) => ({ value: row.id, label: `${row.code} · ${row.name}` })),
      plans: structureView.plans.map((row) => ({
        value: row.id,
        label: `${row.code} · ${row.name}`,
        shareClassId: row.shareClassId,
      })),
      rounds: structureView.rounds.map((row) => ({
        value: row.id,
        label: `${row.name} · ${formatCivilDate(row.closedOn, locale)}`,
        shareClassId: row.shareClassId,
        pricePerShare: row.pricePerShare,
        currency: row.currency,
      })),
      considerationAccounts: accounts,
      currencies,
      canCreateParty,
    };
  };

  const [
    overview,
    capTable,
    securities,
    stakeholders,
    structure,
    rounds,
    waterfall,
    runs,
    drawer,
    newRecord,
  ] = await Promise.all([
    overviewRead(),
    capTableRead(),
    securitiesRead(),
    stakeholdersRead(),
    structureRead(),
    roundsRead(),
    waterfallRead(),
    runsRead(),
    drawerRead(),
    newRecordRead(),
  ]);

  return {
    ...base,
    newAction,
    hasNewAction: newAction !== null,
    overview,
    hasRoundPulse: overview?.roundPulse != null,
    capTable,
    securities,
    stakeholders,
    structure,
    rounds,
    waterfall,
    runs,
    drawerOpen: drawer !== null,
    drawer,
    newOpen: newRecord !== null,
    newRecord,
  };
}

/**
 * The legal entity's share classes in the order they came into being, so a
 * class keeps its chart colour whatever the as-of date shows (a later class
 * never shifts an earlier class's colour).
 */
async function classColorOrder(orgId: string, subsidiaryId: string): Promise<string[]> {
  return (
    await db.execute<{ id: string }>(
      sql`
    select id from equity_share_classes
     where org_id = ${orgId} and subsidiary_id = ${subsidiaryId}
     order by effective_on, created_at, id`,
      "objects",
    )
  ).map((row) => row.id);
}

/** The built-in reports the workspace links to, resolved together once per render. */
const EQUITY_REPORT_SLUGS = [
  "equity-cap-table",
  "equity-securities-register",
  "equity-stock-compensation-schedule",
] as const;

type EquityReportSlug = (typeof EQUITY_REPORT_SLUGS)[number];

async function reportHref(
  orgId: string,
  key: EquityReportSlug,
  params: Record<string, string> = {},
): Promise<string | null> {
  const ids = await memoizedRead(`equity-report-ids:${orgId}`, () =>
    builtInReportDefinitionIds(orgId, EQUITY_REPORT_SLUGS),
  );
  const id = ids.get(key);
  if (!id) return null;
  const query = new URLSearchParams(params).toString();
  return `/reports/custom/run/${id}${query ? `?${query}` : ""}`;
}

type Keep = (overrides: Record<string, string | undefined>) => string;

/** The overview's tiles, ownership, attention, quick links and activity, worded for the reader. */
async function overviewData(
  data: EquityOverview,
  input: {
    locale: string;
    keep: Keep;
    pending: PendingRequest[];
    hasAccountPolicy: boolean;
    orgId: string;
    /** The entity's share classes in creation order, for stable chart colours. */
    classOrder: readonly string[];
    reports: { capTable: string | null; register: string | null; compensation: string | null };
  },
): Promise<OverviewData> {
  const t = await getTranslations("equity");
  const { locale, keep } = input;
  const { money, moneyCompact } = await getMoneyFormatter(input.orgId, data.entity.currency);
  const shares = (value: string) => shareCount(value, locale);
  const date = (value: string) => formatCivilDate(value, locale);
  const percent = (value: string) =>
    formatExactPercent(normalizeDecimal(roundMoney(value, 1), 1), locale, 1);
  const functional = data.raised.find((row) => row.currency === data.entity.currency) ?? null;
  const others = data.raised.filter((row) => row.currency !== data.entity.currency);
  const pool = data.ownership.find((slice) => slice.group === "pool") ?? null;
  const security = (securityId: string) =>
    keep({ view: "securities", security: securityId, new: undefined });

  // Runs that cannot be measured name their refusal in the reader's language.
  const refusedRuns = new Map<EquityAttention, string>();
  for (const item of data.attention) {
    if ((item.kind === "compensation_due" || item.kind === "interest_due") && item.refusal)
      refusedRuns.set(item, (await readerRefusal(item.refusal)).message);
  }
  const price = (value: string, currency: string) =>
    money(value, { currency, ...perShareFormatOptions(value) });

  const attention: AttentionItem[] = data.attention.map((item: EquityAttention): AttentionItem => {
    switch (item.kind) {
      case "cliff":
        return {
          tone: "warning",
          href: security(item.securityId),
          text: t("overview.attention.cliff", {
            holder: item.holderName,
            number: item.securityNumber,
            date: date(item.date),
            quantity: shares(item.quantity),
            quantityCount: Number(item.quantity),
          }),
        };
      case "election_83b":
        return {
          tone: item.daysLeft <= 7 ? "negative" : "warning",
          href: security(item.securityId),
          text: t("overview.attention.election83b", {
            holder: item.holderName,
            number: item.securityNumber,
            date: date(item.date),
            days: item.daysLeft,
          }),
        };
      case "restricted_deposit":
        return {
          tone: "warning",
          href: security(item.securityId),
          text: t("overview.attention.restrictedDeposit", {
            holder: item.holderName,
            number: item.securityNumber,
            shares: shares(item.shares),
            sharesCount: Number(item.shares),
          }),
        };
      case "departed":
        return {
          tone: "negative",
          href: keep({
            view: "securities",
            holder: item.holderPartyId,
            kind: undefined,
            status: "outstanding",
            new: undefined,
          }),
          text: t("overview.attention.departed", {
            holder: item.holderName,
            date: date(item.date),
            units: shares(item.units),
            unitsCount: Number(item.units),
          }),
        };
      case "expiring":
        return {
          tone: "warning",
          href: security(item.securityId),
          text: t("overview.attention.expiring", {
            holder: item.holderName,
            number: item.securityNumber,
            date: date(item.date),
            quantity: shares(item.quantity),
            quantityCount: Number(item.quantity),
          }),
        };
      case "conversion_terms_void":
        return {
          tone: "negative",
          href: security(item.securityId),
          text: item.certificateNumber
            ? t("overview.attention.conversionTermsVoid", {
                holder: item.holderName,
                number: item.securityNumber,
                source: item.sourceSecurityNumber,
                certificate: item.certificateNumber,
              })
            : t("overview.attention.electionTermsVoid", {
                holder: item.holderName,
                number: item.securityNumber,
                source: item.sourceSecurityNumber,
              }),
        };
      case "compensation_due":
        return {
          tone: "warning",
          href: keep({ view: "compensation", run: undefined, new: undefined }),
          text: item.refusal
            ? t("overview.attention.compensationRefused", {
                date: date(item.date),
                message: refusedRuns.get(item) ?? item.refusal.message,
              })
            : t("overview.attention.compensationDue", {
                date: date(item.date),
                amount: money(item.amount, { currency: item.currency }),
              }),
        };
      case "interest_due":
        return {
          tone: "warning",
          href: keep({ view: "compensation", run: "interest", new: undefined }),
          text: item.refusal
            ? t("overview.attention.interestRefused", {
                date: date(item.date),
                message: refusedRuns.get(item) ?? item.refusal.message,
              })
            : t("overview.attention.interestDue", {
                date: date(item.date),
                amount: money(item.amount, { currency: item.currency }),
              }),
        };
      case "compensation_catch_up":
      case "interest_catch_up": {
        const key = item.kind === "compensation_catch_up" ? "compensation" : "interest";
        const values = {
          amount: money(item.amount, { currency: item.currency }),
          date: date(item.date),
          through: item.postsThrough ? date(item.postsThrough) : "",
        };
        return {
          tone: "warning",
          href: keep({
            view: "compensation",
            run: key === "interest" ? "interest" : undefined,
            period: undefined,
            new: undefined,
          }),
          text: !item.postsThrough
            ? t(`overview.attention.${key}CatchUpNoPeriod`, values)
            : item.postsNow
              ? t(`overview.attention.${key}CatchUpNow`, values)
              : t(`overview.attention.${key}CatchUp`, values),
        };
      }
      case "round_pre_money_drift":
        return {
          tone: "negative",
          href: keep({ view: "rounds", round: item.roundId, new: undefined }),
          text: t("overview.attention.roundPreMoneyDrift", {
            name: item.roundName,
            preMoney: money(item.preMoneyValuation, { currency: item.currency }),
            implied: money(item.impliedPreMoney, { currency: item.currency }),
            shares: shares(item.fullyDilutedBefore),
          }),
        };
      case "conversion_price_drift":
        return {
          tone: "warning",
          href: security(item.securityId),
          text: t("overview.attention.conversionPriceDrift", {
            number: item.securityNumber,
            round: item.roundName,
            recorded: price(item.recordedPrice, item.currency),
            standing: price(item.standingPrice, item.currency),
          }),
        };
    }
  });
  if (input.pending.length > 0)
    attention.unshift({
      tone: "warning",
      href: APPROVALS_HOME_HREF,
      text: t("overview.attention.pending", { count: input.pending.length }),
    });
  if (!input.hasAccountPolicy)
    attention.unshift({
      tone: "negative",
      href: "/admin/setup/equity-account-policies",
      text: t("overview.attention.policyMissing", { date: date(data.asOf) }),
    });

  const compensationDue =
    data.postings?.compensation.due === true || data.postings?.compensation.catchUp != null;
  const directory: DirectoryItem[] = [
    {
      href: keep({ view: "captable", new: undefined }),
      label: t("tabs.captable"),
      iconKey: "layers",
      badge: { value: shares(String(data.holders)), hint: t("overview.directory.holders") },
    },
    {
      href: keep({ view: "securities", new: undefined }),
      label: t("tabs.securities"),
      iconKey: "file",
      badge: {
        value: shares(String(data.convertiblesOutstanding)),
        hint: t("overview.directory.convertibles"),
      },
    },
    {
      href: keep({ view: "waterfall", new: undefined }),
      label: t("tabs.waterfall"),
      iconKey: "chart-no-axes-combined",
    },
    {
      href: keep({ view: "compensation", new: undefined }),
      label: t("tabs.compensation"),
      iconKey: "calendar-check",
      badge: data.postings
        ? {
            value: compensationDue ? t("overview.directory.due") : t("overview.directory.current"),
            hint: t("overview.directory.through", { date: date(data.postings.throughDate) }),
            tone: compensationDue ? "warning" : "positive",
          }
        : undefined,
    },
    ...(input.reports.capTable
      ? [
          {
            href: input.reports.capTable,
            label: t("overview.directory.capTableReport"),
            iconKey: "scale",
          },
        ]
      : []),
    ...(input.reports.register
      ? [
          {
            href: input.reports.register,
            label: t("overview.directory.registerReport"),
            iconKey: "scroll",
          },
        ]
      : []),
    ...(input.reports.compensation
      ? [
          {
            href: input.reports.compensation,
            label: t("overview.directory.compensationReport"),
            iconKey: "percent",
          },
        ]
      : []),
    {
      href: "/admin/setup/equity-account-policies",
      label: t("overview.directory.accounts"),
      iconKey: "settings",
    },
  ];

  const activity = data.activity.map((row) => {
    const detail = row.quantity
      ? t("overview.activity.shares", {
          quantity: shares(row.quantity),
          quantityCount: Number(row.quantity),
        })
      : row.amount && row.currency
        ? money(row.amount, { currency: row.currency })
        : null;
    const text =
      row.kind === "round"
        ? t("overview.activity.round", {
            name: row.label ?? "",
            price: money(row.amount ?? "0", {
              currency: row.currency ?? data.entity.currency,
              ...perShareFormatOptions(row.amount ?? "0"),
            }),
          })
        : row.kind === "issue"
          ? t("overview.activity.issue", {
              kind: t(`kind.${row.securityKind ?? "share"}`),
              number: row.securityNumber ?? "",
              holder: row.holderName ?? "",
            })
          : [t(`eventKind.${row.kind}`), row.securityNumber, row.holderName]
              .filter(Boolean)
              .join(" · ");
    return {
      key: row.key,
      date: date(row.date),
      text: detail && row.kind !== "round" ? `${text} · ${detail}` : text,
      href: row.securityId
        ? security(row.securityId)
        : row.kind === "round"
          ? keep({ view: "rounds", new: undefined })
          : null,
    };
  });

  const round = data.latestRound;
  const roundInFunctional = round !== null && round.currency === data.entity.currency;
  // The raised total and its priced and convertible parts round together, so
  // the compact figures on the tile add up.
  const raisedFigures = functional
    ? additiveRounding(functional.total, [functional.priced, functional.convertible])
    : null;
  const compact = (value: string, currency?: string) =>
    moneyCompact(value, { currency, maximumFractionDigits: 2 });
  return {
    tiles: {
      fullyDiluted: shares(data.totals.fullyDiluted),
      fullyDilutedSub: t("overview.tiles.fullyDilutedSub", {
        outstanding: shares(data.totals.asConvertedOutstanding),
      }),
      pool: shares(data.totals.poolAvailable),
      poolSub: pool
        ? t("overview.tiles.poolSub", { percent: percent(pool.percent) })
        : t("overview.tiles.noPool"),
      price: round
        ? money(round.pricePerShare, {
            currency: round.currency,
            ...perShareFormatOptions(round.pricePerShare),
          })
        : "—",
      priceSub: round ? `${round.name} · ${date(round.closedOn)}` : t("overview.tiles.noRound"),
      raised: raisedFigures
        ? compact(raisedFigures.total)
        : others[0]
          ? compact(additiveRounding(others[0].total, []).total, others[0].currency)
          : moneyCompact("0"),
      raisedSub:
        [
          raisedFigures
            ? t("overview.tiles.raisedSub", {
                priced: compact(raisedFigures.parts[0]!),
                convertible: compact(raisedFigures.parts[1]!),
              })
            : null,
          ...others.slice(functional ? 0 : 1).map((row) =>
            t("overview.tiles.raisedOther", {
              amount: compact(additiveRounding(row.total, []).total, row.currency),
            }),
          ),
        ]
          .filter(Boolean)
          .join(" · ") || t("overview.tiles.noRaise"),
      compensation: moneyCompact(data.compensationPosted.amount),
      compensationSub: t("overview.tiles.compensationSub", {
        date: date(data.compensationPosted.from),
      }),
    },
    ownershipHint: t("overview.ownership.hint", { date: date(data.asOf) }),
    ownership: data.ownership.map((slice) => ({
      key: slice.key,
      label:
        slice.group === "class"
          ? `${slice.code ?? ""} · ${slice.name ?? ""}`
          : slice.group === "pool"
            ? t("overview.ownership.pool")
            : t(`kindPlural.${slice.group}`),
      shares: slice.shares,
      percent: slice.percent,
      color: ownershipSliceColor(slice, input.classOrder),
    })),
    roundPulse:
      round && roundInFunctional
        ? {
            postMoney: moneyCompact(round.postMoneyValuation),
            preMoney: moneyCompact(round.preMoneyValuation),
            raised: moneyCompact(round.raised),
          }
        : round
          ? {
              postMoney: moneyCompact(round.postMoneyValuation, { currency: round.currency }),
              preMoney: moneyCompact(round.preMoneyValuation, { currency: round.currency }),
              raised: moneyCompact(round.raised, { currency: round.currency }),
            }
          : null,
    attention: attention.slice(0, 8),
    directory,
    activity,
    roundHref: keep({ view: "rounds", model: "round", new: undefined }),
  };
}

async function waterfallData(
  sp: Record<string, string | string[] | undefined>,
  context: EquityContext,
  asOfControl: AsOfControl,
  scope: { orgId: string; actorId: string; subsidiaryId: string; asOf: string },
): Promise<WaterfallViewData> {
  const [structure, classOrder] = await Promise.all([
    loadStructure(scope),
    classColorOrder(scope.orgId, scope.subsidiaryId),
  ]);
  // The default exit is the latest priced round's post-money valuation in the functional currency.
  const anchor = defaultExitAnchor(structure.rounds, scope.asOf, context.currency);
  const decimal = (value: string | undefined) =>
    value && /^\d+(\.\d{1,4})?$/.test(value) ? value : null;
  const inputs: WaterfallViewData["inputs"] = {
    exitValue: decimal(pickString(sp.exit)) ?? anchor?.postMoney ?? "",
    transactionFees: decimal(pickString(sp.fees)) ?? "",
    unvestedAwards: pickString(sp.unvested) === "cancel" ? "cancel" : "participate",
    changeOfControl: pickString(sp.coc) !== "0",
    terminated: pickString(sp.terminated) === "1",
    payoutsBy: pickString(sp.payouts) === "holder" ? "holder" : "class",
  };
  let scenario: WaterfallScenario | null = null;
  let refusal: WaterfallViewData["refusal"] = null;
  if (inputs.exitValue && cmp(inputs.exitValue, "0") >= 0) {
    try {
      scenario = await runEntityWaterfallScenario({
        ...scope,
        exitValue: inputs.exitValue,
        transactionFees: inputs.transactionFees || null,
        unvestedAwards: inputs.unvestedAwards,
        changeOfControl: inputs.changeOfControl,
        terminated: inputs.terminated,
      });
    } catch (error) {
      if (!(error instanceof EquityError)) throw error;
      refusal = await readerRefusal(error);
    }
  }
  return {
    context,
    asOfControl,
    anchor,
    presets: exitPresets(anchor?.postMoney ?? null),
    inputs,
    classOrder,
    scenario,
    refusal,
  };
}

async function runsData(
  sp: Record<string, string | string[] | undefined>,
  context: EquityContext,
  keep: Keep,
  orgId: string,
  actor: { orgId: string; actorId: string },
  subsidiaryId: string,
  today: string,
  canManagePeriods: boolean,
): Promise<RunsViewData> {
  const run: RunKind = pickString(sp.run) === "interest" ? "interest" : "compensation";
  const lines: RunsViewData["lines"] =
    run === "compensation" && pickString(sp.lines) === "releases" ? "releases" : "expense";
  const compensationRuns = await listCompensationRuns({ ...actor, subsidiaryId });
  const interestRuns = await listInterestRuns({ ...actor, subsidiaryId });
  const lastRunThrough =
    (run === "compensation" ? compensationRuns : interestRuns)[0]?.throughDate ?? null;
  // Each period reads with the native fiscal label, and links to its own
  // close: the primary book's close run once started, else the period's row
  // in the close list of its fiscal year.
  const locale = await getLocale();
  const periods = (
    await db.execute<{
      id: string;
      name: string;
      starts_on: string;
      ends_on: string;
      fiscal_year: number;
      period_number: number;
      is_adjustment: boolean;
      close_run_id: string | null;
    }>(
      sql`
    select p.id, p.name, p.starts_on::text as starts_on, p.ends_on::text as ends_on, p.fiscal_year, p.period_number, p.is_adjustment,
           (select r.id from close_runs r
              join accounting_books b on b.org_id = r.org_id and b.id = r.book_id and b.is_primary
             where r.org_id = p.org_id and r.period_id = p.id
             order by r.created_at desc limit 1) as close_run_id
      from accounting_periods p
     where p.org_id = ${orgId} and not p.is_adjustment
     order by p.starts_on desc
     limit 60`,
      "objects",
    )
  ).map((row): RunPeriod => {
    const label = periodDisplayLabel(
      {
        fiscalYear: row.fiscal_year,
        periodNumber: row.period_number,
        adjustment: row.is_adjustment,
        startsOn: row.starts_on,
        endsOn: row.ends_on,
      },
      locale,
    );
    return {
      id: row.id,
      label,
      endsOn: row.ends_on,
      closeHref: row.close_run_id
        ? `/close?${new URLSearchParams({ run: row.close_run_id })}`
        : `/close?${new URLSearchParams({ fy: String(row.fiscal_year), q: canonicalPeriodLabel({ fiscalYear: row.fiscal_year, periodNumber: row.period_number, adjustment: row.is_adjustment }) })}`,
    };
  });
  const requested = pickString(sp.period);
  const key = run === "compensation" ? "compensation" : "interest";
  // Recorded after the last run for the periods it measured: the next run catches it up.
  const late = await equityRunCatchUp({ ...actor, subsidiaryId, kind: run });
  // The period a run is due for: the earliest open period after the last run
  // through whose end the run would post a change. With none ended, a
  // pending catch-up is due in the period after the last run, so that period
  // is shown with why it cannot post yet; nothing is offered when nothing is
  // due, so a closed period or an empty run is never the default.
  const due = requested
    ? null
    : await nextEquityRunPeriod({ ...actor, subsidiaryId, kind: run, today });
  const catchUpPeriodId = !requested && !due && late?.postsWith ? late.postsWith.periodId : null;
  const selected =
    periods.find((period) => period.id === (requested ?? due?.periodId ?? catchUpPeriodId)) ?? null;
  let compensation: CompensationPreview | null = null;
  let interest: InterestPreview | null = null;
  let refusal: RunsViewData["refusal"] = null;
  let refusalAction: RunsViewData["refusalAction"] = null;
  const t = await getTranslations("equity");
  const catchUpValues = late
    ? {
        amount: (await getMoneyFormatter(orgId, late.currency)).money(late.amount, {
          currency: late.currency,
        }),
        date: formatCivilDate(late.recognizedThrough, locale),
        through: late.postsWith ? formatCivilDate(late.postsWith.endsOn, locale) : "",
      }
    : null;
  if (!selected && periods.length > 0) {
    if (late && catchUpValues && !late.postsWith) {
      // A catch-up is due, but no open period follows the last run to post it in.
      const year = late.generatePeriods?.fiscalYear ?? null;
      refusal = {
        message: t(`runs.catchUp.${key}NoPeriodTitle`, catchUpValues),
        remedy:
          year !== null
            ? canManagePeriods
              ? t("runs.catchUp.generateRemedy", { year })
              : t("runs.catchUp.generateRemedyReadOnly", { year })
            : canManagePeriods
              ? t("runs.catchUp.reopenRemedy")
              : t("runs.catchUp.reopenRemedyReadOnly"),
      };
      refusalAction = !canManagePeriods
        ? null
        : year !== null
          ? {
              href: `/admin/setup/period-close?${new URLSearchParams({ tab: "periods", period: "new", fy: String(year) })}`,
              label: t("runs.catchUp.generatePeriods", { year }),
            }
          : {
              href: `/admin/setup/period-close?${new URLSearchParams({ tab: "periods" })}`,
              label: t("runs.catchUp.openPeriods"),
            };
    } else {
      refusal = {
        message: t(
          run === "compensation" ? "runs.nothingDueCompensation" : "runs.nothingDueInterest",
        ),
        remedy: lastRunThrough
          ? t("runs.nothingDueRemedy", { date: formatCivilDate(lastRunThrough, locale) })
          : t("runs.nothingDueRemedyFirst"),
      };
    }
  }
  if (selected) {
    try {
      if (run === "compensation")
        compensation = await previewCompensationRun({
          ...actor,
          subsidiaryId,
          throughDate: selected.endsOn,
        });
      else
        interest = await previewInterestRun({
          ...actor,
          subsidiaryId,
          throughDate: selected.endsOn,
        });
    } catch (error) {
      if (!(error instanceof EquityError)) throw error;
      refusal = await readerRefusal(error);
    }
  }
  // The catch-up notice names what the next run posts; with no period to post it in, the body says so instead.
  const catchUp =
    late && catchUpValues && late.postsWith
      ? late.postsWith.ended
        ? t(`runs.catchUp.${key}Now`, catchUpValues)
        : t(`runs.catchUp.${key}`, catchUpValues)
      : null;
  const pendingBlock = (compensation ?? interest)?.blocked ?? null;
  const blocked = pendingBlock ? await readerRefusal(pendingBlock) : null;
  const holderIds = [
    ...(compensation?.lines.map((line) => line.holderPartyId) ?? []),
    ...(compensation?.releases.map((line) => line.holderPartyId) ?? []),
    ...(interest?.lines.map((line) => line.holderPartyId) ?? []),
  ];
  return {
    context,
    run,
    lines,
    periods,
    periodId: selected?.id ?? null,
    throughDate: selected?.endsOn ?? null,
    compensation,
    interest,
    refusal,
    refusalAction,
    catchUp,
    blocked,
    compensationRuns,
    interestRuns,
    parties: await partyNames(orgId, holderIds),
    historyOpen: pickString(sp.history) === "1",
    historyHref: keep({ history: "1", new: undefined }),
    historyCloseHref: keep({ history: undefined }),
    reportHref:
      run === "compensation" ? await reportHref(orgId, "equity-stock-compensation-schedule") : null,
    periodsSetupHref: "/admin/setup/period-close",
  };
}

const f = ref<EquityPageData>();

/** The overview: vitals, the ownership hero and recent activity, and the rail of the round, attention and quick links. */
function overviewBlocks(data: EquityPageData) {
  return grid("flex h-full min-h-0 flex-col gap-4", [
    // The as-of control leads the overview body, as it leads every working
    // view's toolbar, so the page header keeps room for its description.
    grid("flex shrink-0 flex-wrap items-center gap-2", [
      widgetBlock("equity-as-of", { control: data.asOfControl, compact: false }),
    ]),
    grid("grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5", [
      statTile({
        iconKey: "layers",
        accent: "teal",
        label: f("labels.fullyDiluted"),
        value: f("overview.tiles.fullyDiluted"),
        sub: f("overview.tiles.fullyDilutedSub"),
      }),
      statTile({
        iconKey: "users",
        accent: "violet",
        label: f("labels.pool"),
        value: f("overview.tiles.pool"),
        sub: f("overview.tiles.poolSub"),
      }),
      statTile({
        iconKey: "trending-up",
        accent: "sky",
        label: f("labels.price"),
        value: f("overview.tiles.price"),
        sub: f("overview.tiles.priceSub"),
      }),
      statTile({
        iconKey: "coins",
        accent: "emerald",
        label: f("labels.raised"),
        value: f("overview.tiles.raised"),
        sub: f("overview.tiles.raisedSub"),
      }),
      statTile({
        iconKey: "scale",
        accent: "amber",
        label: f("labels.compensation"),
        value: f("overview.tiles.compensation"),
        sub: f("overview.tiles.compensationSub"),
      }),
    ]),
    grid("grid min-h-0 flex-1 grid-cols-1 gap-5 lg:grid-cols-3", [
      grid("flex min-h-0 flex-col gap-5 overflow-y-auto lg:col-span-2", [
        panel({
          title: f("labels.ownershipTitle"),
          iconKey: "pie-chart",
          hint: f("overview.ownershipHint"),
          className: "shrink-0",
          blocks: [
            widgetBlock("equity-ownership", {
              slices: data.overview?.ownership ?? [],
              empty: data.labels.ownershipEmpty,
            }),
          ],
        }),
        panel({
          title: f("labels.activityTitle"),
          iconKey: "history",
          bodyClassName: "p-0",
          className: "shrink-0",
          blocks: [
            widgetBlock("equity-activity", {
              items: data.overview?.activity ?? [],
              empty: data.labels.activityEmpty,
            }),
          ],
        }),
      ]),
      grid("flex min-h-0 flex-col gap-5 overflow-y-auto", [
        panel({
          title: f("labels.roundTitle"),
          iconKey: "gauge",
          bodyClassName: "p-0",
          className: "shrink-0",
          when: f("hasRoundPulse"),
          blocks: [
            widgetBlock("ap-pulse", {
              outstanding: data.overview?.roundPulse?.postMoney ?? "",
              overdue: data.overview?.roundPulse?.preMoney ?? "",
              dueNext7: data.overview?.roundPulse?.raised ?? "",
              overdueIsNegative: false,
              labels: roundPulseLabels(data),
              href: data.overview?.roundHref ?? "",
            }),
          ],
        }),
        panel({
          title: f("labels.attentionTitle"),
          iconKey: "triangle-alert",
          bodyClassName: "p-0",
          className: "shrink-0",
          blocks: [
            widgetBlock("attention-list", {
              items: data.overview?.attention ?? [],
              allClear: data.labels.attentionAllClear,
            }),
          ],
        }),
        widgetBlock("directory-section", {
          items: data.overview?.directory ?? [],
          title: data.labels.directoryTitle,
        }),
      ]),
    ]),
  ]);
}

function roundPulseLabels(data: EquityPageData) {
  return {
    open: data.labels.roundPostMoney ?? "",
    overdue: data.labels.roundPreMoney ?? "",
    due7: data.labels.roundRaised ?? "",
    cta: data.labels.roundCta ?? "",
  };
}

export function equitySpec(data: EquityPageData): PageSpec {
  return page({
    route: "/equity",
    layout: "list",
    bodyClassName: data.view === "overview" ? "flex h-full min-h-0 flex-col" : undefined,
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actionsClassName: "flex flex-wrap items-center justify-end gap-2",
        actions: [
          widget(
            "subsidiary-switcher",
            { picker: data.entityPicker, value: data.subsidiaryId, label: data.entityLabel },
            f("hasEntity"),
          ),
          widget(
            "link-button",
            {
              href: data.newAction?.href ?? "",
              label: data.newAction?.label ?? "",
              iconKey: "plus",
            },
            f("hasNewAction"),
          ),
        ],
      }),
    ],
    body: [
      {
        ...widgetBlock("empty-state", {
          title: data.emptyTitle,
          description: data.emptyDescription,
        }),
        when: f("noEntity"),
      },
      ...(data.overview ? [overviewBlocks(data)] : []),
      { ...widgetBlock("equity-cap-table", { view: data.capTable }), when: f("onCapTable") },
      { ...widgetBlock("equity-securities", { view: data.securities }), when: f("onSecurities") },
      { ...widgetBlock("equity-rounds", { view: data.rounds }), when: f("onRounds") },
      { ...widgetBlock("equity-waterfall", { view: data.waterfall }), when: f("onWaterfall") },
      { ...widgetBlock("equity-runs", { view: data.runs }), when: f("onCompensation") },
      { ...widgetBlock("equity-classes", { view: data.structure }), when: f("onClasses") },
      { ...widgetBlock("equity-plans", { view: data.structure }), when: f("onPlans") },
      {
        ...widgetBlock("equity-stakeholders", { view: data.stakeholders }),
        when: f("onStakeholders"),
      },
      { ...widgetBlock("equity-security-drawer", { drawer: data.drawer }), when: f("drawerOpen") },
      { ...widgetBlock("equity-new-drawer", { data: data.newRecord }), when: f("newOpen") },
    ],
  });
}
