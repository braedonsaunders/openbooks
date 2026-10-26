import "server-only";

import { getTranslations } from "next-intl/server";
import {
  column,
  field,
  page,
  pageHeader,
  ref,
  rootRef,
  text,
  txn,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { db } from "@openbooks/engine/platform/db";
import { openDocumentSegmentViolations } from "@openbooks/engine/organization/segment-dependencies";
import { registeredListTable } from "../../../../../lib/list/prepared-spec";
import { requirePermission } from "../../../../../lib/authz";
import { requireFeatureEnabled } from "../../../../../lib/feature-gates";

/**
 * Open documents (draft, awaiting approval, approved) whose lines break a
 * segment value dependency effective on their document date — the work list
 * after a rule is added or tightened. Posted documents are history and are
 * never listed.
 */

export interface SegmentDependencyExceptionsData {
  title: string;
  description: string;
  emptyTitle: string;
  isEmpty: boolean;
  hasRows: boolean;
  columnDocument: string;
  columnDate: string;
  columnStatus: string;
  columnLine: string;
  columnProblem: string;
  rows: {
    key: string;
    documentNumber: string;
    documentDate: string;
    status: string;
    line: string;
    message: string;
    txn: { kind: "transaction"; entryId: string; docId: string; docKind: string };
  }[];
}

export async function loadSegmentDependencyExceptions(): Promise<SegmentDependencyExceptionsData> {
  const authz = await requirePermission("admin.setup.manage");
  await requireFeatureEnabled(authz.user.orgId, "segmentDependencies");
  const t = await getTranslations("admin");
  const result = await openDocumentSegmentViolations(db, authz.user.orgId, {
    limit: 1000,
    offset: 0,
    allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
  });
  return {
    title: t("setup.segmentDependencies.title"),
    description: t("setup.segmentDependencies.description", { count: result.total }),
    emptyTitle: t("setup.segmentDependencies.empty"),
    isEmpty: result.rows.length === 0,
    hasRows: result.rows.length > 0,
    columnDocument: t("setup.segmentDependencies.columns.document"),
    columnDate: t("setup.segmentDependencies.columns.date"),
    columnStatus: t("setup.segmentDependencies.columns.status"),
    columnLine: t("setup.segmentDependencies.columns.line"),
    columnProblem: t("setup.segmentDependencies.columns.problem"),
    rows: result.rows.map((row, index) => ({
      key: `${row.documentId}:${row.lineNumber}:${index}`,
      documentNumber: row.documentNumber,
      documentDate: row.documentDate,
      status: row.status.replaceAll("_", " "),
      line: String(row.lineNumber),
      message: row.message,
      // A document-backed link: no posted entry exists yet, so the entry id is the document's.
      txn: {
        kind: "transaction",
        entryId: row.documentId,
        docId: row.documentId,
        docKind: row.kind,
      },
    })),
  };
}

const f = ref<SegmentDependencyExceptionsData>();
const item = field;
const rootF = rootRef<SegmentDependencyExceptionsData>();

export function segmentDependencyExceptionsSpec(data: SegmentDependencyExceptionsData): PageSpec {
  return page({
    route: "/admin/setup/segment-dependencies",
    layout: "list",
    header: [pageHeader({ title: f("title"), description: f("description") })],
    body: [
      {
        ...widgetBlock("empty-state", { title: data.emptyTitle, action: null }),
        when: f("isEmpty"),
      },
      {
        ...registeredListTable("segment_dependency_violations", {
          variant: "app",
          rows: f("rows"),
          rowKey: item("key"),
          columns: [
            column(rootF("columnDocument"), txn(item("txn"), text(item("documentNumber")))),
            column(rootF("columnDate"), text(item("documentDate"))),
            column(rootF("columnStatus"), text(item("status"))),
            column(rootF("columnLine"), text(item("line")), { align: "right" }),
            column(rootF("columnProblem"), text(item("message"))),
          ],
        }),
        when: f("hasRows"),
      },
    ],
  });
}
