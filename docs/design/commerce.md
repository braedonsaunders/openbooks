# Commerce channels, stored value and recurring collection

This document defines how OpenBooks runs a business that sells through an
online storefront (Shopify first, other storefronts through the same
contracts) or bills software subscriptions. It is the single reference for the
data model, feature gates, engine modules, accounting treatment and screen
composition of that work. Every change in this area conforms to it; a change
that needs a different decision updates this document in the same commit.

## Principles

- **OpenBooks is the book of record.** A storefront is a sales channel. Orders,
  refunds, payouts and stock flow into native documents, journals and stock
  movements. Nothing is mirrored into a parallel ledger, and no storefront
  number is trusted without being reconciled to a native record.
- **Every external identity is a link, never a column.** One table,
  `external_links`, maps `(channel, object type, external id)` to one native
  record. Unique on both sides. No `custom->>'shopifyId'`, no per-connector
  link tables.
- **Ingestion is idempotent and replayable.** Inbound events are stored raw
  and verified before processing, deduplicated by the provider's event id,
  processed by a worker with retries, and can be replayed from the activity
  log. Processing the same event twice produces the same records once.
- **Refusals reach the operator.** An order that cannot be posted (unmapped
  SKU, closed period, missing tax mapping, unknown payment gateway) is parked
  in the channel's exception queue with the reason and the remedy, never
  dropped and never posted with a fallback account.
- **Configuration is effective-dated and lives in Setup.** Channel account
  mappings, posting mode and tax treatment carry `effective_from`, so changing
  them never reinterprets posted history.
- **Money is bigint minor units.** Storefront amounts are parsed with the
  currency's exponent through `engine/src/money/money.ts`; never floats.

## Feature gates

All gates live on **Company Settings → Features** in
`engine/src/organization/feature-registry.ts` and are enforced in pages
(`requireFeatureEnabled`), API routes (`defineRoute({ feature })`) and inside
write transactions (`lockAndCheckOrgFeature`).

| Key | Category | Depends on | Purpose |
| --- | --- | --- | --- |
| `salesChannels` | sales | `orders`, `inventory` | Channel connections, external links, inbound activity, channel orders |
| `itemVariants` | operations | `inventory` | Product families with option-based variant items |
| `cashSales` | sales | — | Paid-at-sale `cash_sale` and `cash_refund` documents |
| `storedValue` | sales | — | Gift cards and store credit as liabilities |
| `promotions` | sales | `orders` | Promotion codes captured on discount lines, with reporting |
| `outboundWebhooks` | platform | `apiAccess` | Signed event delivery to subscriber endpoints (the existing `automationWebhooks` gate requires it) |
| `autopay` | sales | `onlinePayments` | Stored payment methods, automatic collection, payment retries |
| `revenueContracts` | sales | `revenueRecognition` | Contracts spanning orders, subscriptions and several invoices |

Turning a gate off hides and refuses the surface; it never deletes data.

## Engine modules

| Module | Owns |
| --- | --- |
| `commerce` (new) | Channels, external links, inbound events, channel orders, order ingestion, posting modes, exception queue, the channel adapter contract, and adapters under `commerce/shopify/` |
| `connectors` | HTTP clients only. `connectors/shopify.ts` is the Shopify Admin GraphQL client (auth, rate-limit cost handling, pagination), using `http-retry.ts` and `ssrf-guard.ts` |
| `webhooks` (new) | Subscriber endpoints, event catalog, signed delivery, retries, delivery log |
| `stored-value` (new) | Gift card and store credit accounts, issuance, redemption, breakage, expiry |
| `sales` | `cash_sale` / `cash_refund` behaviour, promotions, restocking fees, kit explosion at fulfilment |
| `inventory` | Variant generation, kit availability |
| `payments` | Stored payment methods, automatic collection, PSP refund/dispute automation, new payout parsers |
| `receivables` | Retry-aware dunning and suspension policy |
| `revenue` | Contracts spanning documents |
| `billing` | Scheduled usage rating, Stripe Billing import wiring, recurring-revenue metrics |
| `tax` | Provider commit/void, marketplace-facilitator treatment |

