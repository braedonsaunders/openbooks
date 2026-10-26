import type { ReportEntity } from "./entities";
import { REPORT_AS_OF } from "./report-as-of";

// Service dispatch reports read the service ledger: jobs with their aging,
// first-time fix and invoiced revenue, sent quotes with their decisions, and
// technician-days of booked versus recorded visit hours. Every source needs
// the Service dispatch feature and the service read permission, every join is
// pinned to the row's organization, and every row carries the legal entity of
// the service work so restricted readers see only their entities.
//
// Calendar days of service timestamps (created, completed, sent, decided) are
// read in the organization's business time zone, the same zone the business
// date is resolved in, so a job opened late in the evening ages from the
// operator's day rather than the server's. Ages are measured to the run's
// business date (the catalog as-of sentinel), never the database clock.

const ORG_ZONE = `coalesce(nullif(btrim(o.settings->>'timeZone'), ''), 'UTC')`;
const businessDay = (timestamp: string): string =>
  `((${timestamp}) AT TIME ZONE ${ORG_ZONE})::date`;

const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
const JOB_STATUSES = ["open", "completed", "cancelled"] as const;
const BILLING_MODES = ["per_job", "per_visit", "not_billable"] as const;

/** Open-job age buckets, named so they sort in age order. */
export const SERVICE_JOB_AGE_BUCKETS = [
  "age_00_07",
  "age_08_30",
  "age_31_90",
  "age_91_plus",
] as const;

const shared = {
  category: "service",
  featureKey: "serviceDispatch",
  requiredPermission: "service.read",
} as const;

/** The job header joins shared by the job-grained sources. */
const JOB_FROM = `service_jobs j
      JOIN orgs o ON o.id = j.org_id
      JOIN subsidiaries sub ON sub.id = j.subsidiary_id AND sub.org_id = j.org_id
      JOIN parties cust ON cust.id = j.customer_party_id AND cust.org_id = j.org_id
      CROSS JOIN LATERAL (
        SELECT ${businessDay("j.created_at")} AS created_on,
               ${businessDay("j.completed_at")} AS completed_on
      ) days`;

const jobColumns: ReportEntity["columns"] = [
  { key: "id", label: "Job key", kind: "uuid", expr: "j.id" },
  { key: "job_number", label: "Job", kind: "text", expr: "j.job_number" },
  { key: "title", label: "Title", kind: "text", expr: "j.title" },
  { key: "status", label: "Status", kind: "enum", expr: "j.status", options: JOB_STATUSES },
  { key: "priority", label: "Priority", kind: "enum", expr: "j.priority", options: PRIORITIES },
  {
    key: "billing_mode",
    label: "Billing",
    kind: "enum",
    expr: "j.billing_mode",
    options: BILLING_MODES,
  },
  { key: "customer", label: "Customer", kind: "text", expr: "cust.display_name" },
  { key: "customer_id", label: "Customer key", kind: "uuid", expr: "j.customer_party_id" },
  { key: "subsidiary", label: "Subsidiary", kind: "text", expr: "sub.name" },
  {
    key: "recurring",
    label: "Recurring agreement",
    kind: "boolean",
    expr: "(j.agreement_id IS NOT NULL)",
    options: ["true", "false"],
  },
  { key: "created_on", label: "Opened on", kind: "date", expr: "days.created_on" },
  { key: "completed_on", label: "Completed on", kind: "date", expr: "days.completed_on" },
];

