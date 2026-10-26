import type { ReportEntity } from "./entities";
import { REPORT_AS_OF } from "./report-as-of";

const shared = {
  category: "general_ledger" as const,
  featureKey: "equity",
  requiredPermission: "equity.read",
  currencyColumn: "currency",
};

/**
 * Equity reports.
 *
 * The compensation source lists every posted stock compensation run line —
 * the award's cumulative cost recognized through the run date, what earlier
 * runs posted and the change this run posted — so the expense schedule sums
 * the change by period and the latest cumulative per award is the cost
 * recognized to date. The register lists every security as issued, with its
 * terms, and its status and outstanding quantity on the as-of date. Positions as of a date come from the position ledger: every change
 * of a certificate's, award's or plan pool's position, restated through
 * splits and converted into common at the ratio in force, so the sum of the
 * movements effective on or before a date is the cap table on that date.
 */
/** The statuses a security reads with on a date, as the equity read model names them. */
export const SECURITY_STATUSES = [
  "outstanding",
  "exercised",
  "settled",
  "converted",
  "transferred",
  "forfeited",
  "expired",
  "cancelled",
  "repurchased",
  "repaid",
  "void",
] as const;

/**
 * Events in force on the as-of date: effective on or before it, not undone
 * by a governed reversal effective by then, and not an event whose
 * resulting security was voided by then (voiding the certificate an event
 * produced is how that event is corrected). The equity read model replays
 * the same events.
 */
const EVENT_IN_FORCE = `e.org_id = s.org_id and e.security_id = s.id and e.effective_on <= ${REPORT_AS_OF}::date
          and not exists (select 1 from equity_security_events r
                           where r.org_id = e.org_id and r.kind = 'reverse' and r.reverses_event_id = e.id and r.effective_on <= ${REPORT_AS_OF}::date)
          and not (e.resulting_security_id is not null and exists (
                select 1 from equity_security_events v
                 where v.org_id = e.org_id and v.security_id = e.resulting_security_id and v.kind = 'void' and v.effective_on <= ${REPORT_AS_OF}::date))`;

/**
 * A security's state on the as-of date: the shares or units it holds from
 * the position ledger, whether it was voided, the last event that reduced a
 * certificate or award, and the event that ended a SAFE or note.
 */
const SECURITY_STATE_AS_OF = `select
        (select coalesce(sum(m.shares_delta), 0) from equity_position_movements m
          where m.org_id = s.org_id and m.security_id = s.id and m.position_kind in ('share', 'award')
            and m.effective_on <= ${REPORT_AS_OF}::date) as outstanding,
        exists (select 1 from equity_security_events e where ${EVENT_IN_FORCE} and e.kind = 'void') as voided,
        (select e.kind from equity_security_events e
          where ${EVENT_IN_FORCE} and e.kind in ('exercise', 'settle', 'forfeit', 'expire', 'cancel', 'repurchase', 'transfer', 'convert')
          order by e.effective_on desc, e.created_at desc, e.id desc limit 1) as last_reduction,
        (select e.kind from equity_security_events e
          where ${EVENT_IN_FORCE} and e.kind in ('void', 'convert', 'repay', 'cancel')
          order by e.effective_on, e.created_at, e.id limit 1) as ending`;

/**
 * The status on the as-of date. A SAFE or note is outstanding until the
 * first event that ends it; a certificate or award is void once voided,
 * outstanding while it holds shares or units, and otherwise named by the
 * last event that reduced it.
 */
const SECURITY_STATUS_AS_OF = `case
      when s.kind in ('safe', 'note') then coalesce(case st.ending when 'void' then 'void' when 'convert' then 'converted' when 'repay' then 'repaid' when 'cancel' then 'cancelled' end, 'outstanding')
      when st.voided then 'void'
      when st.outstanding > 0 then 'outstanding'
      else coalesce(case st.last_reduction when 'exercise' then 'exercised' when 'settle' then 'settled' when 'forfeit' then 'forfeited' when 'expire' then 'expired'
        when 'cancel' then 'cancelled' when 'repurchase' then 'repurchased' when 'transfer' then 'transferred' when 'convert' then 'converted' end, 'outstanding')
    end`;