`commerce` is the only module that knows a storefront exists. Adapters
translate the storefront's objects into the channel-neutral types in
`commerce/contracts.ts`; posting code never branches on `shopify`.

## Data model

All tables carry `org_id`, ENABLE + FORCE row-level security with the
`org_isolation` policy, composite tenant foreign keys, `created_at/by`,
`updated_at/by`, and are registered in the sandbox policy, query catalog and
PII inventory.

### Integration substrate (`commerce`)

- **`sales_channels`**: one row per connected storefront. `kind`
  (`shopify`), `name`, `status` (`draft | connecting | active | paused |
  disconnected | error`), `subsidiary_id`, `currency`, `external_account`
  (shop domain), sealed `secrets` (purpose `sales_channel.secrets`),
  `settings` (validated per kind), `webhook_secret` (sealed),
  `last_sync_at`, `health` (last error, last success per stream).
- **`sales_channel_account_maps`**: effective-dated posting configuration per
  channel: clearing account per payment gateway, revenue/discount/shipping
  income accounts, gift card liability, sales tax liability by jurisdiction
  source, rounding account. Exactly one open row per (channel, role, key).
- **`sales_channel_locations`**: storefront location ↔ native stock location,
  with `sync_inventory` and `fulfils_orders` flags.
- **`external_links`**: `channel_id` (nullable for platform links such as
  Stripe), `provider` (`shopify | stripe | …`), `external_account`,
  `object_type` (`product | variant | customer | order | refund | fulfillment
  | payout | location | gift_card | subscription | price | meter | …`),
  `external_id`, `external_parent_id`, `native_table`, `native_id`,
  `external_updated_at`, `last_synced_at`. Unique on
  `(org, provider, external_account, object_type, external_id)` and on
  `(org, provider, external_account, object_type, native_id)`.
  `stripe_billing_links` is migrated into this table and dropped.
- **`integration_inbound_events`**: raw body (bytea), headers subset, topic,
  provider event id (unique per channel), `received_at`, `verified`,
  `status` (`pending | processing | processed | ignored | failed |
  dead`), `attempts`, `next_attempt_at`, `error`, `result_ref`.
- **`channel_orders`**: the channel subledger, one row per storefront order:
  external id and number, customer link, currencies (shop and presentment),
  totals in minor units, financial and fulfilment status, `posting_status`
  (`pending | posted | summarized | exception | excluded`),
  `posting_document_id`, `summary_id`, `exception_code`, `exception_detail`,
  normalized `lines` (sku, variant link, quantity, price, discounts, tax
  lines with jurisdiction and `collected_by`, gift card flags), shipping
  lines, tenders (gateway, amount, gift card id).
- **`channel_order_events`**: refunds, cancellations, edits, fulfilments per
  order, each with its own posting status and document.
- **`channel_daily_summaries`**: daily summary posting batches per channel,
  day, location and currency, with the posted document.

### Catalog (`inventory`)

- **`item_families`**: the parent product: `code`, `name`, `description`,
  `category`, default kind, default unit, default price.
- **`item_family_options`**: ordered options per family (`Size`, `Color`),
  each with ordered `values`.
- **`items.family_id`** and **`items.option_values`** (jsonb map option →
  value). A variant is an ordinary item: stock, costing, pricing, tax and
  documents work unchanged. Unique `(org, family_id, option_values)`.

### Documents (`sales`, `ledger`)

- **`cash_sale`**: party optional (walk-in), lines with items, tax,
  discounts, shipping; tenders (`deposit_account_id` or clearing per
  payment method, gift card redemptions). Posts DR clearing/bank per tender
  and DR stored-value liability for gift card tenders, CR revenue lines, CR
  tax, and issues stock (COGS) through the invoice issue path. Not an open
  item. Counts in sales tax returns, nexus, revenue metrics and analytics
  everywhere `customer_invoice` does.