export const serviceJobsByStatusEntity: ReportEntity = {
  ...shared,
  key: "service_jobs_by_status",
  label: "Service jobs by status",
  description:
    "One row per service job with its status, priority, billing and customer. Open jobs carry their age in days to the report date and an age bucket; completed jobs carry the days they took.",
  from: `${JOB_FROM}
      CROSS JOIN LATERAL (
        SELECT CASE WHEN j.status = 'open' THEN greatest(0, ${REPORT_AS_OF}::date - days.created_on) END AS age_days
      ) age`,
  orgColumn: "j.org_id",
  subsidiaryScope: { column: "j.subsidiary_id" },
  // Aging is current state: an old open job must not fall out of a period window.
  defaultPeriodField: null,
  defaultSort: { column: "created_on", direction: "desc" },
  columns: [
    ...jobColumns,
    { key: "age_days", label: "Age (days)", kind: "number", expr: "age.age_days" },
    {
      key: "age_bucket",
      label: "Age bucket",
      kind: "enum",
      options: SERVICE_JOB_AGE_BUCKETS,
      expr: `(CASE WHEN age.age_days IS NULL THEN NULL
        WHEN age.age_days <= 7 THEN 'age_00_07'
        WHEN age.age_days <= 30 THEN 'age_08_30'
        WHEN age.age_days <= 90 THEN 'age_31_90'
        ELSE 'age_91_plus' END)`,
    },
    {
      key: "days_to_complete",
      label: "Days to complete",
      kind: "number",
      expr: `(CASE WHEN j.status = 'completed' THEN days.completed_on - days.created_on END)`,
    },
  ],
};

export const serviceTechnicianUtilizationEntity: ReportEntity = {
  ...shared,
  key: "service_technician_utilization",
  label: "Technician utilization",
  description:
    "One row per technician and day: hours booked on service visits from live dispatch bookings, against labor hours recorded on service visits.",
  // Bookings count on their scheduled start day net of breaks; labor counts on
  // its worked day. Rejected time entries are excluded. Both streams take the
  // legal entity of the visit they serve.
  from: `(
      SELECT f.org_id, f.subsidiary_id, f.technician_party_id, f.work_date,
             sum(f.booked_hours) AS booked_hours, sum(f.worked_hours) AS worked_hours,
             count(DISTINCT f.booked_visit_id) AS booked_visits, count(DISTINCT f.worked_visit_id) AS worked_visits
        FROM (
          SELECT se.org_id, v.subsidiary_id, se.worker_party_id AS technician_party_id, se.starts_on AS work_date,
                 greatest(0, extract(epoch FROM se.ends_at - se.starts_at) - se.break_minutes * 60) / 3600 AS booked_hours,
                 0::numeric AS worked_hours, se.service_visit_id AS booked_visit_id, NULL::uuid AS worked_visit_id
            FROM schedule_entries se
            JOIN service_visits v ON v.id = se.service_visit_id AND v.org_id = se.org_id
           WHERE se.service_visit_id IS NOT NULL AND se.status = 'published' AND se.worker_party_id IS NOT NULL
          UNION ALL
          SELECT te.org_id, v.subsidiary_id, te.employee_party_id, te.worked_on,
                 0::numeric, te.hours, NULL::uuid, te.service_visit_id
            FROM time_entries te
            JOIN service_visits v ON v.id = te.service_visit_id AND v.org_id = te.org_id
           WHERE te.service_visit_id IS NOT NULL AND te.status <> 'rejected'
        ) f
       GROUP BY f.org_id, f.subsidiary_id, f.technician_party_id, f.work_date
    ) util
      JOIN parties tech ON tech.id = util.technician_party_id AND tech.org_id = util.org_id
      JOIN subsidiaries sub ON sub.id = util.subsidiary_id AND sub.org_id = util.org_id`,
  orgColumn: "util.org_id",
  subsidiaryScope: { column: "util.subsidiary_id" },
  defaultPeriodField: "work_date",
  defaultSort: { column: "work_date", direction: "desc" },
  columns: [
    { key: "work_date", label: "Date", kind: "date", expr: "util.work_date" },
    { key: "technician", label: "Technician", kind: "text", expr: "tech.display_name" },
    {
      key: "technician_id",
      label: "Technician key",
      kind: "uuid",
      expr: "util.technician_party_id",
    },
    { key: "subsidiary", label: "Subsidiary", kind: "text", expr: "sub.name" },
    { key: "booked_hours", label: "Booked hours", kind: "number", expr: "util.booked_hours" },
    { key: "worked_hours", label: "Recorded hours", kind: "number", expr: "util.worked_hours" },
    { key: "booked_visits", label: "Booked visits", kind: "number", expr: "util.booked_visits" },
    {
      key: "worked_visits",
      label: "Visits with recorded time",
      kind: "number",
      expr: "util.worked_visits",
    },
  ],
};

