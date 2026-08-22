import Link from "next/link";
import { sql } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { db } from "@openbooks/engine/src/db.ts";
import {
  Badge,
  Button,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@openbooks/ui";
import { ListPageLayout } from "../../../components/page-layout";
import { FilterChips } from "../../../components/filter-bar";
import { SearchInput } from "../../../components/search-input";
import { Pagination } from "../../../components/pagination";
import { can, requirePermission } from "../../../lib/authz";
import { currentFiscalYear } from "../../../lib/fiscal";
import { clamp, isUuid, pickString } from "../../../lib/list-params";
import { StartCloseButton } from "./StartCloseButton";
import { CloseWizard } from "./CloseWizard";
import { featureEnabled, resolvedFeatureState, subsidiaryFeatureEnabled } from "../../../lib/features";

export const dynamic = "force-dynamic";

const PER_PAGE = 20;

export default async function PeriodClose({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const authz = await requirePermission("close.read");
  const { orgId, id: actorId } = authz.user;
  const sp = await searchParams;
  const subsidiaryEnabled = await subsidiaryFeatureEnabled(orgId);
  const featureState = await resolvedFeatureState(orgId);
  const advancedClose = featureEnabled(featureState, "advancedClose");
  const runId = pickString(sp.run);
  if (runId && isUuid(runId)) {
    const [
      runRes,
      tasksRes,
      exceptionsRes,
      evidenceRes,
      signoffsRes,
      eventsRes,
      locksRes,
      historyRes,
    ] = (await Promise.all([
      db.execute(sql`
        select r.*, p.name as period_name, p.starts_on, p.ends_on, p.fiscal_year,
               b.name as book_name, b.code as book_code,
               bp.name as blueprint_name, bp.version as blueprint_version,
               pkg.name as package_name, pkg.reports as package_reports,
               starter.name as starter_name, approver.name as approver_name,
               closer.name as closer_name, publisher.name as publisher_name
          from close_runs r
          join accounting_periods p on p.id = r.period_id and p.org_id = r.org_id
          join accounting_books b on b.id = r.book_id and b.org_id = r.org_id
          join close_blueprints bp on bp.id = r.blueprint_id and bp.org_id = r.org_id
          left join close_reporting_packages pkg on pkg.id = r.reporting_package_id and pkg.org_id = r.org_id
          left join users starter on starter.id = r.started_by
          left join users approver on approver.id = r.approved_by
          left join users closer on closer.id = r.closed_by
          left join users publisher on publisher.id = r.published_by
         where r.id = ${runId} and r.org_id = ${orgId}`),
      db.execute(sql`
        select t.*, owner.name as owner_name, reviewer.name as reviewer_name,
               coalesce(jsonb_agg(distinct dep.key) filter (where dep.id is not null), '[]'::jsonb) as dependencies,
               count(distinct ev.id) as evidence_count
          from close_run_tasks t
          left join users owner on owner.id = t.owner_id
          left join users reviewer on reviewer.id = t.reviewer_id
          left join close_blueprint_dependencies d on d.step_id = t.blueprint_step_id and d.org_id = t.org_id
          left join close_run_tasks dep on dep.run_id = t.run_id and dep.blueprint_step_id = d.depends_on_step_id and dep.org_id = t.org_id
          left join close_task_evidence ev on ev.task_id = t.id and ev.org_id = t.org_id
         where t.run_id = ${runId} and t.org_id = ${orgId}
         group by t.id, owner.name, reviewer.name order by t.sort_order`),
      db.execute(
        sql`select * from close_exceptions where run_id = ${runId} and org_id = ${orgId} order by status, case severity when 'critical' then 1 when 'error' then 2 when 'warning' then 3 else 4 end, created_at`,
      ),
      db.execute(
        sql`select * from close_task_evidence where run_id = ${runId} and org_id = ${orgId} order by created_at desc`,
      ),
      db.execute(
        sql`select s.*, u.name as signed_by_name from close_signoffs s join users u on u.id = s.signed_by where s.run_id = ${runId} and s.org_id = ${orgId} order by s.signed_at desc`,
      ),
      db.execute(
        sql`select e.*, u.name as actor_name from close_events e left join users u on u.id = e.actor_id where e.run_id = ${runId} and e.org_id = ${orgId} order by e.at desc limit 100`,
      ),
      db.execute(
        sql`select * from period_locks where org_id = ${orgId} and period_id = (select period_id from close_runs where id = ${runId} and org_id = ${orgId}) and book_id = (select book_id from close_runs where id = ${runId} and org_id = ${orgId}) order by subsidiary_id nulls first, module`,
      ),
      db.execute(sql`
        select t.key,
               avg(extract(epoch from (t.completed_at - r.started_at)) / 86400.0)::numeric(10,1) as average_days
          from close_run_tasks t join close_runs r on r.id = t.run_id and r.org_id = t.org_id
         where t.org_id = ${orgId} and t.completed_at is not null and r.id <> ${runId}
         group by t.key`),
    ])) as any[];
    const run = runRes.rows[0];
    if (run) {
      const history = new Map(
        (historyRes.rows as any[]).map((row) => [
          row.key,
          Number(row.average_days),
        ]),
      );
      const tasks = (tasksRes.rows as any[]).map((task) => ({
        ...task,
        predicted_days: history.get(task.key) ?? null,
      }));
      return (
        <CloseWizard
          run={run}
          tasks={tasks}
          exceptions={exceptionsRes.rows}
          evidence={evidenceRes.rows}
          signoffs={signoffsRes.rows}
          events={eventsRes.rows}
          locks={locksRes.rows}
          stage={pickString(sp.stage)}
          canRun={can(authz, "close.run")}
          canApprove={can(authz, "close.approve")}
          canReopen={can(authz, "close.reopen")}
          canManageFlows={can(authz, "flows.manage")}
          subsidiaryEnabled={subsidiaryEnabled}
          advancedClose={advancedClose}
        />
      );
    }
  }

  const t = await getTranslations("close");
  const currentFy = await currentFiscalYear();
  const fy = Number(pickString(sp.fy) ?? currentFy);
  const status = pickString(sp.status);
  const q = pickString(sp.q)?.trim();
  const page = clamp(Number(pickString(sp.page) ?? 1), 1, 10_000);
  const offset = (page - 1) * PER_PAGE;
  const books = (await db.execute(
    sql`select id, name, code, is_primary from accounting_books where org_id = ${orgId} and is_active order by is_primary desc, name`,
  )) as any;
  const requestedBookId = pickString(sp.book);
  const selectedBookId = (books.rows as any[]).some(
    (book) => book.id === requestedBookId,
  )
    ? requestedBookId!
    : ((books.rows as any[]).find((book) => book.is_primary)?.id ??
      books.rows[0]?.id ??
      "");
  const [periods, count, fys] = (await Promise.all([
    db.execute(sql`
      select p.id, p.name, p.starts_on, p.ends_on, p.fiscal_year, p.period_number,
             r.id as run_id, r.status, r.current_stage, r.readiness_score, r.target_close_date,
             coalesce(a.entries, 0) as entries,
             coalesce(l.closed_modules, 0) as closed_modules
        from accounting_periods p
        left join close_runs r on r.period_id = p.id and r.org_id = p.org_id
          and r.book_id = ${selectedBookId || null}
        left join lateral (select count(*) as entries from journal_entries e where e.period_id = p.id) a on true
        left join lateral (
          select count(*) as closed_modules from period_locks pl
           where pl.period_id = p.id and pl.subsidiary_id is null and pl.state = 'closed'
             and pl.book_id = ${selectedBookId || null}
        ) l on true
       where p.org_id = ${orgId} and p.fiscal_year = ${fy}
         ${q ? sql`and p.name ilike ${`%${q}%`}` : sql``}
         ${status && status !== "all" ? sql`and coalesce(r.status, 'not_started') = ${status}` : sql``}
       order by p.period_number
       limit ${PER_PAGE} offset ${offset}`),
    db.execute(sql`
      select count(*) as count from accounting_periods p
      left join close_runs r on r.period_id = p.id and r.org_id = p.org_id
        and r.book_id = ${selectedBookId || null}
      where p.org_id = ${orgId} and p.fiscal_year = ${fy}
        ${q ? sql`and p.name ilike ${`%${q}%`}` : sql``}
        ${status && status !== "all" ? sql`and coalesce(r.status, 'not_started') = ${status}` : sql``}`),
    db.execute(
      sql`select distinct fiscal_year from accounting_periods where org_id = ${orgId} order by fiscal_year desc`,
    ),
  ])) as any[];

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t("title")}
            description={t("workspaceDescription")}
            actions={can(authz, "admin.setup.manage") ? (
              <Button variant="outline" size="sm" asChild>
                <Link href="/admin/setup/accounting-books">{t("actions.manageBooks")}</Link>
              </Button>
            ) : null}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder={t("searchPlaceholder")} />
            {books.rows.length > 1 ? (
              <FilterChips
                basePath="/close"
                currentParams={sp}
                paramKey="book"
                label={t("filters.book")}
                hideAll
                defaultValue={selectedBookId}
                options={books.rows.map((row: any) => ({
                  value: row.id,
                  label: row.name,
                }))}
              />
            ) : books.rows[0] ? (
              <div className="inline-flex h-8 max-w-[16rem] items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200">
                <span className="text-slate-500 dark:text-slate-400">{t("filters.book")}:</span>
                <span className="truncate font-semibold">{books.rows[0].name}</span>
              </div>
            ) : null}
            <FilterChips
              basePath="/close"
              currentParams={sp}
              paramKey="fy"
              label={t("filters.fiscalYear")}
              hideAll
              defaultValue={String(currentFy)}
              options={fys.rows.map((row: any) => ({
                value: String(row.fiscal_year),
                label: t("filters.fyOption", { year: String(row.fiscal_year) }),
              }))}
            />
            <FilterChips
              basePath="/close"
              currentParams={sp}
              paramKey="status"
              label={t("filters.status")}
              options={[
                "not_started",
                "in_progress",
                "review",
                "approved",
                "closed",
                "published",
              ].map((value) => ({ value, label: t(`runStatus.${value}`) }))}
            />
          </div>
        </>
      }
    >
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("table.period")}</TableHead>
              <TableHead>{t("table.range")}</TableHead>
              <TableHead>{t("table.status")}</TableHead>
              <TableHead>{t("table.readiness")}</TableHead>
              <TableHead className="text-right">{t("table.entries")}</TableHead>
              <TableHead>{t("table.action")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(periods.rows as any[]).map((period) => (
              <TableRow key={period.id}>
                <TableCell className="font-medium">{period.name}</TableCell>
                <TableCell className="text-slate-500">
                  {period.starts_on} → {period.ends_on}
                </TableCell>
                <TableCell>
                  <Badge
                    variant={
                      period.status === "published" ||
                      period.status === "closed"
                        ? "success"
                        : period.status
                          ? "warning"
                          : "outline"
                    }
                  >
                    {t(`runStatus.${period.status ?? "not_started"}`)}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                      <div
                        className="h-full bg-teal-500"
                        style={{ width: `${period.readiness_score ?? 0}%` }}
                      />
                    </div>
                    <span className="text-xs tabular-nums text-slate-500">
                      {period.readiness_score ?? 0}%
                    </span>
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {Number(period.entries).toLocaleString()}
                </TableCell>
                <TableCell>
                  {period.run_id ? (
                    <Link
                      className="text-sm font-medium text-teal-700 hover:underline dark:text-teal-300"
                      href={`/close?run=${period.run_id}` as any}
                    >
                      {t("actions.resume")}
                    </Link>
                  ) : can(authz, "close.run") ? (
                    <StartCloseButton
                      periodId={period.id}
                      books={books.rows}
                      defaultBookId={selectedBookId}
                    />
                  ) : (
                    "—"
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <Pagination
          basePath="/close"
          currentParams={sp}
          total={Number(count.rows[0]?.count ?? 0)}
          page={page}
          perPage={PER_PAGE}
        />
      </div>
    </ListPageLayout>
  );
}
