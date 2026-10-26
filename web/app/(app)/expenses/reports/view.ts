import "server-only";
import { sourceAmortizationOptions } from "@/lib/amortization-options";

import { getTranslations } from "next-intl/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { can } from "../../../../lib/authz";
import {
  expenseAccess,
  expenseAccessAllows,
  requireExpensePermission,
} from "../../../../lib/expense-access";
import { subsidiaryVisibleFilter } from "../../../../lib/subsidiaries";
import { requireFeatureEnabled } from "../../../../lib/feature-gates";
import { isUuid, pickString } from "../../../../lib/list-params";
import {
  blankExpenseReport,
  canRecallExpenseReport,
  loadExpenseReport,
} from "../../../../lib/expenses";
import { loadFieldDefs } from "../../../../lib/custom-fields";
import { customSegmentOptions } from "../../../../lib/segments";
import { dimensionOptions } from "../../../../lib/reports/filters";
import { resolveFormLayout } from "../../../../lib/customization/resolve";
import { taxCodeOptions, taxGroupOptions } from "../../../../lib/documents.ts";
import type { ExpenseDrawer } from "../ExpenseDrawer";

/**
 * Expense reports — the universal documents list scoped to `expense_report`,
 * split into a loader and a spec.
 *
 * The list itself (search, employee filter, status chips, saved views,
 * sortable typed table, pagination) stays one host component through the
 * shared `record-list-view` slot, which re-derives org id, user id and the
 * permission decision server-side — the ap/bills precedent. This page owns
 * only the header (title/description/new button) and the ?expense= flyout
 * with its picker + form-layout resolution, copied verbatim from page.tsx.
 *
 * Two page-specific widgets the registry does not have yet: `new-expense`
 * (a URL-only button that opens the unsaved-create drawer at
 * `?expense=new`, not the NewDocumentButton shape) and `expense-drawer`.
 *
 */

type ExpenseDrawerProps = Parameters<typeof ExpenseDrawer>[0];

export interface ExpenseReportsDrawer {
  remountKey: string;
  report: unknown;
  /** Unsaved create over a blank seed; Save is the first write. */
  createMode: boolean;
  initialMode: "edit" | "view";
  employees: unknown;
  accounts: unknown;
  cards: unknown;
  taxCodes: unknown;
  taxGroups: unknown;
  departments: unknown;
  projects: unknown;
  headerDefs: unknown;
  lineDefs: unknown;
  segments: unknown;
  canSubmit: boolean;
  canPost: boolean;
  /** The open report is recallable to draft by this viewer. */
  canRecall: boolean;
  layout: unknown;
  closeHref: string;
  amortizationTemplates?: { id: string; label: string }[];
}

export interface ExpenseReportsData {
  title: string;
  description: string;
  currentParams: Record<string, string | string[] | undefined>;
  canSubmit: boolean;
  canPost: boolean;
  newLabel: string;
  newCreatingLabel: string;
  drawerOpen: boolean;
  drawer: ExpenseReportsDrawer | null;
}