export const EQUITY_REPORT_ENTITIES: ReportEntity[] = [
  {
    ...shared,
    key: "equity_compensation_run_lines",
    label: "Stock compensation run lines",
    description:
      "Posted stock compensation run lines: cost recognized to date and each run's change.",
    from: `equity_compensation_run_lines l
      join equity_compensation_runs r on r.org_id = l.org_id and r.id = l.run_id
      join equity_securities s on s.org_id = l.org_id and s.id = l.security_id
      left join parties holder on holder.org_id = s.org_id and holder.id = s.holder_party_id
      left join equity_share_classes c on c.org_id = s.org_id and c.id = s.share_class_id
      left join equity_plans p on p.org_id = s.org_id and p.id = s.plan_id
      left join subsidiaries sub on sub.org_id = r.org_id and sub.id = r.subsidiary_id`,
    orgColumn: "l.org_id",
    subsidiaryScope: { column: "r.subsidiary_id" },
    timeKey: "through_date",
    columns: [
      { key: "through_date", label: "Run through", kind: "date", expr: "r.through_date" },
      { key: "security_number", label: "Security", kind: "text", expr: "s.security_number" },
      {
        key: "security_kind",
        label: "Kind",
        kind: "enum",
        expr: "s.kind",
        options: ["option", "rsu"],
      },
      { key: "holder", label: "Holder", kind: "text", expr: "holder.display_name" },
      { key: "share_class", label: "Share class", kind: "text", expr: "c.code" },
      { key: "plan", label: "Plan", kind: "text", expr: "p.code" },
      { key: "subsidiary", label: "Subsidiary", kind: "text", expr: "sub.name" },
      { key: "currency", label: "Currency", kind: "text", expr: "r.currency" },
      {
        key: "cumulative",
        label: "Recognized to date",
        kind: "money",
        expr: "l.cumulative_amount",
        txnCurrency: true,
        snapshot: true,
      },
      {
        key: "previous",
        label: "Previously posted",
        kind: "money",
        expr: "l.previous_amount",
        txnCurrency: true,
        snapshot: true,
      },
      {
        key: "period",
        label: "Posted this run",
        kind: "money",
        expr: "l.period_amount",
        txnCurrency: true,
      },
      { key: "run_id", label: "Run (id)", kind: "uuid", expr: "r.id" },
      { key: "security_id", label: "Security (id)", kind: "uuid", expr: "s.id" },
      {
        key: "journal_entry_id",
        label: "Journal entry (id)",
        kind: "uuid",
        expr: "r.journal_entry_id",
      },
    ],
    defaultSort: { column: "through_date", direction: "asc" },
  },
  {
    ...shared,
    key: "equity_securities_register",
    label: "Equity securities register",
    description:
      "Every security issued by the as-of date, with its terms, status and quantity on that date.",
    from: `equity_securities s
      left join parties holder on holder.org_id = s.org_id and holder.id = s.holder_party_id
      left join equity_share_classes c on c.org_id = s.org_id and c.id = s.share_class_id
      left join equity_plans p on p.org_id = s.org_id and p.id = s.plan_id
      left join equity_financing_rounds rd on rd.org_id = s.org_id and rd.id = s.round_id
      left join subsidiaries sub on sub.org_id = s.org_id and sub.id = s.subsidiary_id
      left join lateral (${SECURITY_STATE_AS_OF}) st on true`,
    orgColumn: "s.org_id",
    subsidiaryScope: { column: "s.subsidiary_id" },
    timeKey: "issue_date",
    // The register as of a date is every security issued on or before it:
    // the as-of date bounds the issue date from above, and no fiscal window
    // ever hides securities issued in earlier years.
    asOfField: "issue_date",
    columns: [
      { key: "issue_date", label: "Issue date", kind: "date", expr: "s.issue_date" },
      { key: "security_number", label: "Security", kind: "text", expr: "s.security_number" },
      {
        key: "security_kind",
        label: "Kind",
        kind: "enum",
        expr: "s.kind",
        options: ["share", "option", "rsu", "warrant", "safe", "note"],
      },
      { key: "holder", label: "Holder", kind: "text", expr: "holder.display_name" },
      { key: "share_class", label: "Share class", kind: "text", expr: "c.code" },
      { key: "plan", label: "Plan", kind: "text", expr: "p.code" },
      { key: "round", label: "Round", kind: "text", expr: "rd.name" },
      { key: "subsidiary", label: "Subsidiary", kind: "text", expr: "sub.name" },
      {
        key: "status",
        label: "Status",
        kind: "enum",
        expr: SECURITY_STATUS_AS_OF,
        options: [...SECURITY_STATUSES],
      },
      { key: "quantity_issued", label: "Quantity issued", kind: "number", expr: "s.quantity" },
      {
        key: "quantity_outstanding",
        label: "Quantity outstanding",
        kind: "number",
        expr: "case when s.kind in ('safe', 'note') then null else st.outstanding end",
      },
      {
        key: "price_per_share",
        label: "Price per share",
        kind: "number",
        expr: "s.price_per_share",
        perShare: true,
      },
      { key: "currency", label: "Currency", kind: "text", expr: "s.currency" },
      {
        key: "consideration",
        label: "Consideration",
        kind: "money",
        expr: "coalesce(s.consideration_amount, 0)",
        txnCurrency: true,
      },
      {
        key: "fair_value_per_unit",
        label: "Fair value per unit",
        kind: "number",
        expr: "s.fair_value_per_unit",
        perShare: true,
      },
      { key: "voided", label: "Voided", kind: "boolean", expr: "st.voided" },
      { key: "security_id", label: "Security (id)", kind: "uuid", expr: "s.id" },
      {
        key: "journal_entry_id",
        label: "Issuance entry (id)",
        kind: "uuid",
        expr: "s.journal_entry_id",
      },
    ],
    defaultSort: { column: "issue_date", direction: "asc" },
  },
  {
    category: shared.category,
    featureKey: shared.featureKey,
    requiredPermission: shared.requiredPermission,
    key: "equity_cap_table_positions",
    label: "Cap table position movements",
    description:
      "Each change of a certificate, award or pool position, split-restated and as converted.",
    from: `equity_position_movements m
      left join equity_securities s on s.org_id = m.org_id and s.id = m.security_id
      left join equity_plans pl on pl.org_id = m.org_id and pl.id = m.plan_id
      join equity_share_classes c on c.org_id = m.org_id and c.id = coalesce(s.share_class_id, pl.share_class_id)
      left join parties holder on holder.org_id = s.org_id and holder.id = s.holder_party_id
      left join subsidiaries sub on sub.org_id = m.org_id and sub.id = m.subsidiary_id`,
    orgColumn: "m.org_id",
    subsidiaryScope: { column: "m.subsidiary_id" },
    timeKey: "effective_on",
    // Positions are cumulative: the as-of date bounds the movements from
    // above only, and no fiscal window ever bounds them from below.
    asOfField: "effective_on",
    columns: [
      { key: "effective_on", label: "Effective date", kind: "date", expr: "m.effective_on" },
      { key: "share_class", label: "Share class", kind: "text", expr: "c.code" },
      {
        key: "class_kind",
        label: "Class kind",
        kind: "enum",
        expr: "c.kind",
        options: ["common", "preferred"],
      },
      {
        key: "position_kind",
        label: "Position type",
        kind: "enum",
        expr: "m.position_kind",
        options: ["share", "award", "pool"],
      },
      { key: "holder", label: "Holder", kind: "text", expr: "holder.display_name" },
      { key: "security_number", label: "Security", kind: "text", expr: "s.security_number" },
      {
        key: "security_kind",
        label: "Security kind",
        kind: "enum",
        expr: "s.kind",
        options: ["share", "option", "rsu", "warrant"],
      },
      { key: "plan_pool", label: "Plan pool", kind: "text", expr: "pl.code" },
      { key: "subsidiary", label: "Subsidiary", kind: "text", expr: "sub.name" },
      {
        key: "outstanding",
        label: "Outstanding shares",
        kind: "number",
        expr: "case when m.position_kind = 'share' then m.shares_delta else 0 end",
      },
      {
        key: "as_converted_outstanding",
        label: "Outstanding, as converted",
        kind: "number",
        expr: "case when m.position_kind = 'share' then m.as_converted_delta else 0 end",
      },
      {
        key: "awards_outstanding",
        label: "Awards outstanding",
        kind: "number",
        expr: "case when m.position_kind = 'award' then m.shares_delta else 0 end",
      },
      {
        key: "pool_available",
        label: "Pool available, as converted",
        kind: "number",
        expr: "case when m.position_kind = 'pool' then m.as_converted_delta else 0 end",
      },
      {
        key: "fully_diluted",
        label: "Fully diluted",
        kind: "number",
        expr: "m.as_converted_delta",
      },
      { key: "shares_delta", label: "Share change", kind: "number", expr: "m.shares_delta" },
      {
        key: "as_converted_delta",
        label: "As-converted change",
        kind: "number",
        expr: "m.as_converted_delta",
      },
      { key: "security_id", label: "Security (id)", kind: "uuid", expr: "m.security_id" },
      { key: "plan_id", label: "Plan (id)", kind: "uuid", expr: "m.plan_id" },
      { key: "holder_party_id", label: "Holder (id)", kind: "uuid", expr: "s.holder_party_id" },
      { key: "movement_id", label: "Movement (id)", kind: "uuid", expr: "m.id" },
    ],
    defaultSort: { column: "effective_on", direction: "asc" },
  },
];
