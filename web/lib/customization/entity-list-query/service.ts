import "server-only";
import { sql, type SQL } from "drizzle-orm";
import type { FilterClause, ListViewConfig } from "@openbooks/customization";
import { subsidiaryVisibleFilter } from "../../subsidiaries";
import { pushCustomFieldFilter } from "../list-query";
import type { EntityAdhoc } from "./adhoc";

/* ------------------------------------------------------------------ */
/* Service dispatch: requests, jobs, visits and agreements             */
/* ------------------------------------------------------------------ */

function selectPredicate(column: SQL, clause: FilterClause): SQL | null {
  const value = Array.isArray(clause.value)
    ? String(clause.value[0] ?? "")
    : String(clause.value ?? "");
  if (clause.operator === "eq") return sql`${column} = ${value}`;
  if (clause.operator === "ne") return sql`${column} <> ${value}`;
  if (clause.operator === "in" || clause.operator === "not_in") {
    const values = (Array.isArray(clause.value) ? clause.value : [value])
      .map(String)
      .filter(Boolean);
    if (!values.length) return clause.operator === "in" ? sql`false` : sql`true`;
    const list = sql.join(
      values.map((item) => sql`${item}`),
      sql`, `,
    );
    return clause.operator === "in" ? sql`${column} in (${list})` : sql`${column} not in (${list})`;
  }
  return null;
}

function textPredicate(column: SQL, clause: FilterClause): SQL | null {
  const value = String(
    Array.isArray(clause.value) ? (clause.value[0] ?? "") : (clause.value ?? ""),
  );
  if (clause.operator === "eq") return sql`${column} = ${value}`;
  if (clause.operator === "contains") return sql`${column} ilike ${`%${value}%`}`;
  if (clause.operator === "is_set") return sql`coalesce(${column}, '') <> ''`;
  if (clause.operator === "is_not_set") return sql`coalesce(${column}, '') = ''`;
  return null;
}

function finishWhere(
  parts: SQL[],
  view: ListViewConfig,
  predicate: (clause: FilterClause) => SQL | null,
): SQL {
  for (const filter of view.filters) {
    if (pushCustomFieldFilter(parts, filter, null)) continue;
    const clause = predicate(filter);
    if (clause) parts.push(sql`and ${clause}`);
  }
  return sql.join(parts, sql` `);
}

const customerName = (t: SQL) =>
  sql`(select display_name from parties p where p.org_id = ${t}.org_id and p.id = ${t}.customer_party_id)`;
const location = (t: SQL) =>
  sql`(select nullif(concat_ws(', ', a.line1, a.city, a.region), '') from addresses a where a.org_id = ${t}.org_id and a.id = ${t}.service_address_id)`;

export const SERVICE_REQUEST_BUILT_IN_EXPR: Record<string, SQL> = {
  number: sql`sr.request_number`,
  title: sql`sr.title`,
  customer: customerName(sql`sr`),
  location: location(sql`sr`),
  priority: sql`sr.priority`,
  preferred_on: sql`sr.preferred_on`,
  source: sql`sr.source`,
  status: sql`sr.status`,
  created_at: sql`sr.created_at`,
};

export const SERVICE_REQUEST_SORTS: Record<string, SQL> = {
  number: sql`sr.request_number`,
  title: sql`sr.title`,
  priority: sql`case sr.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`,
  preferred_on: sql`sr.preferred_on`,
  status: sql`sr.status`,
  created_at: sql`sr.created_at`,
};

export function serviceRequestWhere(
  view: ListViewConfig,
  adhoc: EntityAdhoc,
  orgId: string,
  allowed?: ReadonlySet<string> | null,
): SQL {
  const parts: SQL[] = [
    sql`sr.org_id = ${orgId}`,
    subsidiaryVisibleFilter(sql`sr.subsidiary_id`, allowed ?? null),
  ];
  const savedViewOwnsStatus = view.filters.some((filter) => filter.key === "status");
  if (!adhoc.showInactive && !savedViewOwnsStatus && !adhoc.filters?.status)
    parts.push(sql`and sr.status not in ('converted','declined','cancelled')`);
  if (adhoc.filters?.status) parts.push(sql`and sr.status = ${adhoc.filters.status}`);
  if (adhoc.filters?.priority) parts.push(sql`and sr.priority = ${adhoc.filters.priority}`);
  if (adhoc.q) {
    const query = `%${adhoc.q}%`;
    parts.push(
      sql`and (sr.request_number ilike ${query} or sr.title ilike ${query} or ${customerName(sql`sr`)} ilike ${query})`,
    );
  }
  return finishWhere(parts, view, (clause) =>
    clause.key === "status"
      ? selectPredicate(sql`sr.status`, clause)
      : clause.key === "priority"
        ? selectPredicate(sql`sr.priority`, clause)
        : clause.key === "source"
          ? selectPredicate(sql`sr.source`, clause)
          : clause.key === "title"
            ? textPredicate(sql`sr.title`, clause)
            : null,
  );
}