- **`cash_refund`**: refunds a cash sale or channel order: reverses revenue,
  tax and (when restocked) stock at original cost; pays out to the original
  tender or issues store credit.
- **`documents.external_ref`** and **`documents.source_channel_id`**: the
  channel order reference shown on every document created from a channel.

### Stored value (`stored-value`)

- **`stored_value_accounts`**: `kind` (`gift_card | store_credit`), code
  (hashed, last four shown), customer (required for store credit), currency,
  `issued_minor`, `balance_minor`, `status`, `expires_on`, liability account,
  `source_channel_id`.
- **`stored_value_entries`**: immutable ledger: issue, redeem, adjust,
  expire, breakage, reversal; each references its document and journal.
- Breakage follows ASC 606-10-55-48: proportional recognition by redemption
  pattern when the org expects breakage, otherwise on remote likelihood.
  Unclaimed-property (escheat) reporting is a report entity.

### Promotions and returns (`sales`)

- **`promotions`**: code, name, kind (`percent | amount | free_shipping |
  bogo`), channel scope, active window. Discount lines carry `promotion_id`;
  a report entity reports redemptions, discount given and attached revenue.
- **`restocking_fee_policies`**: percent or fixed amount per item category,
  income account, applied on RMA inspection as a fee line on the customer
  credit or cash refund.

### Webhooks (`webhooks`)

- **`webhook_endpoints`**: URL (SSRF-guarded, HTTPS only), sealed signing
  secret with rotation (two secrets during a roll), subscribed event types,
  status, failure counter, auto-disable threshold.
- **`webhook_events`**: the domain event outbox (event type, entity, payload
  snapshot, occurred_at).
- **`webhook_deliveries`**: per endpoint and event: attempt count,
  next attempt, response code and body excerpt, latency, status.
- Signature header `OpenBooks-Signature: t=<unix>,v1=<hex hmac-sha256 of
  "t.body">`, the same scheme the inbound Stripe verifier accepts.
- Event catalog: `document.posted`, `document.voided`, `item.updated`,
  `inventory.available_changed`, `customer.updated`, `payment.received`,
  `invoice.overdue`, `subscription.changed`, `channel_order.exception`.

### Recurring collection (`payments`, `receivables`, `billing`)

- **`customer_payment_methods`**: provider, provider customer and method
  ids, brand, last four, expiry, mandate link for bank debit, default flag,
  status. No card numbers are ever stored.
- **`autopay_enrollments`**: customer or subscription scope, method,
  status.
- **`collection_attempts`**: invoice, method, amount, provider reference,
  status, decline code, retry schedule position.
- Retry schedule and suspension policy live on the dunning policy (Setup):
  retry offsets, final action (`none | suspend | cancel`), grace days.

### Revenue contracts (`revenue`)

- `revenue_contracts` gains `source_document_id` (sales order or
  subscription) and `scope` (`invoice | order | subscription`). Invoices
  billed against an order-scoped contract add consideration to the same
  contract; allocation is recomputed across all obligations, with
  contract asset (unbilled) and contract liability (deferred) netted per
  contract.

## Channel ingestion

1. **Connect.** Shopify connects with OAuth when the platform has a Shopify
   app configured (`SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`), otherwise
   with a custom-app Admin API token. Scopes are the minimum for products,
   inventory, orders, fulfilments, customers, gift cards and Shopify Payments
   payouts. Connecting registers the webhook subscriptions and runs an
   initial catalog and location import.
2. **Catalog.** Products and variants are matched to native items by SKU,
   then barcode, then left in the mapping queue. The operator can match,
   create (a family plus variant items, or a single item) or ignore. Every
   decision is an `external_links` row.
3. **Inventory.** Available-to-sell for each mapped location is pushed to
   the storefront when it changes (`inventory.available_changed`) and
   reconciled on a schedule. A conflict (storefront quantity changed outside
   OpenBooks) is surfaced, never silently overwritten.
