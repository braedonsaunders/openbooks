import { sql } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { db } from "@openbooks/engine/src/db.ts";
import { ensureCloseDefaults } from "@openbooks/engine/src/close.ts";
import { clamp, isUuid, pickString } from "../../../../../lib/list-params";
import { CloseSetupWorkspace } from "./CloseSetupWorkspace";

const PER_PAGE = 20;
const CONFIG_PER_PAGE = 12;

function configListParams(
  searchParams: Record<string, string | string[] | undefined>,
  key: string,
) {
  const query = pickString(searchParams[`${key}Q`])?.trim();
  const page = clamp(
    Number(pickString(searchParams[`${key}Page`]) ?? 1),
    1,
    10_000,
  );
  return { query, page, offset: (page - 1) * CONFIG_PER_PAGE };
}

export async function CloseSetupPage({
  orgId,
  actorId,
  searchParams,
  canReopen,
}: {
  orgId: string;
  actorId: string;
  searchParams: Record<string, string | string[] | undefined>;
  canReopen: boolean;
}) {
  await ensureCloseDefaults(orgId, actorId);
  const q = pickString(searchParams.periodQ)?.trim();
  const fiscalYear = Number(
    pickString(searchParams.fy) ?? new Date().getFullYear(),
  );
  const page = clamp(
    Number(pickString(searchParams.periodPage) ?? 1),
    1,
    10_000,
  );
  const offset = (page - 1) * PER_PAGE;
  const calendarList = configListParams(searchParams, "calendar");
  const blueprintList = configListParams(searchParams, "blueprint");
  const policyList = configListParams(searchParams, "policy");
  const automationList = configListParams(searchParams, "automation");
  const packageList = configListParams(searchParams, "package");
  const reopenList = configListParams(searchParams, "reopen");
  const closeT = await getTranslations("close");
  const translatedMatch = (query: string | undefined, key: string) =>
    Boolean(
      query &&
      closeT(key as any)
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
    );
  const calendarDefaultMatch = translatedMatch(
    calendarList.query,
    "defaultData.calendar.name",
  );
  const blueprintDefaultMatch =
    translatedMatch(blueprintList.query, "defaultData.blueprint.name") ||
    translatedMatch(blueprintList.query, "defaultData.blueprint.description");
  const policyDefaultMatches = {
    materialVariance:
      translatedMatch(
        policyList.query,
        "defaultData.policies.materialVariance.name",
      ) ||
      translatedMatch(
        policyList.query,
        "defaultData.policies.materialVariance.description",
      ),
    independentApproval:
      translatedMatch(
        policyList.query,
        "defaultData.policies.independentApproval.name",
      ) ||
      translatedMatch(
        policyList.query,
        "defaultData.policies.independentApproval.description",
      ),
    controlledReopen:
      translatedMatch(
        policyList.query,
        "defaultData.policies.controlledReopen.name",
      ) ||
      translatedMatch(
        policyList.query,
        "defaultData.policies.controlledReopen.description",
      ),
  };
  const packageDefaultMatch =
    translatedMatch(packageList.query, "defaultData.package.name") ||
    translatedMatch(packageList.query, "defaultData.package.description");
  const books = (await db.execute(
    sql`select id, code, name, is_primary from accounting_books where org_id = ${orgId} and is_active order by is_primary desc, name`,
  )) as any;
  const requestedBookId = pickString(searchParams.book);
  const selectedBookId = (books.rows as any[]).some(
    (book) => book.id === requestedBookId,
  )
    ? requestedBookId!
    : ((books.rows as any[]).find((book) => book.is_primary)?.id ??
      books.rows[0]?.id ??
      "");

  const [
    calendars,
    calendarCount,
    calendarOptions,
    periods,
    periodCount,
    subsidiaries,
    blueprints,
    blueprintCount,
    steps,
    policies,
    policyCount,
    automations,
    automationCount,
    packages,
    packageCount,
    reopenRequests,
    reopenCount,
  ] = (await Promise.all([
    db.execute(sql`
      select * from fiscal_calendars
       where org_id = ${orgId}
         ${calendarList.query ? sql`and (name ilike ${`%${calendarList.query}%`} or (${calendarDefaultMatch} and name = 'close.defaultData.calendar.name'))` : sql``}
       order by is_default desc, name
       limit ${CONFIG_PER_PAGE} offset ${calendarList.offset}`),
    db.execute(sql`
      select count(*) as count from fiscal_calendars
       where org_id = ${orgId}
         ${calendarList.query ? sql`and (name ilike ${`%${calendarList.query}%`} or (${calendarDefaultMatch} and name = 'close.defaultData.calendar.name'))` : sql``}`),
    db.execute(
      sql`select id, name, is_default, is_active from fiscal_calendars where org_id = ${orgId} and is_active order by is_default desc, name`,
    ),
    db.execute(sql`
      select p.*, c.name as calendar_name,
             coalesce(jsonb_object_agg(l.module, jsonb_build_object(
               'state', l.state, 'lockedAt', l.locked_at, 'reason', l.reason,
               'reopenExpiresAt', l.reopen_expires_at
             )) filter (where l.id is not null), '{}'::jsonb) as locks,
             coalesce(j.entries, 0) as entries
        from accounting_periods p
        join fiscal_calendars c on c.id = p.fiscal_calendar_id
        left join period_locks l on l.period_id = p.id and l.org_id = p.org_id and l.subsidiary_id is null
          and l.book_id = ${selectedBookId || null}
        left join lateral (
          select count(*) as entries from journal_entries e where e.period_id = p.id
        ) j on true
       where p.org_id = ${orgId} and p.fiscal_year = ${fiscalYear}
         ${q ? sql`and (p.name ilike ${`%${q}%`} or c.name ilike ${`%${q}%`})` : sql``}
       group by p.id, c.name, j.entries
       order by p.period_number
       limit ${PER_PAGE} offset ${offset}`),
    db.execute(sql`
      select count(*) as count from accounting_periods p join fiscal_calendars c on c.id = p.fiscal_calendar_id
       where p.org_id = ${orgId} and p.fiscal_year = ${fiscalYear}
         ${q ? sql`and (p.name ilike ${`%${q}%`} or c.name ilike ${`%${q}%`})` : sql``}`),
    db.execute(
      sql`select id, name from subsidiaries where org_id = ${orgId} and is_active order by name`,
    ),
    db.execute(sql`
      select * from close_blueprints
       where org_id = ${orgId}
         ${blueprintList.query ? sql`and (name ilike ${`%${blueprintList.query}%`} or description ilike ${`%${blueprintList.query}%`} or (${blueprintDefaultMatch} and name = 'close.defaultData.blueprint.name'))` : sql``}
       order by is_active desc, is_default desc, name, version desc
       limit ${CONFIG_PER_PAGE} offset ${blueprintList.offset}`),
    db.execute(sql`
      select count(*) as count from close_blueprints
       where org_id = ${orgId}
         ${blueprintList.query ? sql`and (name ilike ${`%${blueprintList.query}%`} or description ilike ${`%${blueprintList.query}%`} or (${blueprintDefaultMatch} and name = 'close.defaultData.blueprint.name'))` : sql``}`),
    db.execute(sql`
      select s.*,
             coalesce(jsonb_agg(dep.key order by dep.key) filter (where dep.id is not null), '[]'::jsonb) as depends_on
        from close_blueprint_steps s
        left join close_blueprint_dependencies d on d.step_id = s.id
        left join close_blueprint_steps dep on dep.id = d.depends_on_step_id
       where s.org_id = ${orgId}
         and s.blueprint_id in (
           select id from close_blueprints
            where org_id = ${orgId}
              ${blueprintList.query ? sql`and (name ilike ${`%${blueprintList.query}%`} or description ilike ${`%${blueprintList.query}%`} or (${blueprintDefaultMatch} and name = 'close.defaultData.blueprint.name'))` : sql``}
            order by is_active desc, is_default desc, name, version desc
            limit ${CONFIG_PER_PAGE} offset ${blueprintList.offset}
         )
       group by s.id order by s.blueprint_id, s.sort_order`),
    db.execute(sql`
      select * from close_policies
       where org_id = ${orgId}
         ${policyList.query ? sql`and (name ilike ${`%${policyList.query}%`} or code ilike ${`%${policyList.query}%`} or policy_type ilike ${`%${policyList.query}%`} or (${policyDefaultMatches.materialVariance} and name = 'close.defaultData.policies.materialVariance.name') or (${policyDefaultMatches.independentApproval} and name = 'close.defaultData.policies.independentApproval.name') or (${policyDefaultMatches.controlledReopen} and name = 'close.defaultData.policies.controlledReopen.name'))` : sql``}
       order by policy_type, name
       limit ${CONFIG_PER_PAGE} offset ${policyList.offset}`),
    db.execute(sql`
      select count(*) as count from close_policies
       where org_id = ${orgId}
         ${policyList.query ? sql`and (name ilike ${`%${policyList.query}%`} or code ilike ${`%${policyList.query}%`} or policy_type ilike ${`%${policyList.query}%`} or (${policyDefaultMatches.materialVariance} and name = 'close.defaultData.policies.materialVariance.name') or (${policyDefaultMatches.independentApproval} and name = 'close.defaultData.policies.independentApproval.name') or (${policyDefaultMatches.controlledReopen} and name = 'close.defaultData.policies.controlledReopen.name'))` : sql``}`),
    db.execute(sql`
      select * from close_automation_rules
       where org_id = ${orgId}
         ${automationList.query ? sql`and (name ilike ${`%${automationList.query}%`} or trigger ilike ${`%${automationList.query}%`} or action ilike ${`%${automationList.query}%`})` : sql``}
       order by is_active desc, name
       limit ${CONFIG_PER_PAGE} offset ${automationList.offset}`),
    db.execute(sql`
      select count(*) as count from close_automation_rules
       where org_id = ${orgId}
         ${automationList.query ? sql`and (name ilike ${`%${automationList.query}%`} or trigger ilike ${`%${automationList.query}%`} or action ilike ${`%${automationList.query}%`})` : sql``}`),
    db.execute(sql`
      select * from close_reporting_packages
       where org_id = ${orgId}
         ${packageList.query ? sql`and (name ilike ${`%${packageList.query}%`} or description ilike ${`%${packageList.query}%`} or (${packageDefaultMatch} and name = 'close.defaultData.package.name'))` : sql``}
       order by is_default desc, name
       limit ${CONFIG_PER_PAGE} offset ${packageList.offset}`),
    db.execute(sql`
      select count(*) as count from close_reporting_packages
       where org_id = ${orgId}
         ${packageList.query ? sql`and (name ilike ${`%${packageList.query}%`} or description ilike ${`%${packageList.query}%`} or (${packageDefaultMatch} and name = 'close.defaultData.package.name'))` : sql``}`),
    db.execute(sql`
      select r.*, p.name as period_name, b.name as book_name,
             requester.name as requester_name, approver.name as approver_name
        from close_reopen_requests r
        join accounting_periods p on p.id = r.period_id
        join accounting_books b on b.id = r.book_id
        join users requester on requester.id = r.requested_by
        left join users approver on approver.id = r.approved_by
       where r.org_id = ${orgId}
         ${reopenList.query ? sql`and (p.name ilike ${`%${reopenList.query}%`} or b.name ilike ${`%${reopenList.query}%`} or requester.name ilike ${`%${reopenList.query}%`} or r.reason ilike ${`%${reopenList.query}%`} or r.status ilike ${`%${reopenList.query}%`})` : sql``}
       order by r.created_at desc
       limit ${CONFIG_PER_PAGE} offset ${reopenList.offset}`),
    db.execute(sql`
      select count(*) as count
        from close_reopen_requests r
        join accounting_periods p on p.id = r.period_id
        join accounting_books b on b.id = r.book_id
        join users requester on requester.id = r.requested_by
       where r.org_id = ${orgId}
         ${reopenList.query ? sql`and (p.name ilike ${`%${reopenList.query}%`} or b.name ilike ${`%${reopenList.query}%`} or requester.name ilike ${`%${reopenList.query}%`} or r.reason ilike ${`%${reopenList.query}%`} or r.status ilike ${`%${reopenList.query}%`})` : sql``}`),
  ])) as any[];

  const stepRows = steps.rows as any[];
  return (
    <CloseSetupWorkspace
      currentParams={searchParams}
      fiscalYear={fiscalYear}
      periodPage={page}
      periodPerPage={PER_PAGE}
      periodTotal={Number(periodCount.rows[0]?.count ?? 0)}
      calendars={calendars.rows}
      calendarOptions={calendarOptions.rows}
      configLists={{
        calendar: {
          page: calendarList.page,
          total: Number(calendarCount.rows[0]?.count ?? 0),
        },
        blueprint: {
          page: blueprintList.page,
          total: Number(blueprintCount.rows[0]?.count ?? 0),
        },
        policy: {
          page: policyList.page,
          total: Number(policyCount.rows[0]?.count ?? 0),
        },
        automation: {
          page: automationList.page,
          total: Number(automationCount.rows[0]?.count ?? 0),
        },
        package: {
          page: packageList.page,
          total: Number(packageCount.rows[0]?.count ?? 0),
        },
      }}
      configPerPage={CONFIG_PER_PAGE}
      periods={periods.rows}
      books={books.rows}
      selectedBookId={selectedBookId}
      canReopen={canReopen}
      subsidiaries={subsidiaries.rows}
      blueprints={(blueprints.rows as any[]).map((blueprint) => ({
        ...blueprint,
        steps: stepRows.filter((step) => step.blueprint_id === blueprint.id),
      }))}
      policies={policies.rows}
      automations={automations.rows}
      packages={packages.rows}
      reopenRequests={reopenRequests.rows}
      reopenPage={reopenList.page}
      reopenTotal={Number(reopenCount.rows[0]?.count ?? 0)}
      reopenPerPage={CONFIG_PER_PAGE}
    />
  );
}