const JOB_STAGE = sql`case
  when sj.status = 'cancelled' then 'cancelled'
  when sj.status = 'completed' and sj.billing_mode = 'per_job' and not exists (select 1 from service_billings b where b.org_id = sj.org_id and b.job_id = sj.id and b.visit_id is null and b.released_at is null) then 'to_invoice'
  when sj.status = 'completed' then 'completed'
  when exists (select 1 from service_visits v where v.org_id = sj.org_id and v.job_id = sj.id and v.status in ('en_route','on_site')) then 'in_progress'
  when exists (select 1 from service_visits v where v.org_id = sj.org_id and v.job_id = sj.id and v.status in ('scheduled','dispatched')) then 'scheduled'
  when sj.billing_mode = 'per_visit' and exists (select 1 from service_visits v where v.org_id = sj.org_id and v.job_id = sj.id and v.status = 'completed'
    and coalesce(v.review_status, 'not_required') in ('not_required','approved')
    and not exists (select 1 from service_billings b where b.org_id = v.org_id and b.visit_id = v.id and b.released_at is null)) then 'to_invoice'
  when exists (select 1 from service_visits v where v.org_id = sj.org_id and v.job_id = sj.id and v.status = 'unscheduled') then 'unscheduled'
  else 'open' end`;

export const SERVICE_JOB_BUILT_IN_EXPR: Record<string, SQL> = {
  number: sql`sj.job_number`,
  title: sql`sj.title`,
  customer: customerName(sql`sj`),
  location: location(sql`sj`),
  priority: sql`sj.priority`,
  stage: JOB_STAGE,
  billing_mode: sql`sj.billing_mode`,
  sla_due_at: sql`sj.sla_due_at`,
  status: sql`sj.status`,
  created_at: sql`sj.created_at`,
};

export const SERVICE_JOB_SORTS: Record<string, SQL> = {
  number: sql`sj.job_number`,
  title: sql`sj.title`,
  priority: sql`case sj.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`,
  sla_due_at: sql`sj.sla_due_at`,
  status: sql`sj.status`,
  created_at: sql`sj.created_at`,
};

export function serviceJobWhere(
  view: ListViewConfig,
  adhoc: EntityAdhoc,
  orgId: string,
  allowed?: ReadonlySet<string> | null,
): SQL {
  const parts: SQL[] = [
    sql`sj.org_id = ${orgId}`,
    subsidiaryVisibleFilter(sql`sj.subsidiary_id`, allowed ?? null),
  ];
  const savedViewOwnsStatus = view.filters.some((filter) => filter.key === "status");
  if (!adhoc.showInactive && !savedViewOwnsStatus && !adhoc.filters?.status)
    parts.push(sql`and sj.status = 'open'`);
  if (adhoc.filters?.status) parts.push(sql`and sj.status = ${adhoc.filters.status}`);
  if (adhoc.filters?.priority) parts.push(sql`and sj.priority = ${adhoc.filters.priority}`);
  if (adhoc.q) {
    const query = `%${adhoc.q}%`;
    parts.push(
      sql`and (sj.job_number ilike ${query} or sj.title ilike ${query} or ${customerName(sql`sj`)} ilike ${query})`,
    );
  }
  return finishWhere(parts, view, (clause) =>
    clause.key === "status"
      ? selectPredicate(sql`sj.status`, clause)
      : clause.key === "priority"
        ? selectPredicate(sql`sj.priority`, clause)
        : clause.key === "billing_mode"
          ? selectPredicate(sql`sj.billing_mode`, clause)
          : clause.key === "stage"
            ? selectPredicate(JOB_STAGE, clause)
            : clause.key === "title"
              ? textPredicate(sql`sj.title`, clause)
              : null,
  );
}

const VISIT_PARENT = sql`left join service_jobs vj on vj.org_id = sv.org_id and vj.id = sv.job_id
  left join service_requests vr on vr.org_id = sv.org_id and vr.id = sv.request_id`;

export const SERVICE_VISIT_BASE_JOINS = VISIT_PARENT;

