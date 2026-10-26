import { isFeatureEnabled } from "@/lib/features";
import "server-only";

import { getLocale, getTranslations } from "next-intl/server";
import { headers } from "next/headers";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { businessToday } from "@openbooks/engine/platform/business-date";
import { withScopeSnapshot } from "@openbooks/engine/organization/scope";
import { documentRevisionCounterSql } from "@openbooks/engine/records/revision";
import {
  documentCaptureOperational,
  getDocumentCaptureSettings,
} from "@openbooks/engine/payables/ap-capture-config";
import {
  DEFAULT_TRUST_STREAK,
  listInboundMessages,
  listMailboxes,
  mailboxOwnerAuthority,
  resolveAutoPostPolicy,
  vendorCaptureTrust,
} from "@openbooks/engine/payables/ap-capture-service";
import {
  badge,
  column,
  field,
  grid,
  link,
  number,
  page,
  pageHeader,
  pagination,
  ref,
  table,
  text,
  widget,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import type { ModuleHomeTab } from "../../../../components/module-home/tab-types";
import { dateTime } from "../../../../lib/format";
import { isUuid, mergeHref, parseListParams, pickString } from "../../../../lib/list-params";
import { can, requirePermission } from "../../../../lib/authz";
import { isDocKindEnabled } from "../../../../lib/documents.ts";
import type { CaptureListRow, CaptureMailbox } from "./sections";
import type {
  CaptureDetail,
  CaptureNavigation,
  CaptureAutoPostState,
  CaptureTrustState,
} from "./CaptureReviewDrawer";

/**
 * Bill capture, split into a loader and a spec.
 *
 * Two peer tabs on the shared subtab strip: the capture queue (the review
 * list and its drawer) and inbox activity (every inbound email and what
 * became of it). One concept per tab, never stacked.
 *
 * The queue list is a WIDGET, not a `table` block — see the note on
 * `CaptureList`: the native page hand-rolls selection state, per-row
 * checkboxes, and three bulk actions the spec's table vocabulary cannot name
 * (same treatment as `AdminUsersTable`). Everything around it — the header,
 * the search/filter row, the pager — is ordinary spec, and the review drawer
 * rides through a widget ref with a remount key, the same pattern as
 * `account-drawer`. The inbox activity log is read-only, so it is an
 * ordinary spec table.
 *
 * The loader applies the permission gate, the search/sort/page parsing, the
 * subsidiary scoping on both the list queries and the counts, the
 * capture-settings + global-AI resolution behind the upload button, and the
 * ?capture= flyout resolution (org guard, subsidiary guard, vendor/PO/account
 * option lists, latest-attempt evidence, list neighbours for keyboard
 * review, vendor trust and the latest auto-post decision) plus the
 * purchase-order kind check.
 */

const STATUSES = [
  "queued",
  "extracting",
  "needs_review",
  "ready",
  "duplicate",
  "failed",
  "materialized",
  "rejected",
] as const;
const SORTS = ["received", "filename", "status", "total"] as const;
const OUTCOMES = [
  "received",
  "captured",
  "rejected_sender",
  "no_attachments",
  "duplicate",
  "error",
] as const;
const OUTCOME_VARIANT: Record<
  string,
  "success" | "warning" | "destructive" | "secondary" | "outline"
> = {
  received: "secondary",
  captured: "success",
  rejected_sender: "warning",
  no_attachments: "outline",
  duplicate: "outline",
  error: "destructive",
};
const AUTO_POST_EVENTS = [
  "auto_posted",
  "auto_post_submitted",
  "auto_post_refused",
  "auto_post_skipped",
] as const;

export interface ApCaptureDrawer {
  /** Remount key: switching documents must reset the drawer's client state. */
  remountKey: string;
  initial: CaptureDetail;
  vendors: { id: string; label: string }[];
  accounts: { id: string; label: string }[];
  purchaseOrders: { id: string; label: string }[];
  canLookupPurchaseOrders: boolean;
  canCreate: boolean;
  canApprovePriceOverride: boolean;
  canPost: boolean;
  navigation: CaptureNavigation;
  trust: CaptureTrustState | null;
  autoPost: CaptureAutoPostState | null;
  attentionThreshold: string;
}

export interface InboxActivityRow {
  id: string;
  receivedLine: string;
  mailboxLabel: string;
  fromLine: string;
  subjectLine: string;
  attachmentCount: number;
  outcomeLabel: string;
  outcomeVariant: string;
  detailLine: string;
  captureHref: string;
  captureLabel: string;
}

export interface ApCaptureData {
  title: string;
  description: string;
  backHref: string;
  backLabel: string;
  currentParams: Record<string, string | string[] | undefined>;
  tabs: ModuleHomeTab[];
  onQueue: boolean;
  onInbox: boolean;
  canCreate: boolean;
  showBanner: boolean;
  notConfiguredText: string;
  showConfigureLink: boolean;
  configureHref: string;
  configureLabel: string;
  searchPlaceholder: string;
  statusLabel: string;
  statusOptions: { value: string; label: string; count: number }[];
  uploadDisabled: boolean;
  sort: string;
  dir: "asc" | "desc";
  rows: CaptureListRow[];
  mailboxes: CaptureMailbox[];
  manageMailboxesHref: string | null;
  total: number;
  currentPage: number;
  perPage: number;
  drawerOpen: boolean;
  drawer: ApCaptureDrawer | null;
  inbox: {
    rows: InboxActivityRow[];
    hasRows: boolean;
    empty: boolean;
    emptyTitle: string;
    emptyDescription: string;
    total: number;
    currentPage: number;
    perPage: number;
    columns: Record<
      | "received"
      | "address"
      | "from"
      | "subject"
      | "attachments"
      | "outcome"
      | "detail"
      | "capture",
      string
    >;
  };
}

/** The externally reachable origin for webhook URLs: the configured app URL, else this request's host. */
async function publicOrigin(): Promise<string> {
  const configured = process.env.OPENBOOKS_APP_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  const incoming = await headers();
  const host = incoming.get("x-forwarded-host") ?? incoming.get("host") ?? "localhost";
  const proto =
    incoming.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export async function loadApCapture(
  sp: Record<string, string | string[] | undefined>,
): Promise<ApCaptureData> {
  const authz = await requirePermission("ap.read");
  return withScopeSnapshot(authz.user.orgId, async () => {
    const canCreate = can(authz, "ap.create");
    // The webhook URL embeds the address token, which is the delivery
    // credential: only administrators who manage addresses receive it.
    const canManageMailboxes = can(authz, "admin.setup.manage");
    const t = await getTranslations("ap.capture");
    const ti = await getTranslations("apInbox");
    const tc = await getTranslations("common");
    const locale = await getLocale();
    const tab = pickString(sp.tab) === "inbox" ? "inbox" : "queue";
    const list = parseListParams(sp, {
      sort: "received",
      dir: "desc",
      perPage: 25,
      allowedSorts: SORTS,
    });
    const requestedStatus = pickString(sp.status);
    const status = STATUSES.includes(requestedStatus as (typeof STATUSES)[number])
      ? requestedStatus
      : undefined;
    const search = list.q ? `%${list.q.replace(/[\\%_]/g, "\\$&")}%` : null;
    const allowedSet = authz.allowedSubsidiaryIds;
    const allowed = allowedSet ? [...allowedSet] : null;
    const subsidiaryScope =
      allowed === null
        ? sql``
        : allowed.length === 0
          ? sql`and false`
          : sql`and (po.subsidiary_id is null or po.subsidiary_id in (${sql.join(
              allowed.map((id) => sql`${id}`),
              sql`, `,
            )}))
              and (vendor.subsidiary_id is null or vendor.subsidiary_id in (${sql.join(
                allowed.map((id) => sql`${id}`),
                sql`, `,
              )}))
              and (ci.subsidiary_id is null or ci.subsidiary_id in (${sql.join(
                allowed.map((id) => sql`${id}`),
                sql`, `,
              )}))`;
    const where = sql`
    ci.org_id = ${authz.user.orgId}
    ${status ? sql`and ci.status = ${status}` : sql``}
    ${
      search
        ? sql`and (ci.original_filename ilike ${search} escape '\\'
      or ci.normalized->>'vendorName' ilike ${search} escape '\\'
      or ci.normalized->>'invoiceNumber' ilike ${search} escape '\\'
      or vendor.display_name ilike ${search} escape '\\')`
        : sql``
    }
    ${subsidiaryScope}
  `;
    // The id tiebreak makes the order total, so keyboard review walks exactly
    // the rows the list shows, in the order it shows them.
    const order =
      list.sort === "filename"
        ? sql`ci.original_filename ${list.dir === "asc" ? sql`asc` : sql`desc`}, ci.id desc`
        : list.sort === "status"
          ? sql`ci.status ${list.dir === "asc" ? sql`asc` : sql`desc`}, ci.received_at desc, ci.id desc`
          : list.sort === "total"
            ? sql`nullif(ci.normalized->>'total','')::numeric ${list.dir === "asc" ? sql`asc` : sql`desc`} nulls last, ci.id desc`
            : sql`ci.received_at ${list.dir === "asc" ? sql`asc` : sql`desc`}, ci.id desc`;
    const offset = (list.page - 1) * list.perPage;
    const [rowsResult, totalResult, countsResult, providerOperational, mailboxRows] =
      await Promise.all([
        db.execute<CaptureListRow>(
          sql`
      select ci.id, ci.status, ci.original_filename as "filename", ci.document_kind as "documentKind",
             ci.normalized->>'vendorName' as "vendorName", ci.normalized->>'invoiceNumber' as "invoiceNumber",
             ci.normalized->>'invoiceDate' as "invoiceDate", ci.normalized->>'currency' as currency,
             ci.normalized->>'total' as total, ci.overall_confidence as "overallConfidence",
             ci.validation_issues as "validationIssues", ci.document_id as "documentId",
             ci.received_at as "receivedAt", vendor.display_name as "resolvedVendor", ci.source
        from ap_capture_items ci
        left join parties vendor on vendor.id = ci.vendor_candidate_id and vendor.org_id = ci.org_id
        left join documents po on po.id = ci.purchase_order_id and po.org_id = ci.org_id
       where ${where} order by ${order} limit ${list.perPage} offset ${offset}
    `,
          "objects",
        ),
        db.execute<{ n: number }>(
          sql`
      select count(*)::int as n from ap_capture_items ci
      left join parties vendor on vendor.id = ci.vendor_candidate_id and vendor.org_id = ci.org_id
      left join documents po on po.id = ci.purchase_order_id and po.org_id = ci.org_id
      where ${where}
    `,
          "objects",
        ),
        db.execute<{ status: string; n: number }>(
          sql`
      select ci.status, count(*)::int as n from ap_capture_items ci
      left join parties vendor on vendor.id = ci.vendor_candidate_id and vendor.org_id = ci.org_id
      left join documents po on po.id = ci.purchase_order_id and po.org_id = ci.org_id
       where ci.org_id = ${authz.user.orgId}
         ${subsidiaryScope}
       group by ci.status
    `,
          "objects",
        ),
        documentCaptureOperational(authz.user.orgId),
        listMailboxes(authz.user.orgId, allowedSet, { includeTokens: canManageMailboxes }),
      ]);
    const rows = rowsResult;
    const total = Number(totalResult[0]?.n ?? 0);
    const counts = new Map<string, number>(countsResult.map((row) => [row.status, Number(row.n)]));
    const activeMailboxes = mailboxRows.filter((row) => row.isActive);
    const origin = canManageMailboxes && activeMailboxes.length ? await publicOrigin() : "";
    // Each address shows whether its owner can still receive bills, by the
    // same rule the webhook applies on every delivery.
    const ownerStanding = await Promise.all(
      activeMailboxes.map((row) =>
        mailboxOwnerAuthority(db, authz.user.orgId, row.ownerId, row.subsidiaryId),
      ),
    );
    const mailboxes: CaptureMailbox[] = activeMailboxes.map((row, index) => ({
      id: row.id,
      label: row.label,
      entity: row.subsidiaryName,
      emailAddress: row.emailAddress,
      webhookUrl: canManageMailboxes && row.token ? `${origin}/api/inbound/ap/${row.token}` : null,
      ownerName: row.ownerName,
      ownerReady: ownerStanding[index]!.ok,
      canTakeOwnership: canManageMailboxes && row.ownerId !== authz.user.id,
    }));
    // Only a real capture id reaches SQL: a malformed ?capture= must never
    // bind to a uuid column and render a 500.
    const rawSelectedId = tab === "queue" ? pickString(sp.capture) : undefined;
    const selectedId = rawSelectedId && isUuid(rawSelectedId) ? rawSelectedId : undefined;
    let detail: CaptureDetail | null = null;
    let options: {
      vendors: { id: string; label: string }[];
      accounts: { id: string; label: string }[];
      purchaseOrders: { id: string; label: string }[];
    } | null = null;
    let canLookupPurchaseOrders = false;
    let navigation: CaptureNavigation = {
      listHref: mergeHref("/ap/capture", sp, { capture: undefined }),
      previousHref: null,
      nextHref: null,
      nextReviewHref: null,
    };
    let trust: CaptureTrustState | null = null;
    let autoPost: CaptureAutoPostState | null = null;
    let attentionThreshold = "0.9000";
    if (selectedId) {
      const selected = await db.execute<CaptureDetail>(
        sql`
      select ci.*, f.content_type as "contentType", f.size_bytes as "sizeBytes",
             vendor.display_name as "resolvedVendor", po.document_number as "purchaseOrderNumber",
             ${documentRevisionCounterSql(sql`ci.revision_seq`)} as "updatedAt"
        from ap_capture_items ci join files f on f.id = ci.file_id and f.org_id = ci.org_id
        left join parties vendor on vendor.id = ci.vendor_candidate_id and vendor.org_id = ci.org_id
        left join documents po on po.id = ci.purchase_order_id and po.org_id = ci.org_id
       where ci.org_id = ${authz.user.orgId} and ci.id = ${selectedId}
       ${subsidiaryScope}
    `,
        "objects",
      );
      detail = selected[0] ?? null;
      if (detail) {
        const vendorScope =
          allowed === null
            ? sql``
            : allowed.length === 0
              ? sql`and false`
              : sql`and (p.subsidiary_id is null or p.subsidiary_id in (${sql.join(
                  allowed.map((id) => sql`${id}`),
                  sql`, `,
                )}))`;
        const poScope =
          allowed === null
            ? sql``
            : allowed.length === 0
              ? sql`and false`
              : sql`and (d.subsidiary_id is null or d.subsidiary_id in (${sql.join(
                  allowed.map((id) => sql`${id}`),
                  sql`, `,
                )}))`;
        // The vendor/PO lists above are caller-scoped; the account list was
        // not: a subsidiary-A caller saw
        // subsidiary-B accounts. Org-wide rows (subsidiary_id null) stay
        // visible, exactly as for vendors and purchase orders.
        const accountScope =
          allowed === null
            ? sql``
            : allowed.length === 0
              ? sql`and false`
              : sql`and (subsidiary_id is null or subsidiary_id in (${sql.join(
                  allowed.map((id) => sql`${id}`),
                  sql`, `,
                )}))`;
        canLookupPurchaseOrders = await isDocKindEnabled(authz.user.orgId, "purchase_order");
        const [
          vendors,
          accounts,
          purchaseOrders,
          evidence,
          neighbours,
          lastAutoPost,
          settings,
          today,
        ] = await Promise.all([
          db.execute<{ id: string; label: string }>(
            sql`
          select p.id, p.display_name as label from parties p join vendor_roles vr on vr.party_id = p.id and vr.org_id = p.org_id
           where p.org_id = ${authz.user.orgId} and p.is_active and vr.is_active ${vendorScope}
           order by p.display_name limit 2000
        `,
            "objects",
          ),
          db.execute<{ id: string; label: string }>(
            sql`
          select id, concat_ws(' · ', number, name) as label from accounts
           where org_id = ${authz.user.orgId} and is_active and not is_summary ${accountScope} order by number nulls last limit 3000
        `,
            "objects",
          ),
          canLookupPurchaseOrders
            ? db.execute<{ id: string; label: string }>(
                sql`
          select d.id, d.document_number as label from documents d
           where d.org_id = ${authz.user.orgId} and d.kind = 'purchase_order' and d.status = 'approved' ${poScope}
           order by d.document_date desc limit 1000
        `,
                "objects",
              )
            : Promise.resolve([]),
          db.execute<CaptureDetail["evidence"][number]>(
            sql`
          select af.field_key as "fieldKey", af.line_index as "lineIndex", af.confidence,
                 af.page_number as "pageNumber", af.polygon
            from ap_capture_fields af join ap_capture_runs ar on ar.id = af.run_id and ar.org_id = af.org_id
           where af.org_id = ${authz.user.orgId} and ar.capture_item_id = ${selectedId}
             and ar.attempt = (select max(attempt) from ap_capture_runs where capture_item_id = ${selectedId} and org_id = ${authz.user.orgId})
        `,
            "objects",
          ),
          // The selected capture's neighbours in the list's own filter and
          // order, plus the next capture still awaiting review (wrapping to the
          // first earlier one), so review can move on without the mouse.
          db.execute<{
            previousId: string | null;
            nextId: string | null;
            nextReviewId: string | null;
          }>(
            sql`
          with ordered as (
            select ci.id, ci.status, row_number() over (order by ${order}) as pos
              from ap_capture_items ci
              left join parties vendor on vendor.id = ci.vendor_candidate_id and vendor.org_id = ci.org_id
              left join documents po on po.id = ci.purchase_order_id and po.org_id = ci.org_id
             where ${where}
          ), me as (select pos from ordered where id = ${selectedId})
          select
            (select o.id from ordered o, me where o.pos = me.pos - 1) as "previousId",
            (select o.id from ordered o, me where o.pos = me.pos + 1) as "nextId",
            coalesce(
              (select o.id from ordered o, me where o.pos > me.pos and o.status in ('ready', 'needs_review') order by o.pos limit 1),
              (select o.id from ordered o, me where o.pos < me.pos and o.status in ('ready', 'needs_review') order by o.pos limit 1)
            ) as "nextReviewId"
        `,
            "objects",
          ),
          db.execute<{ kind: string; detail: { reason?: string; message?: string } }>(
            sql`
          select event_kind as kind, detail from ap_capture_events
           where org_id = ${authz.user.orgId} and capture_item_id = ${selectedId}
             and event_kind in (${sql.join(
               AUTO_POST_EVENTS.map((kind) => sql`${kind}`),
               sql`, `,
             )})
           order by at desc limit 1
        `,
            "objects",
          ),
          getDocumentCaptureSettings(authz.user.orgId),
          businessToday(authz.user.orgId),
        ]);
        detail.evidence = evidence;
        options = {
          vendors: vendors,
          accounts: accounts,
          purchaseOrders: purchaseOrders,
        };
        const near = neighbours[0];
        const captureHref = (id: string | null | undefined) =>
          id ? mergeHref("/ap/capture", sp, { capture: id }) : null;
        navigation = {
          ...navigation,
          previousHref: captureHref(near?.previousId),
          nextHref: captureHref(near?.nextId),
          nextReviewHref: captureHref(near?.nextReviewId),
        };
        attentionThreshold = settings.confidenceThreshold;
        if (detail.vendor_candidate_id) {
          const policy = await resolveAutoPostPolicy(db, authz.user.orgId, today);
          const threshold = policy?.cleanStreak ?? DEFAULT_TRUST_STREAK;
          const vendorTrust = await vendorCaptureTrust(
            db,
            authz.user.orgId,
            detail.vendor_candidate_id,
            threshold,
            detail.id,
          );
          trust = {
            trusted: vendorTrust.trusted,
            cleanStreak: vendorTrust.cleanStreak,
            threshold,
            policyEnabled: policy?.enabled === true,
            brokenBy: vendorTrust.brokenBy?.reason ?? null,
          };
        }
        const latest = lastAutoPost[0];
        if (latest) {
          autoPost = {
            kind: latest.kind as CaptureAutoPostState["kind"],
            reason: typeof latest.detail?.reason === "string" ? latest.detail.reason : null,
            message: typeof latest.detail?.message === "string" ? latest.detail.message : null,
          };
        }
      }
    }
    const structuredInvoicesEnabled = await isFeatureEnabled(authz.user.orgId, "einvoicing");
    // Either provider (Azure or the AI model) counts, by the same rule the capture APIs use.
    const captureOperational = structuredInvoicesEnabled || providerOperational;
    const drawer: ApCaptureDrawer | null =
      detail && options
        ? {
            remountKey: String(detail.id),
            initial: detail,
            vendors: options.vendors,
            accounts: options.accounts,
            purchaseOrders: options.purchaseOrders,
            canLookupPurchaseOrders,
            canCreate,
            canApprovePriceOverride: can(authz, "ap.approve"),
            canPost: can(authz, "ap.post"),
            navigation,
            trust,
            autoPost,
            attentionThreshold,
          }
        : null;

    const inboxPage = parseListParams(sp, {
      sort: "received",
      dir: "desc",
      perPage: 50,
      allowedSorts: ["received"] as const,
    });
    const inboxRows =
      tab === "inbox"
        ? await listInboundMessages(authz.user.orgId, allowedSet, {
            limit: inboxPage.perPage,
            offset: (inboxPage.page - 1) * inboxPage.perPage,
          })
        : { rows: [], total: 0 };
    const inbox: ApCaptureData["inbox"] = {
      rows: inboxRows.rows.map((row) => {
        const outcome = OUTCOMES.includes(row.outcome as (typeof OUTCOMES)[number])
          ? row.outcome
          : "error";
        const firstCapture = row.captureItemIds?.[0];
        return {
          id: row.id,
          receivedLine: dateTime(row.receivedAt, locale),
          mailboxLabel: row.mailboxLabel,
          fromLine: row.fromAddress ?? "—",
          subjectLine: row.subject ?? "—",
          attachmentCount: Number(row.attachmentCount),
          outcomeLabel: ti(`inbox.outcomes.${outcome}`),
          outcomeVariant: OUTCOME_VARIANT[outcome] ?? "outline",
          detailLine:
            row.outcomeReason ??
            (row.captureItemIds?.length
              ? ti("inbox.capturedCount", { count: row.captureItemIds.length })
              : "—"),
          captureHref: firstCapture ? `/ap/capture?capture=${firstCapture}` : "",
          captureLabel: firstCapture ? ti("inbox.openCapture") : "",
        };
      }),
      hasRows: inboxRows.rows.length > 0,
      empty: tab === "inbox" && inboxRows.total === 0,
      emptyTitle: ti("inbox.emptyTitle"),
      emptyDescription: mailboxRows.length
        ? ti("inbox.emptyDescription")
        : ti("inbox.emptyNoMailbox"),
      total: inboxRows.total,
      currentPage: inboxPage.page,
      perPage: inboxPage.perPage,
      columns: {
        received: ti("inbox.columns.received"),
        address: ti("inbox.columns.address"),
        from: ti("inbox.columns.from"),
        subject: ti("inbox.columns.subject"),
        attachments: ti("inbox.columns.attachments"),
        outcome: ti("inbox.columns.outcome"),
        detail: ti("inbox.columns.detail"),
        capture: ti("inbox.columns.capture"),
      },
    };
    return {
      title: t("title"),
      description: t("description"),
      backHref: "/ap",
      backLabel: t("backToBills"),
      currentParams: sp,
      tabs: [
        { href: "/ap/capture", label: ti("tabs.queue"), active: tab === "queue" },
        { href: "/ap/capture?tab=inbox", label: ti("tabs.inbox"), active: tab === "inbox" },
      ],
      onQueue: tab === "queue",
      onInbox: tab === "inbox",
      canCreate,
      showBanner: !captureOperational,
      notConfiguredText: t("notConfigured"),
      showConfigureLink: can(authz, "admin.ai.manage"),
      configureHref: "/admin/ai",
      configureLabel: t("configure"),
      searchPlaceholder: t("search"),
      statusLabel: tc("labels.status"),
      statusOptions: STATUSES.map((value) => ({
        value,
        label: t(`status.${value}`),
        count: counts.get(value) ?? 0,
      })),
      uploadDisabled: !captureOperational,
      sort: list.sort,
      dir: list.dir,
      rows,
      mailboxes,
      manageMailboxesHref: can(authz, "admin.setup.manage")
        ? "/admin/setup/ap-capture-mailboxes"
        : null,
      total,
      currentPage: list.page,
      perPage: list.perPage,
      drawerOpen: Boolean(drawer),
      drawer,
      inbox,
    };
  });
}

const f = ref<ApCaptureData>();
const item = field;

export function apCaptureSpec(data: ApCaptureData): PageSpec {
  const upload = {
    widget: "capture-upload",
    props: { disabled: data.uploadDisabled },
  };
  return page({
    route: "/ap/capture",
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actionsClassName: "flex flex-wrap items-center gap-2",
        actions: [
          widget("back-link-button", { href: data.backHref, label: data.backLabel }),
          widget(upload.widget, upload.props, f("canCreate")),
          // The tabs are the last header action, the house position for the
          // shared subtab strip.
          widget("module-home-tabs", { tabs: data.tabs }),
        ],
      }),
      {
        ...grid(
          "rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300",
          [
            widgetBlock("capture-not-configured", {
              text: data.notConfiguredText,
              configureHref: data.configureHref,
              configureLabel: data.configureLabel,
              showConfigureLink: data.showConfigureLink,
            }),
          ],
        ),
        when: f("showBanner"),
      },
      {
        ...grid("flex flex-wrap gap-2", [
          widgetBlock("search-input", { placeholder: data.searchPlaceholder }),
          widgetBlock("filter-chips", {
            basePath: "/ap/capture",
            currentParams: data.currentParams,
            paramKey: "status",
            label: data.statusLabel,
            options: data.statusOptions,
          }),
        ]),
        when: f("onQueue"),
      },
    ],
    body: [
      {
        ...widgetBlock("capture-list", {
          rows: data.rows,
          mailboxes: data.mailboxes,
          manageMailboxesHref: data.manageMailboxesHref,
          currentParams: data.currentParams,
          canCreate: data.canCreate,
          uploadDisabled: data.uploadDisabled,
          sort: data.sort,
          dir: data.dir,
        }),
        when: f("onQueue"),
      },
      {
        ...pagination({
          basePath: "/ap/capture",
          total: f("total"),
          page: f("currentPage"),
          perPage: f("perPage"),
          // The native pager is unwrapped here — no `mt-3` spacer.
          bare: true,
        }),
        when: f("onQueue"),
      },
      {
        ...widgetBlock("capture-review-drawer", {
          drawer: data.drawer,
        }),
        when: f("drawerOpen"),
      },
      {
        ...widgetBlock("empty-state", {
          title: data.inbox.emptyTitle,
          description: data.inbox.emptyDescription,
        }),
        when: f("inbox.empty"),
      },
      {
        ...grid(
          "rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900",
          [
            table({
              variant: "app",
              rows: f("inbox.rows"),
              rowKey: item("id"),
              columns: [
                column(f("inbox.columns.received"), text(item("receivedLine")), {
                  className: "whitespace-nowrap text-xs text-slate-500",
                }),
                column(f("inbox.columns.address"), text(item("mailboxLabel"))),
                column(f("inbox.columns.from"), text(item("fromLine"))),
                column(f("inbox.columns.subject"), text(item("subjectLine"))),
                column(f("inbox.columns.attachments"), number(item("attachmentCount")), {
                  align: "right",
                }),
                column(
                  f("inbox.columns.outcome"),
                  badge(item("outcomeLabel"), { variant: item("outcomeVariant") }),
                ),
                column(f("inbox.columns.detail"), text(item("detailLine")), {
                  className: "text-xs text-slate-500",
                }),
                column(
                  f("inbox.columns.capture"),
                  link(item("captureLabel"), item("captureHref")),
                  { srOnlyHeader: true },
                ),
              ],
            }),
          ],
        ),
        when: f("inbox.hasRows"),
      },
      {
        ...pagination({
          basePath: "/ap/capture",
          total: f("inbox.total"),
          page: f("inbox.currentPage"),
          perPage: f("inbox.perPage"),
          bare: true,
        }),
        when: f("inbox.hasRows"),
      },
    ],
  });
}
