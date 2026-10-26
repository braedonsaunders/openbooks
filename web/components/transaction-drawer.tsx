"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { ChevronDown } from "lucide-react";
import { Button, Popover, UrlDrawer, useMenuTrigger } from "@openbooks/ui";
import { AttachmentPanel } from "./attachment-panel";
import { AuditTrailPanel } from "./audit-trail-panel";
import { DrawerTabStrip } from "./drawer-tab-strip";
import { menuArrowKeys } from "./menu-a11y";

export interface TransactionDrawerProps {
  stacked?: boolean;
  closeHref: string;
  /** Optional guard for unsaved edits, forwarded to the UrlDrawer shell. */
  beforeClose?: () => boolean | Promise<boolean>;
  recordId: string;
  title: ReactNode;
  description?: ReactNode;
  /** Shown before the heading — the record's photo or logo. */
  leading?: ReactNode;
  panelClassName?: string;
  primaryAction?: ReactNode;
  actions?: ReactNode;
  actionsMenuHeader?: ReactNode;
  /** Record-specific work areas inserted between Details and Attachments. */
  detailTabs?: { key: string; label: ReactNode; content?: ReactNode }[];
  /**
   * Rename the leading Details tab. Records whose body already reads as a
   * named section ("Overview" on a party) pass their own word so the rail
   * carries ONE vocabulary instead of a generic Details wrapping a second,
   * record-specific strip underneath it.
   */
  detailsLabel?: ReactNode;
  /**
   * Keep `children` mounted (hidden) while Attachments or Audit trail is
   * showing, instead of unmounting the record body.
   *
   * For a record whose body holds unsaved local state — the party flyout's
   * employee compensation panels — unmounting discards those
   * edits silently. That was survivable while Attachments sat on a separate
   * strip most users never touched mid-edit; once it is a peer tab on the
   * one rail, it is one click away from any field.
   */
  keepChildrenMounted?: boolean;
  /** Retain all or named record panels after their first visit; unvisited panels stay lazy. */
  keepRecordTabsMounted?: boolean | readonly string[];
  /**
   * Mount all available panels when the drawer opens, including evidence.
   * Retain their data and local state while the operator switches tabs.
   */
  mountAllRecordTabs?: boolean;
  /** Changing this value reloads audit history after a record save. */
  auditRefreshKey?: string | number | object;
  /** Optional controlled tab state for record bodies that render tab-specific content themselves. */
  activeTab?: string;
  onActiveTabChange?: (key: string) => void;
  footer?: ReactNode;
  children: ReactNode;
  canEditAttachments?: boolean;
  /**
   * Detach affordance independent of uploading. Records whose evidence the
   * server retains (posted documents) hide Remove and name the retention;
   * uploading stays available. Defaults to canEditAttachments.
   */
  canRemoveAttachments?: boolean;
  /** Persistence table for attachments and audit rows. Defaults to documents. */
  targetTable?:
    | "documents"
    | "parties"
    | "item_rate_versions"
    | "hrm_benefit_enrollments"
    | "hrm_benefit_programs"
    | "hrm_benefit_plans"
    | "entitlement_plans";
  /**
   * Hide the Attachments and Audit trail tabs. Unsaved-create drawers set
   * this: both panels read the persisted row the drawer has not written yet,
   * so mounting them would only probe the API with an empty record id.
   * Defaults to true.
   */
  showEvidenceTabs?: boolean;
  /** Records without attachment storage retain Audit trail without an unsupported upload surface. */
  showAttachments?: boolean;
}

const TransactionDrawerContext = createContext<
  ((props: TransactionDrawerProps | null) => void) | null
>(null);

/** Keep the shared shell mounted while an asynchronously loaded record supplies its body and controls. */
export function TransactionDrawerHost({
  pending,
  children,
}: {
  pending: TransactionDrawerProps;
  children?: ReactNode;
}) {
  const [record, setRecord] = useState<TransactionDrawerProps | null>(null);
  const register = useCallback((props: TransactionDrawerProps | null) => setRecord(props), []);
  return (
    <>
      <TransactionDrawerContext.Provider value={register}>
        {children}
      </TransactionDrawerContext.Provider>
      <TransactionDrawerFrame {...(record ?? pending)} />
    </>
  );
}

/** Shared transaction chrome, with primary lifecycle controls and the standard Actions menu. */
export function TransactionDrawer(props: TransactionDrawerProps) {
  const host = useContext(TransactionDrawerContext);
  const register = props.stacked ? null : host;
  useLayoutEffect(() => {
    if (!register) return;
    register(props);
    return () => register(null);
  }, [register, props]);
  return register ? null : <TransactionDrawerFrame {...props} />;
}