export async function loadExpenseReports(
  sp: Record<string, string | string[] | undefined>,
): Promise<ExpenseReportsData> {
  const t = await getTranslations("expenses");
  const tCommon = await getTranslations("common");
  const authz = await requireExpensePermission("read");
  await requireFeatureEnabled(authz.user.orgId, "expenses");
  // Self-service readers (expenses.self) see, create and submit only their
  // own reports; the list, this drawer, its employee picker and every
  // expense API agree on the same access.
  const [readAccess, editAccess] = await Promise.all([
    expenseAccess(authz, "read"),
    expenseAccess(authz, "edit"),
  ]);
  const canCreate =
    editAccess !== null && (editAccess.scope === "all" || editAccess.partyId !== null);
  const canPost = can(authz, "ap.post");
  const expenseId = pickString(sp.expense);

  // Flyout + pickers + form layout resolve only when a report is open.
  // `expense=new` opens the unsaved-create drawer over a blank seed: nothing
  // is numbered until its first Save. The shared reader scopes the document to
  // the caller before its correlated line query, so a foreign id yields null
  // and the drawer stays shut — same guard as the native page.
  const createRequested = expenseId === "new" && canCreate;
  const ownEmployee = editAccess?.scope === "own" ? editAccess.partyId : null;
  const openReport = createRequested
    ? await blankExpenseReport(authz.user.orgId, ownEmployee)
    : expenseId && isUuid(expenseId) && readAccess
      ? await loadExpenseReport(expenseId, authz.user.orgId, authz.allowedSubsidiaryIds, readAccess)
      : null;
  // Editing reaches the open report when the caller enters everyone's
  // reports, or enters their own and this report is theirs.
  const canSubmit =
    editAccess !== null &&
    (createRequested ||
      (openReport !== null &&
        expenseAccessAllows(
          editAccess,
          (openReport.doc as { party_id?: string | null }).party_id ?? null,
        )));
  const pickers = openReport
    ? await Promise.all([
        db.execute<{ id: string; display_name: string }>(sql`
          select p.id, p.display_name from parties p
           where p.is_active and p.org_id = ${authz.user.orgId}
             and exists (select 1 from employee_roles er where er.org_id = p.org_id and er.party_id = p.id and er.is_active)
             ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, authz.allowedSubsidiaryIds, { orgWideNull: true })}
             ${editAccess?.scope === "all" ? sql`` : sql`and p.id = ${ownEmployee}`}
           order by p.display_name`),
        db.execute<{ id: string; number: string | null; name: string }>(sql`
          select id, number, name from accounts
           where type in ('expense','expense_other','cogs') and is_active and not is_summary and org_id = ${authz.user.orgId}
             ${subsidiaryVisibleFilter(sql`subsidiary_id`, authz.allowedSubsidiaryIds, { orgWideNull: true })}
           order by number nulls last`),
        db
          .execute<{
            id: string;
            label: string;
            last_four: string | null;
            network: string | null;
            liability_account_id: string | null;
            holder: string | null;
          }>(
            sql`
          select pc.id, pc.label, pc.last_four, pc.network, pc.liability_account_id, p.display_name as holder
            from payment_cards pc
            join parties p on p.id = pc.holder_party_id and p.org_id = pc.org_id
            join accounts a on a.id = pc.liability_account_id and a.org_id = pc.org_id
           where pc.org_id = ${authz.user.orgId} and pc.is_active
             ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, authz.allowedSubsidiaryIds, { orgWideNull: true })}
             ${subsidiaryVisibleFilter(sql`a.subsidiary_id`, authz.allowedSubsidiaryIds, { orgWideNull: true })}
           order by pc.label
        `,
            "objects",
          )
          .then((r) =>
            r.map((card) => ({
              id: card.id,
              label: card.label,
              display_name: card.last_four
                ? `${card.network ?? ""} •••• ${card.last_four} — ${card.holder ?? ""}`.trim()
                : card.label,
              last_four: card.last_four,
              network: card.network,
              liability_account_id: card.liability_account_id,
            })),
          ),
        taxCodeOptions(authz.user.orgId),
        taxGroupOptions(authz.user.orgId),
        dimensionOptions(authz.user.orgId, undefined, authz.allowedSubsidiaryIds),
        loadFieldDefs("documents", "expense_report"),
        loadFieldDefs("document_lines", "expense_report"),
        customSegmentOptions(authz.user.orgId),
      ])
    : null;
  const resolvedForm =
    openReport && pickers
      ? await resolveFormLayout({
          orgId: authz.user.orgId,
          userId: authz.user.id,
          recordType: "expense_report",
          userRoles: authz.user.roles.map(({ key }) => key),
          headerDefs: pickers[6],
          lineDefs: pickers[7],
          explicitLayoutId: pickString(sp.form),
        })
      : null;

  // Recall eligibility (submitter-or-admin, void-free) is
  // shared with the related-transaction drawer; the actions route
  // re-checks authoritatively.
  const canRecall = canRecallExpenseReport(
    (openReport?.doc ?? {}) as Parameters<typeof canRecallExpenseReport>[0],
    authz.user,
  );

  const drawer: ExpenseReportsDrawer | null =
    openReport && pickers && resolvedForm
      ? {
          remountKey: createRequested
            ? "new"
            : String((openReport.doc as Record<string, unknown>).id),
          report: openReport as unknown as ExpenseDrawerProps["report"],
          createMode: createRequested,
          initialMode: createRequested || pickString(sp.mode) === "edit" ? "edit" : "view",
          amortizationTemplates: await sourceAmortizationOptions(authz.user.orgId, openReport),
          employees: (pickers[0] as { rows: unknown }).rows,
          accounts: (pickers[1] as { rows: unknown }).rows,
          cards: pickers[2] as unknown as ExpenseDrawerProps["cards"],
          taxCodes: pickers[3],
          taxGroups: pickers[4],
          departments: pickers[5].departments,
          projects: pickers[5].projects,
          headerDefs: pickers[6] as unknown as ExpenseDrawerProps["headerDefs"],
          lineDefs: pickers[7] as unknown as ExpenseDrawerProps["lineDefs"],
          segments: pickers[8] as unknown as ExpenseDrawerProps["segments"],
          canSubmit,
          canPost,
          canRecall,
          layout: resolvedForm.layout,
          closeHref: "/expenses/reports",
        }
      : null;

  return {
    title: t("list.title"),
    description: t("list.description"),
    currentParams: sp,
    canSubmit: canCreate,
    canPost,
    newLabel: t("actions.newReport"),
    newCreatingLabel: tCommon("actions.creating"),
    drawerOpen: Boolean(drawer),
    drawer,
  };
}

const f = ref<ExpenseReportsData>();

export function expenseReportsSpec(data: ExpenseReportsData): PageSpec {
  const newExpense = {
    widget: "new-expense",
    props: {
      label: data.newLabel,
      creatingLabel: data.newCreatingLabel,
    },
  };
  return page({
    route: "/expenses/reports",
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actions: [widget(newExpense.widget, newExpense.props, f("canSubmit"))],
      }),
    ],
    body: [
      // No `when`: the list always renders. `drawer`/`emptyAction` arrive as
      // null when closed/absent and their slots render nothing. The record
      // list renders the drawer itself (after the table, inside the slot) —
      // the page places nothing else here, the same arrangement the native
      // page has.
      widgetBlock("record-list-view", {
        recordType: "expense_report",
        basePath: "/expenses/reports",
        sp: data.currentParams,
        drawer: data.drawer ? { widget: "expense-drawer", props: { drawer: data.drawer } } : null,
        emptyAction: data.canSubmit ? newExpense : null,
      }),
    ],
  });
}