4. **Orders.** `orders/create`, `orders/updated`, `orders/cancelled`,
   `refunds/create` and `fulfillments/*` webhooks land in
   `integration_inbound_events`; the worker normalizes them into
   `channel_orders` and `channel_order_events`, then posts according to the
   channel's posting mode:
   - **Per order**: paid orders become a `cash_sale` (or a sales order when
     OpenBooks fulfils and the order is unpaid); refunds become a
     `cash_refund`.
   - **Daily summary**: one `cash_sale` per channel, day, location and
     currency, with lines aggregated by item, tax jurisdiction and tender;
     the per-order detail stays drillable in `channel_orders`.
   Stock is issued on fulfilment when OpenBooks is not the fulfiller, and by
   the native shipment when it is.
5. **Payouts.** Shopify Payments payouts and balance transactions import as
   PSP settlement batches (`shopify_payments`), clearing the gateway clearing
   account to the bank with fees, refunds, chargebacks and adjustments.
6. **Exceptions.** Anything unpostable is parked on the channel's exception
   queue with a code, the reason and a one-click remedy where one exists
   (map SKU, map location, set account, reopen period), then retried.

## Screens

Every screen is a `ModuleView` page with a `view.ts` spec and registered
widgets, composed from the shared components named here. No raw tables,
dialogs or bespoke list components.

| Surface | Route | Composition (exemplar) |
| --- | --- | --- |
| Channels home | `/channels` (Customers → Sell & collect) | Cockpit like `/purchasing` (`statTile` grid, `panel`, `widgetBlock`); one card per channel with status `Badge`, health line and Connect/Resume actions, as in `sync/PlatformClient.tsx` |
| Channel workspace | `/channels/[id]` | `DetailPageLayout` + `PageHeader`; `DrawerTabStrip` tabs: Overview, Products, Locations & stock, Orders, Exceptions, Payouts, Activity, Settings |
| Product mapping | Products tab | `EntityListView` over `external_links` + unmatched queue; row actions via `ContextMenu`; match picker uses `SearchSelect` on items |
| Orders / exceptions | Orders, Exceptions tabs | `EntityListView` sources `channel_order`, `channel_exception`; order opens in `UrlDrawer` via `ListDrawerHost` |
| Activity | Activity tab | `PagedTable` over `integration_inbound_events`, replay action |
| Channel settings | Settings tab | `SetupEntitySection` for account maps and locations (rehomed setup entities) |
| External IDs on records | Item, customer and document drawers | A rehomed child setup entity over `external_links` (`parentRecords`), read-only chips with deep links |
| Variants | Item drawer → Variants tab; `/items/families/[id]` | `LineGrid` for the option matrix, `DrawerTabStrip` tab like Pricing (`ItemPriceMatrixEditor`) |
| Cash sales / refunds | Standard document drawer | `DOC_KINDS` entry; `RecordListView` list at `/cash-sales` |
| Gift cards & store credit | `/stored-value` | `ListPageLayout` + `EntityListView`; account opens in `UrlDrawer` with ledger `PagedTable` |
| Promotions | Setup → Sales → Promotions | Setup registry entity |
| Webhooks | Settings → Developers (beside API keys) | `ListPageLayout` + `EntityListView`; endpoint `UrlDrawer` with deliveries `PagedTable`, secret rotation via `confirmDialog` |
| Payment methods & autopay | Customer drawer tab; Setup → Collections | Rehomed setup entity; dunning policy setup entity |
| Reports | Reports hub | Report engine entities: channel sales, promotion performance, gift card liability roll-forward, unclaimed property, payout reconciliation, recurring revenue (ARR/NRR) |

All strings ship in the seven locale catalogs. Status vocabulary maps to the
shared `Badge` variants: active/processed → success, pending/connecting →
secondary, paused → outline, exception/failed → warning, error/dead →
destructive.

## Public API

Everything a storefront or billing system needs is reachable through
`/api/v1` with `Idempotency-Key`: sales orders with lines, cash sales and
refunds, customers upsert by external reference, available-to-sell by item
and location, gift card balance lookup and redemption, payment method
attach, usage records, and `external_ref` on every document create.
