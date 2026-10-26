import "server-only";

import { registeredListTable } from "../../../lib/list/prepared-spec";
import { getMoneyFormatter } from "@/lib/money-server";
import { inArray, sql } from "drizzle-orm";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { periodDisplayLabelSql } from "@openbooks/engine/periods/period-policy";
import { db, schema } from "@openbooks/engine/platform/db";
import {
  flowSubjectSubsidiarySql,
  listFlowSubjectProfiles,
} from "@openbooks/engine/flows/registry";
import {
  dueBusinessDay,
  type InboxItem,
  type InboxSourceNotice,
} from "@openbooks/engine/inbox/runtime";
import {
  approvalWorklistAwaitingForAuthz,
  approvalWorklistOrganizationPageForAuthz,
  approvalWorklistPageForAuthz,
  type ApprovalWorklistItem,
} from "../../../lib/application/approvals";
import {
  inboxContext,
  inboxCounts,
  inboxTaskFilters,
  maySeeUnion,
} from "../../../lib/inbox-context";
import {
  badge,
  column,
  field,
  frame,
  grid,
  money,
  page,
  pageHeader,
  ref,
  rootRef,
  text,
  widget,
  widgetBlock,
  widgetCell,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { getAuthz, can } from "../../../lib/authz";
import { APPROVALS_BULK_BATCH_MAX } from "../../../lib/approvals-limits";
import { clamp, pickString } from "../../../lib/list-params";
import { approvalRecordHref } from "../../../lib/approvals-links";
import {
  resolveApprovalSubjects,
  type ApprovalSubjectDetail,
} from "../../../lib/approval-subjects";
import { pgTextArrayLiteral } from "../../../lib/pg-array";
import { subsidiaryVisibleFilter } from "../../../lib/subsidiaries";
import { formatCivilDate } from "../../../lib/format";
import { formatDecimal } from "../../../lib/money-format";
import {
  FLOW_SUBJECT_LABEL_NAMESPACE,
  flowSubjectLabelKey,
} from "../../../lib/flows/subject-labels";
import type { ApprovalRow } from "./ApprovalsTable";
import type { DelegateOption } from "./GateActions";

/**
 * The approval hub, split into a loader and a spec.
 *
 * FOUR searchParam-driven tabs, on the shared subtab strip (`module-home-tabs`
 * — the same component the Purchasing route strip uses, and the only one in
 * the product):
 *
 *   • mine      — approvals I can act on (direct, role, delegated-to-me),
 *                 with counts-by-kind chips, aging, and bulk approve/reject.
 *                 The badge, the dashboard tile and get_vitals count this
 *                 same caller worklist.
 *   • tasks     — my tasks: the non-decision inbox kinds (signatures,
 *                 notices, acknowledgements) with their generic actions.
 *   • submitted — where MY submissions are: who they're pending with, since when.
 *   • all       — every pending, live approval in the organization inside the
 *                 viewer's legal-entity boundary, whatever its assignee and
 *                 whoever submitted it (flows.manage only). Each row shows its
 *                 assignee and offers Approve/Reject only when the viewer may
 *                 decide it through the native decide path; Delegate follows
 *                 the delegation rule.
 *
 * `tasks` IS A TAB and not a panel. It used to render as a titled panel
 * stacked under the approvals table, so one page showed two unrelated
 * worklists down the screen with no way to see either on its own. A second
 * list under the first is a tab; it is never a second section.
 *
 * `all` is gated on `flows.manage` in the LOADER, before the query runs — an
 * unauthorized `?tab=all` falls back to `mine` rather than rendering an empty
 * org-wide list, which would still leak that the tab exists.
 *
 * The body is wrapped in `TabContent`, which is a component rather than a div,
 * so this is the first page to use a `frame`: a named host wrapper with
 * spec-authored children.
 */

type Tab = "mine" | "tasks" | "submitted" | "all";

/**
 * Task-list filters. `approvals` is gone as a filter: the union table is now
 * reached by the tab, so a filter that meant "hide the tasks below the table"
 * has nothing left to hide.
 */
type InboxFilter = "all" | "my_tasks" | "signatures" | "notices" | "overdue";

const INBOX_FILTERS: readonly InboxFilter[] = [
  "all",
  "my_tasks",
  "signatures",
  "notices",
  "overdue",
];

// Document kinds offered as Submitted-by-me kind filters.
const KIND_KEYS = [
  "vendor_bill",
  "customer_invoice",
  "expense_report",
  "journal",
  "purchase_order",
  "sales_order",
  "quote",
  "close_run",
  "budget_scenario",
  "hrm_employment_change_request",
];

export interface SubmittedListRow {
  key: string;
  documentNumber: string;
  kind: string;
  href: string | null;
  party: string | null;
  amount: string | null;
  engineName: string;
  pendingWith: string | null;
  waitingSince: string;
  waitingSinceDate: string;
  kindLabel: string;
  statusLabel: string;
  /** Withdraws the submission while it waits, for kinds whose requester may withdraw it. */
  withdrawEndpoint: string | null;
}

function iso(d: unknown): string {
  return d ? new Date(d as string | Date).toISOString() : new Date().toISOString();
}

export interface InboxTaskListRow {
  id: string;
  kindLabel: string;
  title: string;
  subtitle: string | null;
  /** "Waiting since <date>" in the viewer's locale, for items awaiting a decision. */
  waitingSinceLabel: string | null;
  dueLabel: string | null;
  priorityLabel: string | null;
  priorityTone: "rose" | "amber" | "slate";
  href: string;
  actions: {
    key: string;
    label: string;
    style: "primary" | "secondary" | "danger";
    needsReason: boolean;
  }[];
}

export interface ApprovalsData {
  title: string;
  description: string;
  delegateUsers: DelegateOption[];
  tabs: {
    key: string;
    href: string;
    label: string;
    active: boolean;
    count: number | null;
  }[];
  onSubmitted: boolean;
  submittedEmpty: boolean;
  submittedPresent: boolean;
  gatesEmpty: boolean;
  gatesPresent: boolean;
  emptySubmittedTitle: string;
  emptySubmittedDescription: string;
  emptyTitle: string;
  emptyDescription: string;
  currentParams: Record<string, string | string[] | undefined>;
  searchPlaceholder: string;
  toolbarFilters: {
    paramKey: string;
    label: string;
    allLabel: string;
    options: { value: string; label: string; count?: number }[];
  }[];
  columnDocument: string;
  columnKind: string;
  columnParty: string;
  columnAmount: string;
  columnApproval: string;
  columnPendingWith: string;
  columnWaitingSince: string;
  columnStatus: string;
  columnActions: string;
  submittedRows: SubmittedListRow[];
  approvalRows: ApprovalRow[];
  bulk: boolean;
  showAssignee: boolean;
  actionsEnabled: boolean;
  /**
   * Org-wide count of union gates awaiting ANOTHER approver for this viewer
   * (SoD-blocked) — the separate figure beside the actionable rows, never
   * folded into the tab totals.
   */
  awaitingOthers: number;
  tabKey: string;
  /** Filtered total across all union legs (drives pagination). */
  total: number;
  /** Unfiltered total (drives the mine count bubble and the empty state). */
  unfilteredTotal: number;
  page: number;
  perPage: number;
  /** Plain-string search params for pagination links. */
  paginationParams: Record<string, string>;
  /** Submitted tab: flow runs + own budgets combined total. */
  submittedTotal: number;
  /** Unified inbox filter selected through the shared toolbar dropdown. */
  filter: InboxFilter;
  /** Union table visibility: decision rows show for all/approvals/overdue. */
  showUnion: boolean;
  /** Task list (new kinds + notices) for the active filter. */
  showTasks: boolean;
  tasksPresent: boolean;
  tasksEmpty: boolean;
  taskRows: InboxTaskListRow[];
  /** Named per-source notices for the legs that refused or failed (OM-10). */
  taskNotices: string[];
  tasksEmptyTitle: string;
  tasksEmptyDescription: string;
  taskOpenLabel: string;
  taskActedLabel: string;
  taskDelegatePlaceholder: string;
}

export async function loadApprovals(
  sp: Record<string, string | string[] | undefined>,
): Promise<ApprovalsData | null> {
  const { money: formatMoney } = await getMoneyFormatter();
  const format = await getFormatter();
  const locale = await getLocale();
  const t = await getTranslations("approvals");
  const tSubjects = await getTranslations(FLOW_SUBJECT_LABEL_NAMESPACE);
  const tc = await getTranslations("common");
  const ti = await getTranslations("inbox");
  const th = await getTranslations("hrm");
  const authz = await getAuthz();
  if (!authz) return null;
  const user = authz.user;
  const orgId = user.orgId;
  const canManageFlows = can(authz, "flows.manage");
  const canSeeAll = canManageFlows;

  // The badge, the tab bubbles, and the default-tab landing come from the
  // same native counts. With no tab chosen, the inbox opens where the
  // waiting work is: My approvals when anything awaits a decision,
  // otherwise My tasks when tasks are waiting — never an "all clear" page
  // beside a badge that counts tasks.
  const ctx = await inboxContext(authz);
  const [counts, approvalFlowsConfigured] = await Promise.all([
    inboxCounts(authz, ctx),
    // Any enabled Flow whose graph carries an approval gate, for any record.
    db
      .execute<{ configured: boolean }>(
        sql`
      select exists (
        select 1 from flows
         where org_id = ${orgId} and enabled
           and exists (
             select 1 from jsonb_array_elements(coalesce(graph->'nodes', '[]'::jsonb)) as node
              where node->'data'->>'kind' = 'gate'
           )
      ) as configured`,
        "objects",
      )
      .then((result) => result[0]?.configured === true),
  ]);
  const rawTab = pickString(sp.tab);
  const tab: Tab =
    rawTab === "submitted"
      ? "submitted"
      : rawTab === "tasks"
        ? "tasks"
        : rawTab === "all" && canSeeAll
          ? "all"
          : rawTab === undefined && counts.approvals === 0 && counts.tasks > 0
            ? "tasks"
            : "mine";
  /** The two tabs the approvals union backs. */
  const onApprovals = tab === "mine" || tab === "all";
  const kindFilter = pickString(sp.kind) || undefined;
  const query = pickString(sp.q)?.trim() || undefined;
  const rawFilter = pickString(sp.filter);
  const filter: InboxFilter = (INBOX_FILTERS as readonly string[]).includes(rawFilter ?? "")
    ? (rawFilter as InboxFilter)
    : "all";
  const overdueOnly = onApprovals && filter === "overdue";

  // Server-side window shared by every tab on this page. perPage never
  // exceeds the bulk batch ceiling, so a page-scoped selection always fits
  // a single bulk request.
  const page = clamp(Number(pickString(sp.page) ?? "1"), 1, 10_000);
  const perPage = Math.min(
    clamp(Number(pickString(sp.perPage) ?? "25"), 5, 100),
    APPROVALS_BULK_BATCH_MAX,
  );
  const offset = (page - 1) * perPage;
  const prefix = offset + perPage;
  const paginationParams: Record<string, string> = {};
  for (const [key, value] of Object.entries(sp)) {
    const single = pickString(value);
    if (single != null) paginationParams[key] = single;
  }

  // Kind labels: the approvals catalog first, then the Flows subject
  // profile's record-type label (the vocabulary the Flows builder shows);
  // an unregistered kind keeps its code.
  const subjectProfileLabel = new Map(
    listFlowSubjectProfiles().map((profile) => [profile.subjectKind, flowSubjectLabelKey(profile)]),
  );
  const kindLabel = (kind: string): string => {
    if (t.has(`kinds.${kind}` as never)) return t(`kinds.${kind}` as never);
    const key = subjectProfileLabel.get(kind) ?? kind;
    return tSubjects.has(key as never) ? tSubjects(key as never) : key;
  };
  // Statuses the Submitted query returns (document, close-run and budget
  // lifecycles, plus pending_approval for non-document subjects).
  const statusLabel = (status: string): string =>
    t.has(`statuses.${status}` as never) ? t(`statuses.${status}` as never) : status;
  // Instants render in the viewer's locale and the organization's time zone
  // (the next-intl request configuration); civil dates never shift by zone.
  const viewerDay = (instant: string): string =>
    format.dateTime(new Date(instant), { dateStyle: "medium" });
  // Share quantities render as counts with their unit, in the viewer's
  // locale; a signed change keeps its sign.
  const formatQuantity = (quantity: string, signed: boolean): string =>
    t("quantity.shares", {
      count: Number(quantity),
      quantity: formatDecimal(locale, quantity, {
        signDisplay: signed ? "exceptZero" : "auto",
        maximumFractionDigits: 6,
      }),
    });

  // ---- My approvals: the caller's unified worklist -------------------------
  // The dashboard tile counts approvalWorklistForAuthz (Flows gates +
  // gateless document approvals + pending budgets); the center reads the
  // same reader so same-labeled figures tie by construction. Same doorway
  // as the tile and get_vitals: a caller who cannot approve anything sees
  // no rows rather than a forbidden error. Same doorway as the count route.
  //
  // ---- All approvals: the organization-wide oversight view ----------------
  // The same paged reader in its organization audience: every pending, live
  // item in the viewer's legal-entity boundary whatever its assignee, with
  // per-row decision capability. The tab is flows.manage-gated above, so
  // the reader never runs for a caller who cannot see it.
  const mayApprove = maySeeUnion(authz);
  // One server-side page over the union: each leg fetches its leading
  // offset+limit rows in SQL and the total/chips come from aggregates, so no
  // request ever scans a whole leg.
  const window = {
    limit: perPage,
    offset,
    kind: kindFilter,
    query,
    overdue: overdueOnly,
  };
  const unionPage =
    tab === "all"
      ? await approvalWorklistOrganizationPageForAuthz(authz, window)
      : mayApprove && tab === "mine"
        ? await approvalWorklistPageForAuthz(authz, window)
        : {
            items: [] as ApprovalWorklistItem[],
            total: 0,
            kindCounts: new Map<string, number>(),
          };
  const unified: ApprovalWorklistItem[] = unionPage.items;
  const unionTotal = unionPage.total;
  // Gates awaiting ANOTHER approver for this viewer (SoD-blocked): counted
  // separately from actionable items — My approvals keeps its headline total
  // while the awaiting rows render without decision actions under their own
  // figure in the table. The organization view marks each such row itself.
  const awaitingOthers =
    mayApprove && tab === "mine" ? await approvalWorklistAwaitingForAuthz(authz) : 0;
  // Chips ignore the kind filter, so their counts sum to the unfiltered
  // total (drives the mine bubble and the empty state).
  let unfilteredTotal = 0;
  for (const count of unionPage.kindCounts.values()) unfilteredTotal += count;

  // Flow names for the gate rows (WorklistGate carries only flowId).
  const flowIds = [...new Set(unified.flatMap((i) => (i.kind === "flow_gate" ? [i.flowId] : [])))];
  const flowNames = new Map<string, string>();
  if (flowIds.length > 0) {
    const rows = await db
      .select({ id: schema.flows.id, name: schema.flows.name })
      .from(schema.flows)
      .where(inArray(schema.flows.id, flowIds));
    for (const r of rows) flowNames.set(r.id, r.name);
  }

  // Display names for gate assignees on the organization view: the user a
  // gate names, else the role it is routed to (the union carries ids/keys).
  const assigneeIds = [
    ...new Set(
      unified.flatMap((i) =>
        i.kind === "flow_gate" && i.assigneeUserId != null ? [i.assigneeUserId] : [],
      ),
    ),
  ];
  const assigneeRoles = [
    ...new Set(
      unified.flatMap((i) =>
        i.kind === "flow_gate" && i.assigneeUserId == null && i.assigneeRole != null
          ? [i.assigneeRole]
          : [],
      ),
    ),
  ];
  const assigneeNames = new Map<string, string>();
  const roleNames = new Map<string, string>();
  if (tab === "all" && assigneeIds.length > 0) {
    const rows = await db.execute<Record<string, unknown>>(
      sql`
      select id, name from users where org_id = ${orgId} and id = any(${pgTextArrayLiteral(assigneeIds)}::uuid[])
    `,
      "objects",
    );
    for (const r of rows) assigneeNames.set(String(r.id), String(r.name));
  }
  if (tab === "all" && assigneeRoles.length > 0) {
    const rows = await db.execute<Record<string, unknown>>(
      sql`
      select key, name from app_roles where org_id = ${orgId} and key = any(${pgTextArrayLiteral(assigneeRoles)}::text[])
    `,
      "objects",
    );
    for (const r of rows) roleNames.set(String(r.key), String(r.name));
  }
  const assigneeOf = (item: ApprovalWorklistItem): string | null => {
    if (tab !== "all" || item.kind !== "flow_gate") return null;
    if (item.assigneeUserId != null) return assigneeNames.get(item.assigneeUserId) ?? null;
    return item.assigneeRole != null
      ? (roleNames.get(item.assigneeRole) ?? item.assigneeRole)
      : null;
  };

  // Subject-kind detail for flow gates (party + decision summary): one
  // batched, org-scoped read through the per-kind registry — unresolvable
  // subjects stay absent and their rows keep the id fallback.
  const subjectDetails = await resolveApprovalSubjects(
    orgId,
    unified.flatMap((item) =>
      item.kind === "flow_gate" ? [{ kind: item.subjectKind, subjectId: item.subjectId }] : [],
    ),
    th,
  );
  // Amounts a subject carries format in their own currency (the shared
  // formatter stays the org-base fallback) — one cached formatter per
  // currency on the page, never one per row.
  const subjectFormatters = new Map<string, (value: string) => string>();
  const loadSubjectFormatters = async (details: Iterable<ApprovalSubjectDetail>): Promise<void> => {
    await Promise.all(
      [
        ...new Set(
          [...details].flatMap((detail) =>
            detail.currency && !subjectFormatters.has(detail.currency) ? [detail.currency] : [],
          ),
        ),
      ].map(async (currency) => {
        subjectFormatters.set(currency, (await getMoneyFormatter(orgId, currency)).money);
      }),
    );
  };
  await loadSubjectFormatters(subjectDetails.values());
  // A subject's figure: share quantities as counts with their unit, money in
  // its own currency, both when the subject carries both.
  const formatSubjectFigure = (detail: ApprovalSubjectDetail | undefined): string | null => {
    if (!detail) return null;
    const parts = [
      detail.quantity ? formatQuantity(detail.quantity, detail.quantitySigned === true) : null,
      detail.amount
        ? ((detail.currency ? subjectFormatters.get(detail.currency) : undefined)?.(
            detail.amount,
          ) ?? formatMoney(detail.amount))
        : null,
    ].filter((part): part is string => part != null && part !== "");
    return parts.length > 0 ? parts.join(" · ") : null;
  };

  const gateToRow = (
    g: Extract<ApprovalWorklistItem, { kind: "flow_gate" }>,
    assignee: string | null,
  ): ApprovalRow => {
    const kind = g.document?.kind ?? g.subjectKind;
    // Subject-kind detail (the employee and the decision summary for
    // change requests): resolved in one batch above through the
    // per-kind registry — never inline special cases here.
    const subject = subjectDetails.get(`${g.subjectKind}:${g.subjectId}`);
    return {
      key: `gate:${g.id}`,
      gateId: g.id,
      overdue: g.escalateAt != null && new Date(g.escalateAt).getTime() < Date.now(),
      documentNumber:
        g.document?.documentNumber ?? subject?.summary ?? g.subjectLabel ?? g.subjectId.slice(0, 8),
      kind,
      // Financial-change gates name their accounting event and equity
      // gates their action (never the bare subject kind), and carry the
      // subject title, party, and figure the resolver read off the record.
      kindLabel: subject?.kindLabel ?? kindLabel(kind),
      href: g.href ?? approvalRecordHref(kind, g.subjectId),
      party: g.document?.partyName ?? subject?.partyName ?? null,
      amount: g.document
        ? formatMoney(g.document.total, { currency: g.document.currency })
        : formatSubjectFigure(subject),
      approvalTitle: g.title,
      engineName: flowNames.get(g.flowId) ?? "",
      requestedAt: iso(g.createdAt),
      assignee,
      // The caller's own worklist lists only gates that reach them; the
      // organization view resolved each row through the native gate check.
      canDecide: g.canDecide ?? true,
      // Delegate is offered exactly where delegateGate accepts it: the
      // gate's direct assignee or an organization admin.
      canDelegate: g.canDelegate === true,
      quorumAll: g.quorum === "all",
      signatureRequired: g.signatureRequired,
      // Separation-of-duties blocked for this viewer: the row renders
      // "Awaiting another approver" with no decision actions, resolved in
      // advance from the native gate check — never offered then refused.
      awaitingAnotherApprover: g.awaitingAnotherApprover === true,
    };
  };

  // Document rows link to their record drawer, where the module surface
  // decides gateless approvals; pay-run rows link to the run. Only flow
  // gates carry bulk/delegate actions (GateActions stays gate-scoped).
  const unionToRow = (item: ApprovalWorklistItem): ApprovalRow => gateToRow(item, assigneeOf(item));

  // The engine returns the window in merge order; re-sorting the bounded
  // window is a safety net, not a second paging implementation.
  const byRequestedAt = (a: ApprovalRow, b: ApprovalRow) =>
    a.requestedAt.localeCompare(b.requestedAt) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const approvalRows: ApprovalRow[] = unified.map(unionToRow).sort(byRequestedAt);
  // ---- Submitted by me ------------------------------------------------------
  // Same window as the union tabs: the flow leg pages in SQL (window total
  // via over()), the caller's own budgets ride along capped (their scope is
  // one user, same precedent as the delegate picker), and the loader merges
  // and slices the bounded inputs.
  let submittedRows: SubmittedListRow[] = [];
  let submittedTotal = 0;
  if (tab === "submitted") {
    // Whose submission a run is: a document's creator, the close run's
    // starter, and for every other subject the user whose submit started the
    // run. The subject's legal entity comes from its kind's declared scope,
    // so restricted callers see only submissions inside their entities.
    // A period close names its period with the native fiscal label.
    const closePeriodLabel = periodDisplayLabelSql(locale, "cp");
    const flowRes = await db.execute<Record<string, unknown>>(
      sql`
      select r.id as "runId", f.name as "flowName", r.subject_id as "subjectId",
             coalesce(d.document_number, case when cp.id is not null then ${closePeriodLabel} end) as "documentNumber", min(g.title) as "gateTitle",
             coalesce(d.kind, case when cr.id is not null then 'close_run' end, r.subject_kind) as kind,
             d.total, d.currency, d.subsidiary_id as "subsidiaryId", coalesce(d.status, cr.status, 'pending_approval') as "docStatus", p.display_name as "partyName",
             min(g.created_at) as "waitingSince",
             string_agg(distinct coalesce(u.name, ar.name, g.assignee_role), ', ') as "pendingWith",
             count(*) over () as "fullCount"
        from flow_runs r
        join flows f on f.id = r.flow_id and f.org_id = r.org_id
        join flow_gates g on g.run_id = r.id and g.org_id = r.org_id and g.status = 'pending'
        left join documents d on d.id = r.subject_id and d.org_id = r.org_id
        left join parties p on p.id = d.party_id and p.org_id = d.org_id
        left join close_runs cr on cr.id = r.subject_id and cr.org_id = r.org_id and r.subject_kind = 'close_run'
        left join accounting_periods cp on cp.id = cr.period_id and cp.org_id = cr.org_id
        left join users u on u.id = g.assignee_user_id and u.org_id = g.org_id
        left join app_roles ar on ar.org_id = g.org_id and ar.key = g.assignee_role and g.assignee_user_id is null
       where r.org_id = ${orgId} and r.status = 'waiting'
         and (case when d.id is not null then d.created_by
                   when cr.id is not null then cr.started_by
                   when r.trigger = 'on_submit' then r.created_by end) = ${user.id}
         ${kindFilter ? sql`and coalesce(d.kind, case when cr.id is not null then 'close_run' end, r.subject_kind) = ${kindFilter}` : sql``}
         ${
           query
             ? sql`and position(${query.toLowerCase()} in lower(concat_ws(' ',
           d.document_number, d.kind, r.subject_kind, f.name, p.display_name, cp.name, case when cp.id is not null then ${closePeriodLabel} end))) > 0`
             : sql``
         }
         ${subsidiaryVisibleFilter(flowSubjectSubsidiarySql({ kind: sql`r.subject_kind`, id: sql`r.subject_id`, org: sql`r.org_id` }), authz.allowedSubsidiaryIds)}
       group by r.id, f.name, r.subject_id, d.document_number, d.kind, d.total, d.currency,
                d.subsidiary_id, d.status, cr.id, cr.status, cp.id, p.display_name
       order by min(g.created_at), r.id
       limit ${prefix}
    `,
      "objects",
    );
    submittedTotal = Number(flowRes[0]?.fullCount ?? 0);

    // Non-document subjects name their record, party and amount through the
    // per-kind subject registry, the same one the approval rows read.
    const submittedSubjects = await resolveApprovalSubjects(
      orgId,
      flowRes.flatMap((r) =>
        r.documentNumber == null ? [{ kind: String(r.kind), subjectId: String(r.subjectId) }] : [],
      ),
      th,
    );
    await loadSubjectFormatters(submittedSubjects.values());
    submittedRows = flowRes.map((r): SubmittedListRow => {
      const kind = String(r.kind);
      const waitingSince = iso(r.waitingSince);
      const subject =
        r.documentNumber == null
          ? submittedSubjects.get(`${kind}:${String(r.subjectId)}`)
          : undefined;
      return {
        key: `run:${r.runId}`,
        documentNumber: String(
          r.documentNumber ?? subject?.summary ?? r.gateTitle ?? String(r.subjectId).slice(0, 8),
        ),
        kind,
        kindLabel: subject?.kindLabel ?? kindLabel(kind),
        href: approvalRecordHref(kind, String(r.subjectId)),
        party: (r.partyName as string | null) ?? subject?.partyName ?? null,
        amount:
          r.total != null
            ? formatMoney(
                r.total as string,
                r.currency ? { currency: String(r.currency) } : undefined,
              )
            : formatSubjectFigure(subject),
        withdrawEndpoint: subject?.withdrawEndpoint ?? null,
        engineName: String(r.flowName),
        pendingWith: (r.pendingWith as string | null) ?? null,
        waitingSince,
        waitingSinceDate: viewerDay(waitingSince),
        statusLabel: statusLabel(String(r.docStatus)),
      };
    });

    submittedTotal = Number(flowRes[0]?.fullCount ?? 0);
    submittedRows.sort(
      (a, b) =>
        a.waitingSince.localeCompare(b.waitingSince) ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
    submittedRows = submittedRows.slice(offset, offset + perPage);
  }

  // Delegate targets (row delegation + out-of-office picker).
  const usersRes = await db.execute<DelegateOption>(
    sql`
    select id, name from users
     where org_id = ${orgId} and is_active and id <> ${user.id}
     order by name limit 500
  `,
    "objects",
  );
  const delegateUsers = usersRes;

  // ---- Kind filters (mine/all tabs) -----------------------------------------
  // Counts come from the union aggregates (unfiltered by kind, sorted by code
  // so dropdown order is stable across locales); the rows arrive kind-filtered
  // from SQL, so there is deliberately no second filter here.
  const chipCounts = new Map<string, number>(
    [...unionPage.kindCounts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const visibleSubmitted = submittedRows;

  // ---- Task list (new inbox kinds + notices) ------------------------------
  // Union-owned kinds never render here (see INBOX_TASK_KINDS): decision
  // rows keep ApprovalsTable + GateActions, task rows get generic actions
  // through /api/inbox/act. One live population supplies the presentation
  // filters; native counts remain separate so a list window cannot truncate a badge.
  // One source's refusal or failure must not blank the inbox (OM-10): the
  // engine names each failed source into this collector while the healthy
  // legs still list, and the loader renders them as small named notices
  // beside the surviving rows. Keyed by kind so count and list refusals
  // cannot double-report the same source.
  const taskNoticeByKind = new Map<string, InboxSourceNotice>();
  for (const notice of counts.notices) taskNoticeByKind.set(notice.kind, notice);
  const { filters: taskFilters, notices: listNotices } = await inboxTaskFilters(
    ctx,
    tab === "tasks",
  );
  for (const notice of listNotices) taskNoticeByKind.set(notice.kind, notice);
  const tasksActive = taskFilters[filter];
  // Named per-source notices for the legs that refused or failed, in stable
  // kind order. A designed refusal keeps its remedy; an unexpected failure
  // reads as plain, localized copy naming the area and what to do (driver
  // text never reaches the notice). Sources the person holds no grant for
  // never arrive here: the engine skips them as "no work".
  const failedSourceNotices = [...taskNoticeByKind.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([kind, notice]) =>
      notice.code === "failed"
        ? ti("sourceFailed", { source: ti(`kinds.${kind}`) })
        : ti("sourceUnavailable", {
            source: ti(`kinds.${kind}`),
            reason: notice.message,
          }),
    );
  const toTaskRow = (item: InboxItem): InboxTaskListRow => ({
    id: item.id,
    kindLabel: ti(`kinds.${item.kind}`),
    title: item.title,
    subtitle: item.subtitle,
    waitingSinceLabel: item.waitingSince
      ? ti("waitingSince", { date: viewerDay(item.waitingSince) })
      : null,
    // The due business day, as a civil date in the viewer's locale.
    dueLabel: item.dueAt ? formatCivilDate(dueBusinessDay(item.dueAt, ctx.timeZone), locale) : null,
    priorityLabel:
      item.priority === "overdue"
        ? ti("priorities.overdue")
        : item.priority === "due_soon"
          ? ti("priorities.dueSoon")
          : null,
    priorityTone:
      item.priority === "overdue" ? "rose" : item.priority === "due_soon" ? "amber" : "slate",
    href: item.subjectHref,
    actions: item.actions.map((action) => ({ ...action })),
  });
  // One worklist per tab. The union table and the task list no longer share
  // a page, so neither `showUnion` nor `showTasks` reads the filter any more:
  // the filter narrows the list the tab already chose.
  const showUnion = onApprovals;
  const unionVisible = approvalRows;
  const showTasks = tab === "tasks";
  const taskRows = tasksActive
    .filter((item) => {
      if (!query) return true;
      const haystack = [item.title, item.subtitle, item.kind]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(query.toLowerCase());
    })
    .map(toTaskRow);
  // A failed source is not "all clear": the empty state stays hidden while
  // a notice names the missing area, and the list block stays mounted so
  // the notice renders even when no rows survived.
  const tasksEmpty = showTasks && taskRows.length === 0 && failedSourceNotices.length === 0;
  const filterCount = (key: InboxFilter): number => taskFilters[key].length;

  // The mine bubble is the approvals badge figure, and the badge figure is
  // the union count: gateless weeks ride the union itself, so badge, bubble,
  // and rows read one predicate and cannot disagree — on the approvals tabs
  // and on the tasks tab, where the union page stays unloaded.
  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: "mine", label: t("tabs.mine"), count: counts.approvals },
    { key: "tasks", label: ti("filters.myTasks"), count: counts.tasks },
    { key: "submitted", label: t("tabs.submitted") },
    ...(canSeeAll ? [{ key: "all" as Tab, label: t("tabs.all") }] : []),
  ];

  // The approvals filters live in the regular shared list toolbar. They used
  // to be a second row of pills under the route tabs, giving the inbox two
  // competing tab treatments and no search control.
  const kindOptions = [...chipCounts.entries()].map(([kind, count]) => ({
    value: kind,
    label: kindLabel(kind),
    count,
  }));
  const submittedKindOptions = [...new Set([...KIND_KEYS, "pay_run", "equity_action"])].map(
    (kind) => ({
      value: kind,
      label: kindLabel(kind),
    }),
  );
  const toolbarFilters =
    tab === "tasks"
      ? [
          {
            paramKey: "filter",
            label: ti("columns.task"),
            allLabel: tc("labels.all"),
            options: (["my_tasks", "signatures", "notices", "overdue"] as const).map((key) => ({
              value: key,
              label: ti(`filters.${key === "my_tasks" ? "myTasks" : key}`),
              count: filterCount(key),
            })),
          },
        ]
      : tab === "submitted"
        ? [
            {
              paramKey: "kind",
              label: t("table.kind"),
              allLabel: tc("labels.all"),
              options: submittedKindOptions,
            },
          ]
        : [
            {
              paramKey: "kind",
              label: t("table.kind"),
              allLabel: tc("labels.all"),
              options: kindOptions,
            },
            {
              paramKey: "filter",
              label: tc("labels.status"),
              allLabel: tc("labels.all"),
              options: [{ value: "overdue", label: ti("filters.overdue") }],
            },
          ];

  return {
    title: t("title"),
    description: t("description"),
    delegateUsers,
    tabs: tabs.map(({ key, label, count }) => ({
      key,
      href: `/inbox?tab=${key}`,
      label,
      active: tab === key,
      count: typeof count === "number" ? count : null,
    })),
    onSubmitted: tab === "submitted",
    submittedEmpty: tab === "submitted" && submittedTotal === 0,
    submittedPresent: tab === "submitted" && submittedTotal > 0,
    gatesEmpty: showUnion && unionVisible.length === 0,
    gatesPresent: showUnion && unionVisible.length > 0,
    emptySubmittedTitle: t("emptySubmitted.title"),
    emptySubmittedDescription: t("emptySubmitted.description"),
    emptyTitle: tab === "all" ? t("emptyAll.title") : t("empty.title"),
    // An empty approvals list in an organization with no approval Flow says
    // why nothing is ever routed here and how to change it, instead of
    // reading like an all-clear.
    emptyDescription: !approvalFlowsConfigured
      ? t("empty.noApprovalFlows")
      : tab === "all"
        ? t("emptyAll.description")
        : t("empty.description"),
    currentParams: sp,
    searchPlaceholder: tc("actions.search"),
    toolbarFilters,
    columnDocument: t("table.document"),
    columnKind: t("table.kind"),
    columnParty: tc("labels.party"),
    columnAmount: tc("labels.amount"),
    columnApproval: t("table.approval"),
    columnPendingWith: t("table.pendingWith"),
    columnWaitingSince: t("table.waitingSince"),
    columnStatus: tc("labels.status"),
    columnActions: tc("labels.actions"),
    submittedRows: visibleSubmitted,
    approvalRows: unionVisible,
    awaitingOthers,
    bulk: tab === "mine",
    showAssignee: tab === "all",
    actionsEnabled: tab === "mine" || canManageFlows,
    tabKey: tab,
    total: unionTotal,
    unfilteredTotal,
    page,
    perPage,
    paginationParams,
    submittedTotal,
    filter,
    showUnion,
    showTasks,
    tasksPresent: showTasks && (taskRows.length > 0 || failedSourceNotices.length > 0),
    tasksEmpty,
    taskRows,
    taskNotices: failedSourceNotices,
    tasksEmptyTitle: ti("emptyTitle"),
    tasksEmptyDescription: ti("emptyDescription"),
    taskOpenLabel: ti("open"),
    taskActedLabel: ti("acted"),
    taskDelegatePlaceholder: ti("delegatePlaceholder"),
  };
}

const f = ref<ApprovalsData>();
const item = field;
const rootF = rootRef<ApprovalsData>();

export function approvalsSpec(data: ApprovalsData): PageSpec {
  return page({
    route: "/inbox",
    layout: "list",
    header: [
      grid("space-y-3", [
        // The tabs are the LAST header action, the house position for the
        // shared subtab strip on every page that has one. The hub used to
        // draw its own row of tab-shaped links under the header instead —
        // same job, second implementation, different treatment from every
        // other tabbed page in the product.
        pageHeader({
          title: f("title"),
          description: f("description"),
          actionsClassName: "flex flex-wrap items-center gap-3",
          actions: [
            widget("out-of-office", { users: data.delegateUsers }),
            widget("module-home-tabs", { tabs: data.tabs }),
          ],
        }),
        widgetBlock("delegation-banner", { users: data.delegateUsers }),
        widgetBlock("list-toolbar", {
          basePath: "/inbox",
          currentParams: data.currentParams,
          search: { paramKey: "q", placeholder: data.searchPlaceholder },
          filters: data.toolbarFilters,
        }),
      ]),
    ],
    body: [
      frame(
        "tab-content",
        [
          {
            ...widgetBlock("empty-state", {
              icon: "send",
              title: data.emptySubmittedTitle,
              description: data.emptySubmittedDescription,
            }),
            when: f("submittedEmpty"),
          },
          {
            ...registeredListTable("inbox", {
              variant: "app",
              rows: f("submittedRows"),
              rowKey: item("key"),
              columns: [
                column(
                  rootF("columnDocument"),
                  widgetCell("submitted-document-cell", {
                    documentNumber: item("documentNumber"),
                    href: item("href"),
                  }),
                  { className: "font-mono text-[13px] font-semibold" },
                ),
                column(rootF("columnKind"), badge(item("kindLabel"), { variant: "secondary" })),
                column(rootF("columnParty"), text(item("party"))),
                column(rootF("columnAmount"), money(item("amount")), {
                  align: "right",
                }),
                column(
                  rootF("columnApproval"),
                  widgetCell("approval-engine-cell", {
                    name: item("engineName"),
                  }),
                ),
                column(rootF("columnPendingWith"), text(item("pendingWith"))),
                column(rootF("columnWaitingSince"), text(item("waitingSinceDate")), {
                  className: "text-slate-500 dark:text-slate-400",
                }),
                column(rootF("columnStatus"), badge(item("statusLabel"), { variant: "outline" })),
                column(
                  rootF("columnActions"),
                  widgetCell("submitted-withdraw-cell", {
                    endpoint: item("withdrawEndpoint"),
                    documentNumber: item("documentNumber"),
                  }),
                  { align: "right" },
                ),
              ],
            }),
            when: f("submittedPresent"),
          },
          {
            ...widgetBlock("approvals-pagination", {
              params: data.paginationParams,
              total: data.submittedTotal,
              page: data.page,
              perPage: data.perPage,
            }),
            when: f("submittedPresent"),
          },
          {
            ...widgetBlock("empty-state", {
              icon: "check-circle",
              title: data.emptyTitle,
              description: data.emptyDescription,
            }),
            when: f("gatesEmpty"),
          },
          {
            ...grid("space-y-3", [
              widgetBlock("approvals-table", {
                rows: data.approvalRows,
                users: data.delegateUsers,
                bulk: data.bulk,
                showAssignee: data.showAssignee,
                actionsEnabled: data.actionsEnabled,
                awaitingOthers: data.awaitingOthers,
              }),
              widgetBlock("approvals-pagination", {
                params: data.paginationParams,
                total: data.total,
                page: data.page,
                perPage: data.perPage,
              }),
            ]),
            when: f("gatesPresent"),
          },
          {
            ...widgetBlock("inbox-task-list", {
              rows: data.taskRows,
              users: data.delegateUsers,
              openLabel: data.taskOpenLabel,
              actedLabel: data.taskActedLabel,
              delegatePlaceholder: data.taskDelegatePlaceholder,
              notices: data.taskNotices,
            }),
            when: f("tasksPresent"),
          },
          {
            ...widgetBlock("empty-state", {
              icon: "check-circle",
              title: data.tasksEmptyTitle,
              description: data.tasksEmptyDescription,
            }),
            when: f("tasksEmpty"),
          },
        ],
        { tabKey: data.tabKey },
      ),
      widgetBlock("approval-request-host", {}),
    ],
  });
}