export const serviceFirstTimeFixEntity: ReportEntity = {
  ...shared,
  key: "service_first_time_fix",
  label: "First-time fix",
  description:
    "One row per completed service job outside recurring agreements: completed and unable-to-complete service visits, and whether the job was fixed on its first visit (exactly one completed visit and none unable to complete).",
  from: `${JOB_FROM}
      CROSS JOIN LATERAL (
        SELECT count(*) FILTER (WHERE v.status = 'completed') AS completed_visits,
               count(*) FILTER (WHERE v.status = 'unable_to_complete') AS unable_visits
          FROM service_visits v
         WHERE v.org_id = j.org_id AND v.job_id = j.id AND v.kind = 'service'
      ) visits`,
  orgColumn: "j.org_id",
  subsidiaryScope: { column: "j.subsidiary_id" },
  // Agreement jobs collect a visit per occurrence, so a visit count says
  // nothing about whether the work was fixed first time.
  baseFilter: {
    combinator: "and",
    rules: [
      { field: "status", op: "eq", value: "completed" },
      { field: "recurring", op: "is_false" },
    ],
  },
  defaultPeriodField: "completed_on",
  defaultSort: { column: "completed_on", direction: "desc" },
  columns: [
    ...jobColumns,
    {
      key: "completed_visits",
      label: "Completed visits",
      kind: "number",
      expr: "visits.completed_visits",
    },
    {
      key: "unable_visits",
      label: "Unable-to-complete visits",
      kind: "number",
      expr: "visits.unable_visits",
    },
    {
      key: "first_time_fix",
      label: "Fixed first time",
      kind: "boolean",
      options: ["true", "false"],
      expr: "(visits.completed_visits = 1 AND visits.unable_visits = 0)",
    },
  ],
};

export const serviceQuoteWinRateEntity: ReportEntity = {
  ...shared,
  key: "service_quote_win_rate",
  label: "Service quotes",
  description:
    "One row per sent service quote with its decision, quoted total and accepted total (including selected add-ons and tax), in the quote currency.",
  from: `service_quotes sq
      JOIN orgs o ON o.id = sq.org_id
      JOIN documents d ON d.id = sq.quote_document_id AND d.org_id = sq.org_id AND d.kind = 'quote'
      LEFT JOIN service_requests sr ON sr.id = sq.request_id AND sr.org_id = sq.org_id
      LEFT JOIN service_jobs sj ON sj.id = sq.job_id AND sj.org_id = sq.org_id
      LEFT JOIN parties cust ON cust.id = d.party_id AND cust.org_id = sq.org_id
      LEFT JOIN subsidiaries sub ON sub.id = coalesce(sr.subsidiary_id, sj.subsidiary_id, d.subsidiary_id) AND sub.org_id = sq.org_id`,
  orgColumn: "sq.org_id",
  // A quote belongs to the legal entity of the request or job it prices.
  subsidiaryScope: { column: "coalesce(sr.subsidiary_id, sj.subsidiary_id, d.subsidiary_id)" },
  baseFilter: {
    combinator: "and",
    rules: [{ field: "status", op: "in", value: ["sent", "accepted", "declined"] }],
  },
  currencyColumn: "currency",
  defaultPeriodField: "sent_on",
  defaultSort: { column: "sent_on", direction: "desc" },
  columns: [
    { key: "id", label: "Quote key", kind: "uuid", expr: "sq.id" },
    { key: "quote_number", label: "Quote", kind: "text", expr: "d.document_number" },
    {
      key: "status",
      label: "Decision",
      kind: "enum",
      expr: "sq.status",
      options: ["draft", "sent", "accepted", "declined"],
    },
    { key: "sent_on", label: "Sent on", kind: "date", expr: businessDay("sq.sent_at") },
    { key: "decided_on", label: "Decided on", kind: "date", expr: businessDay("sq.decided_at") },
    { key: "customer", label: "Customer", kind: "text", expr: "cust.display_name" },
    { key: "subsidiary", label: "Subsidiary", kind: "text", expr: "sub.name" },
    { key: "request_number", label: "Request", kind: "text", expr: "sr.request_number" },
    { key: "job_number", label: "Job", kind: "text", expr: "sj.job_number" },
    { key: "currency", label: "Currency", kind: "text", expr: "d.currency" },
    {
      key: "quoted_total",
      label: "Quoted total",
      kind: "money",
      expr: "d.total",
      txnCurrency: true,
    },
    {
      key: "accepted_total",
      label: "Accepted total",
      kind: "money",
      expr: "sq.accepted_total",
      txnCurrency: true,
    },
    { key: "document_id", label: "Quote document key", kind: "uuid", expr: "sq.quote_document_id" },
  ],
};