export const SERVICE_VISIT_BUILT_IN_EXPR: Record<string, SQL> = {
  number: sql`coalesce(vj.job_number, vr.request_number) || ' · ' || sv.sequence`,
  title: sql`coalesce(vj.title, vr.title)`,
  customer: sql`(select display_name from parties p where p.org_id = sv.org_id and p.id = coalesce(vj.customer_party_id, vr.customer_party_id))`,
  kind: sql`sv.kind`,
  priority: sql`sv.priority`,
  scheduled_at: sql`(select min(e.starts_at) from schedule_entries e where e.org_id = sv.org_id and e.service_visit_id = sv.id and e.status = 'published')`,
  technicians: sql`(select string_agg(t.display_name, ', ' order by t.display_name) from schedule_entries e join parties t on t.org_id = e.org_id and t.id = e.worker_party_id
    where e.org_id = sv.org_id and e.service_visit_id = sv.id and e.status = 'published')`,
  preferred_on: sql`coalesce(sv.occurs_on, sv.preferred_on)`,
  sla_due_at: sql`sv.sla_due_at`,
  status: sql`sv.status`,
  review_status: sql`sv.review_status`,
};

export const SERVICE_VISIT_SORTS: Record<string, SQL> = {
  number: sql`coalesce(vj.job_number, vr.request_number), sv.sequence`,
  priority: sql`case sv.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`,
  preferred_on: sql`coalesce(sv.occurs_on, sv.preferred_on)`,
  sla_due_at: sql`sv.sla_due_at`,
  status: sql`sv.status`,
};

export function serviceVisitWhere(
  view: ListViewConfig,
  adhoc: EntityAdhoc,
  orgId: string,
  allowed?: ReadonlySet<string> | null,
): SQL {
  const parts: SQL[] = [
    sql`sv.org_id = ${orgId}`,
    subsidiaryVisibleFilter(sql`sv.subsidiary_id`, allowed ?? null),
  ];
  const savedViewOwnsStatus = view.filters.some((filter) => filter.key === "status");
  if (!adhoc.showInactive && !savedViewOwnsStatus && !adhoc.filters?.status)
    parts.push(sql`and sv.status not in ('completed','unable_to_complete','cancelled')`);
  if (adhoc.filters?.status) parts.push(sql`and sv.status = ${adhoc.filters.status}`);
  if (adhoc.filters?.priority) parts.push(sql`and sv.priority = ${adhoc.filters.priority}`);
  if (adhoc.q) {
    const query = `%${adhoc.q}%`;
    parts.push(
      sql`and (coalesce(vj.job_number, vr.request_number) ilike ${query} or coalesce(vj.title, vr.title) ilike ${query})`,
    );
  }
  return finishWhere(parts, view, (clause) =>
    clause.key === "status"
      ? selectPredicate(sql`sv.status`, clause)
      : clause.key === "priority"
        ? selectPredicate(sql`sv.priority`, clause)
        : clause.key === "kind"
          ? selectPredicate(sql`sv.kind`, clause)
          : clause.key === "review_status"
            ? selectPredicate(sql`sv.review_status`, clause)
            : null,
  );
}

export const SERVICE_AGREEMENT_BUILT_IN_EXPR: Record<string, SQL> = {
  number: sql`sa.agreement_number`,
  title: sql`sa.title`,
  customer: customerName(sql`sa`),
  location: location(sql`sa`),
  starts_on: sql`sa.starts_on`,
  ends_on: sql`sa.ends_on`,
  generated_through: sql`sa.generated_through`,
  status: sql`sa.status`,
};

export const SERVICE_AGREEMENT_SORTS: Record<string, SQL> = {
  number: sql`sa.agreement_number`,
  title: sql`sa.title`,
  starts_on: sql`sa.starts_on`,
  status: sql`sa.status`,
};

export function serviceAgreementWhere(
  view: ListViewConfig,
  adhoc: EntityAdhoc,
  orgId: string,
  allowed?: ReadonlySet<string> | null,
): SQL {
  const parts: SQL[] = [
    sql`sa.org_id = ${orgId}`,
    subsidiaryVisibleFilter(sql`sa.subsidiary_id`, allowed ?? null),
  ];
  const savedViewOwnsStatus = view.filters.some((filter) => filter.key === "status");
  if (!adhoc.showInactive && !savedViewOwnsStatus && !adhoc.filters?.status)
    parts.push(sql`and sa.status = 'active'`);
  if (adhoc.filters?.status) parts.push(sql`and sa.status = ${adhoc.filters.status}`);
  if (adhoc.q) {
    const query = `%${adhoc.q}%`;
    parts.push(
      sql`and (sa.agreement_number ilike ${query} or sa.title ilike ${query} or ${customerName(sql`sa`)} ilike ${query})`,
    );
  }
  return finishWhere(parts, view, (clause) =>
    clause.key === "status"
      ? selectPredicate(sql`sa.status`, clause)
      : clause.key === "title"
        ? textPredicate(sql`sa.title`, clause)
        : null,
  );
}
