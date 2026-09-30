# Industry demo companies

OpenBooks ships eleven deterministic master demonstrations, one for each industry offered by the setup wizard. They combine simulated accounting history with native records for industry workflows. The catalog lives in `engine/src/sample-companies/catalog.ts`; the feature matrix and evidence manifest use the authoritative Company Settings → Features registry. Tests refuse an uncovered feature or a missing feature dependency.

| Industry | Master company | Operational examples |
| --- | --- | --- |
| General business | Cedar & Stone Supply Co. | CRM, banking, allocations, governance, integrations |
| Construction | Summit Ridge Construction | Job costing, site time, field tickets, subcontracts, retainage, compliance |
| Professional services | Meridian Advisory Group | Engagements, time, staffing requests, retainers, HR |
| Engineering and architecture | Aperture Engineering Group | Projects, schedules, subconsultants, equipment |
| Software and SaaS | Northstar Cloud | Subscriptions, versioned plans, metered usage, revenue recognition, SaaS metrics |
| Accounting firms | Ledgerline Advisory LLP | Engagements, time, retainers, WIP, close configuration |
| Wholesale distribution | Harborline Distribution | Stock receipts, orders, warehouse picks, drop shipping, a posted invoice and authorized return |
| Property management | Hearthstone Property Management | Residential and commercial properties, active rent schedule, draft commercial lease, CAM budgets |
| Nonprofit | BrightPath Community Foundation | Operating and restricted funds, conditional award, pledges, encumbrances, functional reporting |
| Manufacturing | Atlas Components Manufacturing | Stock, BOM, routing, work center, work order, MRP policies |
| Healthcare | Northshore Family Health | Supplies, assets, employment, qualifications, payroll configuration |

The setup wizard's launch step offers **Create an industry sample company**. Selecting it creates a separate preview tenant and maps the requesting member to its tenant-local administrator. The completion screen offers a direct action to enter it. Users can also create industry samples under Import & Export and switch between workspaces through the existing account menu. The live company's books receive no demonstration transactions.

## Installation preparation

Prepare masters before inviting users so their first demo request only needs to clone a ready source. Run a maintenance build matched to the database's applied schema, with the normal database and dedicated bypass-role configuration; do not give migration or bypass credentials to a browser. Upgrade the database through the normal release process before running a newer engine build against it.

From a source checkout:

```sh
npm -w engine run samples -- prepare
npm -w engine run samples -- inventory
```

The production image includes the same command:

```sh
node scripts/sample-companies.mjs prepare
node scripts/sample-companies.mjs inventory
```

Use `prepare --industry manufacturing` to prepare one industry. Preparation is serial, locks each profile's source selection, and checks accounting-history minimums, native scenario evidence, and full ledger/subledger reconciliation. Each tenant's scenario installation commits atomically, including audit evidence, feature settings, normal-service posting, and preview protection. Stable identities and posting idempotency keys make a completed retry read-only. Existing closed history is preserved; a fully closed calendar is extended through the normal fiscal-calendar service.

To provision an exploration tenant for every master for an existing member:

```sh
node scripts/sample-companies.mjs install \
  --member-user MEMBER_UUID --source-org HOME_ORG_UUID --member-name 'Member name'
```

The member must already have access to the named source organization. Add `--industry KEY` to create one sample. Existing member samples are reused. The setup wizard uses this same governed creation pipeline, including clone recovery, numbering reconciliation, and access granted only after finalization.

An interrupted simulator build retains its manifest directory in the preparation error. Resume the recorded run with:

```sh
node scripts/sample-companies.mjs resume --run-dir /path/to/recorded/run
```

Resume validates the manifest against the synthetic tenant and holds the profile lock through verification and registration. It does not adopt arbitrary tenants or incomplete accounting history.

## Exploration boundaries

These are synthetic preview environments. Payment acceptance, bank feeds, API credentials, kiosks, apps, scripts, AI capabilities, approval flows, and automation recipes start disconnected, inactive, or in draft as appropriate. Operators review and enable configurations through the normal setup surfaces. Payroll installs the US component pack and draft records; statutory inputs and employer registrations must be configured before calculation. No statutory rate is fabricated or silently priced at zero.

The coverage manifest distinguishes workflows, configuration examples, workspace tools, and unsupported execution. Field-change automation and outbound automation webhooks currently support draft configuration but do not support execution; their samples and manifest say so explicitly. Configuration coverage does not certify that an external service has been connected or that every lifecycle transition has occurred.

Posted examples use the normal ledger services, balanced decimal amounts, approvals, organization scope, and period controls. Corrections continue to use reversals or adjustments. Master registration alone does not prove readiness: the application checks the version, feature dependencies, native scenario identities, feature evidence, and recorded accounting verification before advertising a source as ready. Preparation reruns the complete accounting checks in a consistent snapshot before certifying the source.
