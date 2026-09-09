import { Mail } from "lucide-react";
import {
  Badge,
  EmptyState,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@openbooks/ui";
import { FilterChips } from "../../../../components/filter-bar";
import { Pagination } from "../../../../components/pagination";
import { ListPageLayout } from "../../../../components/page-layout";
import { SearchInput } from "../../../../components/search-input";
import { SortTh } from "../../../../components/sortable-th";
import { parseListParams, pickString } from "../../../../lib/list-params";
import {
  platformEmails,
  type PlatformEmail,
} from "../../../../lib/platform-admin";

export const dynamic = "force-dynamic";

const BASE = "/platform/email-log";
const SORTS = [
  "created",
  "organization",
  "recipient",
  "subject",
  "status",
] as const;
const STATUSES: PlatformEmail["status"][] = [
  "queued",
  "sent",
  "failed",
  "suppressed",
  "uncertain",
];

function formatDate(value: string | Date | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function statusVariant(
  status: PlatformEmail["status"],
): "success" | "destructive" | "warning" | "secondary" {
  if (status === "sent") return "success";
  if (status === "failed") return "destructive";
  if (status === "queued") return "warning";
  // Uncertain: the provider may have accepted the message — needs operator
  // reconciliation before anything is re-sent. Show it as an alert, not a
  // silent failure.
  if (status === "uncertain") return "warning";
  return "secondary";
}

export default async function PlatformEmailLogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const statusParam = pickString(sp.status);
  const status = STATUSES.includes(statusParam as PlatformEmail["status"])
    ? (statusParam as PlatformEmail["status"])
    : undefined;
  const params = parseListParams(sp, {
    sort: "created",
    dir: "desc",
    perPage: 25,
    allowedSorts: SORTS,
  });
  const result = await platformEmails({ ...params, status });

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            back={{ href: "/platform", label: "Super Admin" }}
            title="Email log"
            description="Cross-organization evidence for queued, sent, failed, suppressed, and uncertain email."
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder="Search subject, recipient, provider, or organization…" />
            <FilterChips
              basePath={BASE}
              currentParams={sp}
              paramKey="status"
              label="Status"
              options={STATUSES.map((value) => ({
                value,
                label: value.charAt(0).toUpperCase() + value.slice(1),
                count: result.statusCounts[value] ?? 0,
              }))}
            />
          </div>
        </>
      }
    >
      {result.rows.length === 0 ? (
        <EmptyState
          icon={<Mail />}
          title="No email events found"
          description="Try broadening the search or status filter."
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <Table>
            <TableHeader>
              <TableRow>
                <SortTh
                  basePath={BASE}
                  currentParams={sp}
                  column="created"
                  sort={params.sort}
                  dir={params.dir}
                >
                  Created
                </SortTh>
                <SortTh
                  basePath={BASE}
                  currentParams={sp}
                  column="organization"
                  sort={params.sort}
                  dir={params.dir}
                >
                  Organization
                </SortTh>
                <SortTh
                  basePath={BASE}
                  currentParams={sp}
                  column="recipient"
                  sort={params.sort}
                  dir={params.dir}
                >
                  Recipient
                </SortTh>
                <SortTh
                  basePath={BASE}
                  currentParams={sp}
                  column="subject"
                  sort={params.sort}
                  dir={params.dir}
                >
                  Subject
                </SortTh>
                <SortTh
                  basePath={BASE}
                  currentParams={sp}
                  column="status"
                  sort={params.sort}
                  dir={params.dir}
                >
                  Status
                </SortTh>
                <TableHead>Evidence</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.rows.map((email) => (
                <TableRow key={email.id}>
                  <TableCell className="whitespace-nowrap text-sm">
                    {formatDate(email.createdAt)}
                  </TableCell>
                  <TableCell className="font-medium">{email.orgName}</TableCell>
                  <TableCell>
                    {email.recipientPrimary ||
                      email.recipients.join(", ") ||
                      "—"}
                  </TableCell>
                  <TableCell>
                    <div className="max-w-md truncate font-medium">
                      {email.subject}
                    </div>
                    {email.categoryKey ? (
                      <div className="text-xs text-slate-500">
                        {email.categoryKey}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(email.status)}>
                      {email.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="text-xs text-slate-500">
                      {email.provider || "provider not recorded"} ·{" "}
                      {email.sentAt
                        ? `sent ${formatDate(email.sentAt)}`
                        : "not sent"}
                    </div>
                    {email.errorMessage ? (
                      <div className="mt-1 max-w-sm break-words text-xs text-red-600 dark:text-red-400">
                        {email.errorMessage}
                      </div>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pagination
            basePath={BASE}
            currentParams={sp}
            total={result.total}
            page={params.page}
            perPage={params.perPage}
          />
        </div>
      )}
    </ListPageLayout>
  );
}
