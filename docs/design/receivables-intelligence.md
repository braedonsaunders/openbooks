# Receivables intelligence

## Product purpose

Receivables Intelligence explains which customers are becoming harder to collect from, what is obstructing collection, and whether collection efforts are improving outcomes. Customers are the default analytical subject. Invoice balances provide evidence; they do not define the entire experience.

This document specifies the replacement dashboard. The existing aging, gross-to-net and maturity composition does not meet this specification. Capabilities described below are requirements, not claims of implemented functionality.

## Product research

The benchmark is a dedicated receivables product with customer context and operational evidence:

- [Billtrust customer records](https://help.billtrust.com/docs/our-products/collections/user-guides/client-record-overview.html) combine payment-pattern changes, collection procedures, account history, credit information and outstanding documents.
- [Billtrust account portfolios](https://help.billtrust.com/docs/our-products/collections/user-guides/accounts-overview.html) expose account hierarchies and customer-level disputed exposure. Its [dispute workflow](https://help.billtrust.com/docs/our-products/collections/user-guides/create-and-manage-disputes.html) records reasons, ownership and supporting evidence.
- [HighRadius collections analytics](https://cloud5.highradius.com/RRDMSProject/help/global/Content/HRC%20Platform/dotOne%20Analytics/CLS/Collections.htm) includes collection activity, dispute performance and promise fulfillment. Its [promise fulfillment dashboard](https://walmart.highradius.com/RRDMSProject/help/global/Content/HRC%20Platform/dotOne%20Analytics/CLS_new/P2P%20Fulfillment.htm) compares agreed amounts with collections against those commitments.
- [Tesorio collections](https://www.tesorio.com/product/collections) includes account prioritization, payment commitments and collector performance. Its [customer collection score](https://www.tesorio.com/blog/tesorios-new-customer-collection-score) segments payment behavior and treats customers without payment history separately.

OpenBooks should provide these customer, commitment, dispute and effectiveness dimensions with transparent calculations, native accounting reconciliation and explicit evidence. Vendor scoring thresholds, external credit assessments and automated recommendations are not accounting facts and must not be copied as universal policy.

## Ownership and reuse

| Surface | Owns | Relationship to Receivables Intelligence |
| --- | --- | --- |
| Banking → Cash Position | Weekly cash planning, forecast methods, scenarios, liquidity and payment timing | Link with the selected customer/entity scope. Use its authoritative forecast model if receipt timing is needed; do not create another prediction model or due ladder here. |
| Cash Flow Analytics | Cash trajectory, inflow/outflow drivers, runway and forecast analysis | Retains those visualizations and headline measures. Receivables contributes observed payment behavior through shared services. |
| AR cockpit | Invoice collection worklist, receiving payments and operational receivables position | Owns collection execution and record mutations. Analytics routes actions into native AR/customer workflows. |
| Customer Intelligence | Commercial relationship health, revenue, profitability, RFM, lifetime value, retention and growth | Retains its commercial analysis. Reuses shared payment facts; does not receive another conflicting collection score. |
| Customer drawer | Customer identity, terms, credit controls, record history and customer-scoped work | Reuse its shell and native services. Add collection evidence to that customer context instead of creating another customer record. |
| Insights Reports | Aging, open AR by customer, invoice registers, reconciliation and exportable analysis | Owns detailed analytical tables, saved views and exports. Dashboard selections link to those reports with matching filters. |

Balances, payment observations and credit exposure must come from shared authoritative services. Reusing an underlying fact is necessary; duplicating whole dashboards, predictions or independently calculated scores is not.

## Page composition

Use the existing native analytics header, period controls, `RecordTabs`, shared KPI/panel/chart components and customer drawer machinery. Preserve the compact OpenBooks layout, typography, teal accent, restrained semantic colors and dark mode.

The header carries period, legal-entity scope, presentation currency, freshness and compact customer search/filter controls. Period means a behavior/collection observation window ending on the displayed as-of date. Exposure is measured at that end date. Prior comparison windows have the same duration; the policy defines the separate payment-history baseline.

Four compact headline cards appear once, followed immediately by the active tab. A small sparkline or distribution strip communicates change. Customer cards should begin in the first desktop viewport; a large introduction, repeated KPI rows and permanent explanatory banners must not push them below the fold.

Currency uses organization presentation settings and shared exact formatters. Currency is identified in normal header/metric chrome and evidence in original currency remains available. Calculation definitions are accessible through contextual help. Banners are reserved for actual refusals or incomplete data affecting the displayed conclusion.

## Tabs and interaction

| Tab | Question | Main composition |
| --- | --- | --- |
| Customers — default | Who needs attention, and why? | A customer portfolio with searchable, bounded customer cards; an exposure-versus-payment-deterioration plot; explainable reason filters. |
| Payment behavior | How is each customer's payment pattern changing? | On-time/late distributions, comparable-period trends, payment variability and terms-relative behavior; customer/cohort selection updates the active analysis. |
| Recovery | Are overdue balances recovering or worsening? | Cohort recovery curves and transitions between delinquency states, with separate cash, credit, write-off, reversal and FX effects. |
| Promises | Are agreed commitments being kept? | Amount-based fulfillment trends, due/broken/partially fulfilled commitments and customer-level evidence. Depends on governed promise records. |
| Disputes | What is preventing collection? | Exposure by reason, unresolved case age, resolution time and repeat disputes; selectable customer/reason cohorts. Depends on commercial receivables cases. |
| Collection effectiveness | Are follow-ups reaching customers and producing outcomes? | Eligible reminder coverage, delivery failures, overdue follow-ups, contacted versus uncontacted recovery cohorts and portfolio workload when assignment is available. |

Tabs replace the active body. Large analytical registers belong in Reports; action queues belong in AR. Customer cards and charts provide a bounded interactive projection, with a report link for the complete analytical population.

Customer cards include:

- Native customer identity, optional authorized account-group context and collection owner.
- Overdue exposure, open exposure and credit headroom, with distinct labels and currencies.
- Recent days beyond terms versus that customer's established baseline, a trend sparkline, and eligible observation count.
- Evidence-backed reasons such as deteriorating payment timing, repeated severe delinquency, failed reminder delivery, overdue follow-up, broken commitment or unresolved dispute.
- Latest qualifying collection activity, next planned action and a supported action/link.

Selecting a card opens the native customer drawer at the collection context. Its customer-scoped children cover payment evidence, commitments, disputes and communication history. Selecting an invoice opens the existing document drawer. Selection, tab and filters remain URL-addressable; loading, refusal and retry retain one drawer shell.

No unsupported signal may be rendered as a successful zero. Customers without enough payment observations show insufficient history; they do not inherit a company average and become apparently reliable. Multiple reason filters form a union and do not duplicate customer exposure.

## Headline and landing-card measures

The landing card uses the same canonical summary projection as the page, limited to four measures and a small recovery trend. Its final measures are:

1. **Exposure at customers needing attention:** open positive overdue exposure for the distinct customers matching enabled, effective collection-attention rules. Count and rule breakdown are available on selection.
2. **Payment deterioration:** customers whose recent payment observations have worsened beyond the configured threshold against their comparable baseline, with sufficient observations. Supporting exposure is secondary.
3. **Overdue-cohort cash recovery:** actual cash applied during the observation window to the invoices overdue at its opening, divided by their opening eligible amount. The cohort is fixed and credits/write-offs do not count as cash collected.
4. **Promise fulfillment:** cash matched to eligible commitment amounts due within the window divided by those committed amounts, with partial fulfillment and reversals recognized.

The fourth measure requires the promise foundation. Before that foundation exists, a source-backed **overdue exposure with failed/suppressed reminders** can be used with an explicit label; it must not be presented as uncontacted exposure or a substitute promise rate. Released card definitions remain stable and versioned, and preview/page/report consumers use the same definition.

## Calculation contracts

All measures carry observation window, exposure as-of date, authorized legal-entity scope, presentation basis, eligible population, missing-data status and source revision.

### Open exposure

Reuse the shared historical open-item population and dated applications/unapplications. Retain the existing guarantees for posted/reversed history, entity isolation, per-line exact translation and missing-rate refusal. Separate unapplied credits and unassigned balances. A credit against one document or customer does not clear another overdue invoice implicitly.

Contractual lateness requires a due date. A posting-date fallback may remain the native aging report convention, but must not label an undated obligation as contractually late in payment-behavior scoring. Undated amounts appear as incomplete terms with a native correction route.

### Payment behavior

Extend the shared payment-observation service rather than adding a second calculator to the page. Distinguish invoice-to-application lag, days beyond invoice terms, cash application observations and final settlement. Do not call a mean settlement lag DSO or change an existing consumer's definition silently.

Provide recent and baseline counts, sums, squared sums and on-time/late counts, scoped by organization, entity, customer and observation date. Final-settlement timing, median and percentile measures require their own sufficient facts or bounded distribution structures; mean/variance rollups cannot reconstruct them.

Cash receipts, credit applications, write-offs and reversals have separate classifications. Partial payments must not count as multiple fully paid invoices. Historical analysis must consider each event's effective and reversal/unapplication date and avoid learning from payments recorded after the as-of date.

### Recovery and migration

Freeze an eligible overdue cohort at the opening date. Track cash recovered, remaining amount, approved credits, write-offs and reversals separately. Attribute each settlement leg once. Cap the recovery numerator to the eligible obligation and represent subsequent unapplication/refund effects according to the native accounting event.

Delinquency transitions follow the same cohort between opening and closing dates; new billings are a separate population. A reduction caused by FX translation, credit or write-off must not be styled as successful collection. Display original/functional-currency recovery and the explicit presentation translation effect as needed for reconciliation.

Collection-effectiveness index and average-days-delinquent may be added only with approved canonical definitions, eligible sales/receivables populations and a bridge separating noncash reductions. They must not be inferred from a current balance alone or used as another ambiguous DSO label.

### Commitments and disputes

Promise fulfillment uses agreed amount, currency, due date, covered obligations, accepted revision and matched cash evidence. A promised date on an invoice alone is insufficient. Amendments/cancellations cannot erase previous broken commitments or retroactively improve prior-period results.

Disputes represent commercial invoice/payment blockers, not provider chargebacks. Track disputed versus undisputed portions, lifecycle, reason, owner, customer, entity, timestamps and evidence. A dispute does not change posted AR; financial resolution uses existing governed commands. Avoid double-counting overlapping disputed portions.

### Collection activity

Reuse native dunning evidence and linked CRM activities. Queued, failed or suppressed reminders are not successful contact. Provider acceptance must be labeled consistently with existing delivery evidence and must not imply the customer opened or answered a message.

An absence of a reminder is not evidence that nobody contacted the customer. Contact coverage needs an authorized, linked activity population and explicit eligible-document/period rules. Private or inaccessible CRM activity must not leak through aggregates or cause misleading uncontacted claims. Partial coverage is labeled or withheld.

Recovery following an intervention is an observed association. Do not label it causal effectiveness or attribute every payment to the latest collector/reminder. Attribution windows and ownership are explicit, effective configuration, with unassigned and unattributed outcomes visible.

## Native foundations and gaps

| Capability | Current native foundation | Required work |
| --- | --- | --- |
| Historical AR/customer exposure | `web/lib/cash/open-items.ts`, `ar-position.ts`, `receivables-data.ts` | Preserve exact historical population; project customer-first measures and separate missing terms. |
| Payment behavior | `web/lib/cash/core.ts` payment statistics; customer analytics and pulse consume payment facts | Extend one shared observation contract with terms-relative, period-comparison and cash/noncash semantics. Existing company rollup lacks the entity dimension and cannot be the unrestricted source for scoped behavior. |
| Credit controls | Customer role and `web/lib/customer-pulse.ts` | Extract a shared bounded credit-exposure reader; retain native terms/hold/currency policy. Current role state must be labeled current unless historical versions exist. |
| Reminder delivery | `engine/src/receivables/dunning.ts`, `dunning_log`, native delivery/outbox | Aggregate genuine delivery outcomes and stage eligibility without sending from analytics. |
| Tasks, calls and notes | `crm_activities`, linked subjects, native CRM authorization | Reuse native records; add supported collection-purpose links/outcomes and scope-aware portfolio ownership rather than a second activity log. |
| Payment commitments | Document `expected_pay_date`; collection detector reads overdue expected dates | Add governed amount-bearing commitments, covered obligations, revisions and payment matching. Expected-date detector findings remain distinct from contractual promise fulfillment. |
| Commercial disputes/deductions | Provider payment disputes exist for a different purpose | Add a native receivables case lifecycle and partial disputed amounts; do not reuse PSP chargebacks as invoice disputes. |
| Customer groups | Native party/relationship machinery | Validate authoritative hierarchy and authorized member scope before group rollups; do not infer a parent from customer naming. |

The full promise/dispute/effectiveness experience requires these operational foundations. A dashboard-only patch cannot honestly provide benchmark parity. Base customer, behavior and recovery views can ship from native accounting facts; dependent tabs ship with their real records and workflows, without permanent placeholder charts.

## Operational record contracts

Commitments belong to the Receivables domain. Capture the customer, legal entity, source communication, currency, amount, due date, covered obligations and authorized actor. Supported states distinguish draft, active, partially fulfilled, fulfilled, breached, cancelled and superseded. Breach is evaluated at the configured effective cutoff; cash matching and later reversals can change fulfillment without deleting the preceding history. Revisions preserve the prior agreement and require an explicit reason. Allocation cannot exceed eligible covered obligations or match the same receipt twice.

Commercial cases distinguish open, investigating, awaiting customer, awaiting internal action, resolved and cancelled. Each transition records actor, timestamp, reason and evidence. Resolution records the operational outcome and any referenced native credit/refund/adjustment command; closing a case is never itself a ledger write. Track partial disputed amounts in document currency and preserve resolved/cancelled history.

Both models use native service commands, typed `defineRoute` boundaries, organization/entity/reference validation, action permissions, optimistic concurrency and audit. Financial concessions retain the native approval and segregation-of-duties rules. Data models, forward migrations and module dependencies follow the published allocation and rollout process; analytics does not create these records with direct SQL.

Collection assignment records effective ownership intervals rather than overwriting the collector responsible for historical work. Reuse native user/team identity and CRM activities. A collection activity needs an explicit purpose/outcome before contributing to collection coverage; an unrelated sales email or private note does not qualify automatically. Base AR remains useful when CRM is disabled; CRM-dependent activity analysis follows its native gates.

## Packs, features and permissions

The dashboard belongs to **Base ERP → Accounts Receivable**, using the existing analytics catalog and per-user visibility library. Enforce `reports.read`, `ar.read` and legal-entity scope at loaders/APIs. Customer identity/drawer, CRM activity, actions and setup changes retain their native additional permissions. Do not expose restricted signals through totals, ranks, caches or explanatory reasons.

Company Features remains the only organization switchboard. Additional capability gates reuse native feature dependencies; personal visibility never changes data access. Missing optional capabilities hide their dependent sections or provide an explicit enable/setup route, preserving stored records and history.

Industry extensions contribute real evidence to the same customer analysis:

- Construction/projects: distinguish retainage not yet collectible, certification/approval blockers and progress-billing disagreements, gated by Projects and the relevant billing capabilities.
- Distribution/manufacturing: reason-coded deductions, returns, shortages, pricing or delivery-evidence blockers, dependent on native commercial case/document links.
- Subscription businesses: payment-method failure and renewal-related billing blockers, dependent on Billing and Payments. Provider failures remain distinct from commercial disputes.
- Professional services: acceptance/milestone blockers and disputed time/expenses, dependent on Projects and native billing evidence.

These are proposed adapters, not new hardcoded industry schemas or alternate AR balances. No optional adapter may require duplicating commercial profitability, project profitability or cash forecasting.

## Performance and operational contract

One authoritative service provides customer collection facts and metrics. The page, landing card, customer drawer, operational consumers and Reports use defined projections of that service.

Maintain shared aggregates with organization, legal entity, customer, event date, currency/book basis and metric revision. Use sufficient statistics for exact additive measures and dedicated cohort facts for recovery. Update from native transactional events/outbox, with idempotency, correction/reversal handling, deterministic replay and reconciliation to the underlying ledger. Reuse existing projection machinery after checking its guarantees.

Landing requests read a small summary projection; they do not load all customer histories or invoke every tab loader. Concurrent readers share safe tenant/entity-scoped work. Customer search/ranking and pagination execute server-side against authorized projections. Chart bins and initial customer cards are bounded; full-register export uses Reports.

Load tab-specific datasets only when that tab opens, and customer evidence only for the selected customer. Cache keys include normalized scope, period, currency/book basis, policy version and source revision. Cross-tenant, cross-entity and cross-permission cache reuse is prohibited. Incomplete rebuilds expose freshness/availability rather than a partially published aggregate.

Performance acceptance targets, to be measured against the combined release tree with millions of transaction lines and concurrent users:

- No raw ledger scan per landing card or per warm tab request.
- No per-customer query loop, all-customer client payload or unbounded invoice transfer.
- Warm summary projection p95 below 300 ms; warm initial/tab projection p95 below 750 ms under the agreed representative load, excluding client render/network time.
- Initial customer payload bounded to a documented page size, with server-side continuation; chart/detail payload budgets recorded with the implementation.
- Scoped/entity-restricted users use dimensioned projections and preserve the same semantics and performance expectations as unrestricted users.

These are product targets, not measured results.

## Delivery and acceptance

1. Consolidate shared payment/credit/exposure contracts and build customer, payment-behavior and recovery projections. Replace the default aging overview, maturity tab and gross-to-net centerpiece with the customer portfolio and behavior evidence. Retain reports/operational links.
2. Add governed commitments and commercial disputes through native AR/customer workflows, then their analytics projections and tabs. Extend CRM collection context and portfolio assignment to complete effectiveness analysis.
3. Add gated industry adapters using the same contracts; complete populated/empty/refused/small-screen composition and accessibility review.

Meaningful acceptance covers exact reconciliation; partial settlement and noncash classification; historical application/unapplication/reversal dates; new/insufficient-history customers; missing due dates, credit policy and FX rates; distinct customer unions; privacy/permission/entity isolation; promise revision and matching; partial dispute lifecycle; reminder failure versus contact; deterministic replay, freshness and concurrent projection readers.

Preview, selected tab and matching Report must agree at the same scope/date/source revision. No customer drill opens a generic unrelated page or loses its selected context. Evidence connects every highlighted reason to authorized native records. No average, score, causal claim or successful zero is invented to fill unavailable data.