export const serviceRevenuePerJobEntity: ReportEntity = {
  ...shared,
  key: "service_revenue_per_job",
  label: "Service revenue per job",
  description:
    "One row per completed service job with the revenue (before tax) and total of the posted invoices that bill it, in the job currency.",
  // Only live billing links count: a voided invoice releases its link. An
  // invoice in a currency other than the job's is never added to the job's
  // revenue; it is counted on its own column so it stays visible.
  from: `${JOB_FROM}
      CROSS JOIN LATERAL (
        SELECT count(*) FILTER (WHERE d.currency = j.currency) AS invoice_count,
               coalesce(sum(d.subtotal) FILTER (WHERE d.currency = j.currency), 0) AS revenue,
               coalesce(sum(d.total) FILTER (WHERE d.currency = j.currency), 0) AS invoiced_total,
               count(*) FILTER (WHERE d.currency <> j.currency) AS other_currency_invoices
          FROM service_billings b
          JOIN documents d ON d.id = b.invoice_document_id AND d.org_id = b.org_id AND d.kind = 'customer_invoice'
         -- Live entries only: a job's invoiced revenue counts its current posted billings; a voided invoice releases its billing.
         WHERE b.org_id = j.org_id AND b.job_id = j.id AND b.released_at IS NULL AND d.status = 'posted'
      ) inv`,
  orgColumn: "j.org_id",
  subsidiaryScope: { column: "j.subsidiary_id" },
  baseFilter: { combinator: "and", rules: [{ field: "status", op: "eq", value: "completed" }] },
  currencyColumn: "currency",
  defaultPeriodField: "completed_on",
  defaultSort: { column: "completed_on", direction: "desc" },
  columns: [
    ...jobColumns,
    { key: "currency", label: "Currency", kind: "text", expr: "j.currency" },
    {
      key: "invoiced_revenue",
      label: "Invoiced revenue",
      kind: "money",
      expr: "inv.revenue",
      txnCurrency: true,
    },
    {
      key: "invoiced_total",
      label: "Invoiced total",
      kind: "money",
      expr: "inv.invoiced_total",
      txnCurrency: true,
    },
    { key: "invoice_count", label: "Posted invoices", kind: "number", expr: "inv.invoice_count" },
    {
      key: "other_currency_invoices",
      label: "Invoices in another currency",
      kind: "number",
      expr: "inv.other_currency_invoices",
    },
  ],
};

export const SERVICE_REPORT_ENTITIES: ReportEntity[] = [
  serviceJobsByStatusEntity,
  serviceTechnicianUtilizationEntity,
  serviceFirstTimeFixEntity,
  serviceQuoteWinRateEntity,
  serviceRevenuePerJobEntity,
];
