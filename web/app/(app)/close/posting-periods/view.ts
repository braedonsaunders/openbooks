import "server-only";

import { sql } from "drizzle-orm";
import { getLocale, getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { db } from "@openbooks/engine/platform/db";
import {
  previewPostingPeriodAssignment,
  PostingPeriodAssignmentError,
} from "@openbooks/engine/close/posting-periods";
import { CloseError } from "@openbooks/engine/periods/period-policy";
import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type WidgetRef,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { can, requirePermission } from "../../../../lib/authz";
import { guardCloseScope } from "../../../../lib/close-scope";
import { requireFeatureEnabled } from "../../../../lib/feature-gates";
import { pickString } from "../../../../lib/list-params";
import { labelPostingPeriodCandidates } from "../../../../lib/close/period-labels";
import { resolvePostingPeriodsBookId, type PostingPeriodBook } from "./books";

const BASE = "/close/posting-periods";

export interface PostingPeriodsData {
  title: string;
  description: string;
  currentParams: Record<string, string | string[] | undefined>;
  bookLabel: string;
  bookOptions: { value: string; label: string }[];
  selectedBookId: string;
  showBookChips: boolean;
  showSingleBook: boolean;
  singleBookName: string;
  runId: string | null;
  canManageBooks: boolean;
  manageBooksLabel: string;
  backLabel: string;
  canPreview: boolean;
  previewRows: Awaited<ReturnType<typeof previewPostingPeriodAssignment>>["rows"] | null;
  previewError: string | null;
}

export async function loadPostingPeriods(
  sp: Record<string, string | string[] | undefined>,
): Promise<PostingPeriodsData> {
  const authz = await requirePermission("close.read");
  if (guardCloseScope(authz)) notFound();
  const { orgId } = authz.user;
  await requireFeatureEnabled(orgId, "continuousClose");

  const [t, books] = await Promise.all([
    getTranslations("close"),
    db.execute<PostingPeriodBook>(
      sql`
      select id, name, is_primary
        from accounting_books
       where org_id = ${orgId} and is_active
       order by is_primary desc, name
    `,
      "objects",
    ),
  ]);
  const selectedBookId = resolvePostingPeriodsBookId(books, pickString(sp.book));
  const canRun = can(authz, "close.run");
  const subsidiaryIds =
    authz.allowedSubsidiaryIds === null ? null : [...authz.allowedSubsidiaryIds];
  const canPreview = canRun && (subsidiaryIds === null || subsidiaryIds.length > 0);
  let previewRows: PostingPeriodsData["previewRows"] = null;
  let previewError: string | null = null;
  if (selectedBookId && canPreview) {
    try {
      const preview = await previewPostingPeriodAssignment(orgId, {
        bookId: selectedBookId,
        subsidiaryIds,
      });
      previewRows = labelPostingPeriodCandidates(preview.rows, await getLocale());
    } catch (error) {
      if (!(error instanceof PostingPeriodAssignmentError || error instanceof CloseError))
        throw error;
      previewError = error.message;
    }
  }

  return {
    title: t("postingPeriods.title"),
    description: t("postingPeriods.description"),
    currentParams: sp,
    bookLabel: t("filters.book"),
    bookOptions: books.map((book) => ({ value: book.id, label: book.name })),
    selectedBookId,
    showBookChips: books.length > 1,
    showSingleBook: books.length === 1,
    singleBookName: books[0]?.name ?? "",
    runId: pickString(sp.run) ?? null,
    canManageBooks: can(authz, "admin.setup.manage"),
    manageBooksLabel: t("actions.manageBooks"),
    backLabel: t("postingPeriods.backToClose"),
    canPreview,
    previewRows,
    previewError,
  };
}

const f = ref<PostingPeriodsData>();

export function postingPeriodsSpec(data: PostingPeriodsData): PageSpec {
  const actions: WidgetRef[] = [];
  if (data.showBookChips) {
    actions.push(
      widget("filter-chips", {
        basePath: BASE,
        currentParams: data.currentParams,
        paramKey: "book",
        label: data.bookLabel,
        hideAll: true,
        defaultValue: data.selectedBookId,
        options: data.bookOptions,
      }),
    );
  }
  if (data.showSingleBook) {
    actions.push(
      widget("single-book-label", {
        label: data.bookLabel,
        name: data.singleBookName,
      }),
    );
  }
  if (data.canManageBooks && data.bookOptions.length === 0) {
    actions.push(
      widget("manage-books-button", {
        href: "/admin/setup/accounting-books",
        label: data.manageBooksLabel,
      }),
    );
  }
  if (data.runId) {
    actions.push(
      widget("link-button", {
        href: `/close?run=${encodeURIComponent(data.runId)}`,
        label: data.backLabel,
        variant: "outline",
        size: "sm",
      }),
    );
  }

  return page({
    route: "/close/posting-periods",
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actions,
        actionsClassName: "flex flex-wrap items-center gap-2",
      }),
    ],
    body: [
      widgetBlock("close-posting-periods-workspace", {
        bookId: f("selectedBookId"),
        runId: f("runId"),
        canManageBooks: f("canManageBooks"),
        manageBooksLabel: f("manageBooksLabel"),
        canPreview: f("canPreview"),
        initialRows: f("previewRows"),
        initialError: f("previewError"),
      }),
    ],
  });
}
