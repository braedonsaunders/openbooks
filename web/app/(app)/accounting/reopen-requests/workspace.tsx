import Link from "next/link";
import type { ReactNode } from "react";
import { Badge, UrlDrawer } from "@openbooks/ui";
import { PagedTable } from "../../../../components/paged-table";
import { ReopenDecisionEvidence } from "../../../../components/reopen-decision-evidence";
import { mergeHref } from "../../../../lib/list-params";
import { ReopenDecision } from "./ReopenDecision";
import type { ReopenRequestsWorkspaceData } from "./view";

type Row = ReopenRequestsWorkspaceData["rows"][number];

const statusVariant = (status: unknown) =>
  status === "requested"
    ? "warning"
    : status === "approved"
      ? "success"
      : status === "rejected"
        ? "destructive"
        : "secondary";
const text = (value: unknown) => (value == null ? "—" : String(value));

export function ReopenRequestsWorkspace({ data }: { data: ReopenRequestsWorkspaceData }) {
  const hrefFor = (row: Row) =>
    mergeHref("/accounting/reopen-requests", data.sp, { request: String(row.id) });
  return (
    <>
      {data.scopedApprover ? (
        <p
          className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100"
          role="status"
        >
          {data.scopedMessage}
        </p>
      ) : (
        <PagedTable<Row>
          prepared
          source="close_reopen_requests"
          rows={data.rows}
          rowKey={(row) => String(row.id)}
          empty={data.empty}
          serverWindow={{ total: data.total, page: data.page, perPage: data.perPage }}
          basePath="/accounting/reopen-requests"
          currentParams={data.sp}
          columns={[
            {
              key: "period",
              header: data.columnLabels.period,
              cell: (row) => (
                <Link
                  className="font-medium underline-offset-2 hover:underline"
                  href={hrefFor(row) as never}
                >
                  {text(row.period)}
                </Link>
              ),
              search: (row) => text(row.period),
            },
            {
              key: "scope",
              header: data.columnLabels.scope,
              cell: (row) =>
                [row.book, row.subsidiary].filter(Boolean).map(String).join(" · ") || "—",
            },
            {
              key: "modules",
              header: data.columnLabels.modules,
              cell: (row) => (Array.isArray(row.modules) ? row.modules.join(", ") : "—"),
            },
            {
              key: "reason",
              header: data.columnLabels.reason,
              cell: (row) => text(row.reason),
              search: (row) => text(row.reason),
            },
            {
              key: "requestedBy",
              header: data.columnLabels.requestedBy,
              cell: (row) => text(row.requestedBy),
              search: (row) => text(row.requestedBy),
            },
            {
              key: "status",
              header: data.columnLabels.status,
              cell: (row) => (
                <Badge variant={statusVariant(row.status)}>
                  {data.statusLabels[String(row.status)] ?? text(row.status)}
                </Badge>
              ),
            },
          ]}
        />
      )}
      {data.selected ? (
        <UrlDrawer
          open
          openKey={String(data.selected.id)}
          closeHref={mergeHref("/accounting/reopen-requests", data.sp, {
            request: undefined,
            drawerReturn: undefined,
          })}
          title={text(data.selected.period)}
          description={[data.selected.book, data.selected.subsidiary]
            .filter(Boolean)
            .map(String)
            .join(" · ")}
          size="xl"
        >
          <div className="space-y-5">
            <Badge variant={statusVariant(data.selected.status)}>
              {data.statusLabels[String(data.selected.status)] ?? text(data.selected.status)}
            </Badge>
            <dl className="grid gap-3 sm:grid-cols-2">
              <Fact label={data.columnLabels.modules}>
                {Array.isArray(data.selected.modules) ? data.selected.modules.join(", ") : "—"}
              </Fact>
              <Fact label={data.columnLabels.requestedBy}>{text(data.selected.requestedBy)}</Fact>
              <Fact label={data.columnLabels.reason}>{text(data.selected.reason)}</Fact>
            </dl>
            {data.selected.status === "requested" ? (
              <ReopenDecision
                requestId={String(data.selected.id)}
                ownRequest={data.selected.requestedById === data.userId}
              />
            ) : (
              <ReopenDecisionEvidence
                source={{
                  status: data.selected.status,
                  requestedById: data.selected.requestedById,
                  approvedById: data.selected.approvedById,
                  approvedByName: data.selected.approvedBy,
                  decisionAction: data.selected.decisionAction,
                  attestation: data.selected.decisionAttestation,
                  endActorName: data.selected.endActorName,
                  endReason: data.selected.endReason,
                }}
              />
            )}
          </div>
        </UrlDrawer>
      ) : null}
    </>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}