function TransactionDrawerFrame({
  closeHref,
  stacked = false,
  beforeClose,
  recordId,
  title,
  description,
  leading,
  panelClassName,
  primaryAction,
  actions,
  actionsMenuHeader,
  detailTabs = [],
  detailsLabel,
  keepChildrenMounted = false,
  keepRecordTabsMounted = false,
  mountAllRecordTabs = false,
  auditRefreshKey,
  activeTab: controlledActiveTab,
  onActiveTabChange,
  footer,
  children,
  canEditAttachments = false,
  canRemoveAttachments,
  targetTable = "documents",
  showEvidenceTabs = true,
  showAttachments = true,
}: TransactionDrawerProps) {
  const t = useTranslations("common");
  const searchParams = useSearchParams();
  const [actionsOpen, setActionsOpen] = useState(false);
  const tabs = [
    { key: "details", label: detailsLabel ?? t("auditTrail.tabs.details") },
    ...detailTabs.map((tab) => ({ key: tab.key, label: tab.label })),
    ...(showEvidenceTabs
      ? [
          ...(showAttachments
            ? [{ key: "attachments", label: t("auditTrail.tabs.attachments") }]
            : []),
          { key: "audit", label: t("auditTrail.tabs.audit") },
        ]
      : []),
  ];
  // Tab is client-local state (seeded once from the URL for deep-linking). Switching
  // tabs must NOT navigate: a router.replace re-runs the server page and remounts the
  // flyout (it visibly closes and reopens). The drawer is keyed per record upstream,
  // so this re-seeds correctly when a different record opens.
  const requestedTab = searchParams.get("transactionTab");
  const [localActiveTab, setLocalActiveTab] = useState(() =>
    ["attachments", "audit", ...detailTabs.map((d) => d.key)].includes(requestedTab ?? "")
      ? requestedTab!
      : "details",
  );
  const requestedActiveTab = controlledActiveTab ?? localActiveTab;
  // A hidden evidence tab must never stay selected: without a persisted
  // record there is nothing for those panels to read.
  const activeTab =
    (!showAttachments && requestedActiveTab === "attachments") ||
    (!showEvidenceTabs && (requestedActiveTab === "attachments" || requestedActiveTab === "audit"))
      ? "details"
      : requestedActiveTab;
  const [visitedRecordTabs, setVisitedRecordTabs] = useState(() => ({
    recordId,
    keys: new Set([activeTab]),
  }));
  // Retention protects a visited draft. It must not start another panel's
  // reads before the operator opens that work area.
  if (visitedRecordTabs.recordId !== recordId) {
    setVisitedRecordTabs({ recordId, keys: new Set([activeTab]) });
  } else if (keepRecordTabsMounted && !visitedRecordTabs.keys.has(activeTab)) {
    setVisitedRecordTabs({ recordId, keys: new Set([...visitedRecordTabs.keys, activeTab]) });
  }
  const shouldMountRecordTab = (key: string) =>
    mountAllRecordTabs === true ||
    activeTab === key ||
    (visitedRecordTabs.keys.has(key) &&
      (keepRecordTabsMounted === true ||
        (Array.isArray(keepRecordTabsMounted) && keepRecordTabsMounted.includes(key))));
  // The button renders whenever callers pass an actions slot; whether the
  // slot holds a visible entry is each record's own contract (an approved
  // bill's empty popover is fixed per record, not here). The trigger itself
  // answers the pointer release as well as the click, so a press whose
  // release never becomes a click still opens the menu.
  const hasActions = actions != null || actionsMenuHeader != null;
  const actionsTrigger = useMenuTrigger(() => setActionsOpen(true));
  // Entries are per-record buttons and links (fragments, conditionals and
  // composed controls included), so the shared shell exposes them as
  // menuitems centrally: every record inherits the menu contract without
  // repeating it. Nodes that already declare a role keep their own. The
  // panel measures its trigger after opening, so it mounts a commit after
  // the menu opens — the callback ref re-runs the pass once it exists.
  const [actionsMenuNode, setActionsMenuNode] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!actionsOpen || !actionsMenuNode) return;
    for (const entry of actionsMenuNode.querySelectorAll("a[href],button:not([disabled])")) {
      if (!entry.hasAttribute("role")) entry.setAttribute("role", "menuitem");
    }
  }, [actionsOpen, actions, actionsMenuNode]);
  const requestedReturn = searchParams.get("drawerReturn");
  const nestedReturn =
    requestedReturn?.startsWith("/") && !requestedReturn.startsWith("//") ? requestedReturn : null;

  return (
    <UrlDrawer
      open
      closeHref={nestedReturn ?? closeHref}
      beforeClose={beforeClose}
      stacked={
        stacked ||
        (nestedReturn != null &&
          (searchParams.has("relatedParty") ||
            searchParams.has("reportRecord") ||
            searchParams.has("projectTxn")))
      }
      size="2xl"
      panelClassName={panelClassName}
      title={title}
      description={description}
      leading={leading}
      subtabs={
        <DrawerTabStrip
          tabs={tabs}
          activeKey={activeTab}
          onSelect={(key) => {
            setLocalActiveTab(key);
            onActiveTabChange?.(key);
          }}
          ariaLabel={t("auditTrail.ariaLabel")}
        />
      }
      headerActions={
        primaryAction != null || hasActions ? (
          <div className="flex items-center gap-1.5">
            {primaryAction}
            {hasActions ? (
              <Popover
                open={actionsOpen}
                onOpenChange={setActionsOpen}
                align="end"
                trigger={
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5 px-2.5 text-xs"
                    {...actionsTrigger}
                    aria-expanded={actionsOpen}
                    aria-haspopup="menu"
                  >
                    {t("labels.actions")}
                    <ChevronDown
                      className={`h-3.5 w-3.5 transition-transform ${actionsOpen ? "rotate-180" : ""}`}
                      aria-hidden
                    />
                  </Button>
                }
                className="w-64 p-1.5"
              >
                {actionsMenuHeader}
                <div
                  ref={setActionsMenuNode}
                  role="menu"
                  aria-label={t("labels.actions")}
                  onKeyDown={menuArrowKeys}
                  className="space-y-0.5 [&_a]:!h-8 [&_a]:w-full [&_a]:!justify-start [&_a]:!rounded [&_a]:!border-0 [&_a]:!bg-transparent [&_a]:!px-2 [&_a]:!text-xs [&_a]:!text-slate-700 [&_a]:!shadow-none [&_a:hover]:!bg-slate-100 dark:[&_a]:!text-slate-200 dark:[&_a:hover]:!bg-slate-800 [&_button]:!h-8 [&_button]:w-full [&_button]:!justify-start [&_button]:!rounded [&_button]:!border-0 [&_button]:!bg-transparent [&_button]:!px-2 [&_button]:!text-xs [&_button]:!text-slate-700 [&_button]:!shadow-none [&_button:hover]:!bg-slate-100 [&_button:disabled]:!text-slate-300 dark:[&_button]:!text-slate-200 dark:[&_button:hover]:!bg-slate-800 dark:[&_button:disabled]:!text-slate-600 [&_button.text-red-600]:!text-red-600 dark:[&_button.text-red-600]:!text-red-400"
                >
                  {actions}
                </div>
              </Popover>
            ) : null}
          </div>
        ) : undefined
      }
      footer={activeTab !== "attachments" && activeTab !== "audit" ? footer : undefined}
    >
      {keepRecordTabsMounted || mountAllRecordTabs ? (
        <>
          <div hidden={activeTab !== "details"}>{children}</div>
          {detailTabs.map((tab) =>
            shouldMountRecordTab(tab.key) ? (
              <div key={tab.key} hidden={activeTab !== tab.key}>
                {tab.content}
              </div>
            ) : null,
          )}
          {mountAllRecordTabs ? (
            <>
              {showEvidenceTabs && showAttachments ? (
                <div key={`attachments:${recordId}`} hidden={activeTab !== "attachments"}>
                  <AttachmentPanel
                    targetTable={targetTable}
                    targetId={recordId}
                    canEdit={canEditAttachments}
                    canRemove={canRemoveAttachments}
                  />
                </div>
              ) : null}
              {showEvidenceTabs ? (
                <div key={`audit:${recordId}`} hidden={activeTab !== "audit"}>
                  <AuditTrailPanel
                    table={targetTable}
                    recordId={recordId}
                    refreshKey={auditRefreshKey}
                  />
                </div>
              ) : null}
            </>
          ) : activeTab === "attachments" ? (
            <AttachmentPanel
              targetTable={targetTable}
              targetId={recordId}
              canEdit={canEditAttachments}
              canRemove={canRemoveAttachments}
            />
          ) : activeTab === "audit" ? (
            <AuditTrailPanel table={targetTable} recordId={recordId} refreshKey={auditRefreshKey} />
          ) : null}
        </>
      ) : activeTab === "attachments" || activeTab === "audit" ? (
        <>
          {keepChildrenMounted ? <div hidden>{children}</div> : null}
          {activeTab === "attachments" ? (
            <AttachmentPanel
              targetTable={targetTable}
              targetId={recordId}
              canEdit={canEditAttachments}
              canRemove={canRemoveAttachments}
            />
          ) : (
            <AuditTrailPanel table={targetTable} recordId={recordId} refreshKey={auditRefreshKey} />
          )}
        </>
      ) : activeTab === "details" ? (
        children
      ) : (
        (detailTabs.find((tab) => tab.key === activeTab)?.content ?? children)
      )}
    </UrlDrawer>
  );
}
