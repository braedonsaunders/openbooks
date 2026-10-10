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

## Version 5 operating policy

Version 5 adds deterministic commercial cycles alongside the simulator's history. The source manifest describes expected coverage; it does not certify an installed company. Use the native inspection and accounting qualification after population to establish actual readiness. Unreleased manufacturing subcontract functionality remains **upcoming** and is excluded from available coverage.

| Industry | Vendor bills (posted minimum) | Customer invoices (posted minimum) |
| --- | ---: | ---: |
| General business | 36 (24) | 18 (12) |
| Construction | 48 (36) | 18 (12) |
| Professional services | 36 (24) | 24 (18) |
| Engineering and architecture | 42 (30) | 18 (12) |
| Software and SaaS | 36 (24) | 36 (24) |
| Accounting firms | 36 (24) | 30 (24) |
| Wholesale distribution | 72 (60) | 48 (36) |
| Property management | 48 (36) | 30 (24) |
| Nonprofit | 36 (24) | 18 (12) |
| Manufacturing | 60 (48) | 36 (24) |
| Healthcare | 42 (30) | 30 (24) |

Each industry has six named operating vendors and four customers, industry-specific services, and three accounting months of history. Qualification requires paid, part-paid and open invoices and bills. There are three examples each of vendor credits, customer credits, expense reports, checks, deposits, card charges, card refunds and transfers; two of each follow native release and posting. Three supplier payments and three customer receipts include full settlement, partial settlement and linked credit application. Where enabled, orders add three quotes, three sales orders and six purchase orders; cash sales add three sales and three refunds, two of each posted through native tenders.

Four dedicated operating, reserve, payroll-funding and settlement accounts carry imported statement evidence, native matches and signed reconciliations. Payroll funding illustrates treasury movement; it does not claim a calculated payroll run. Existing reconciliation sessions remain intact. Projects add three named engagements, each with three tasks and work entries. Relevant industries add linked stock, subcontracts and schedules of values, property units and lease charges, grants and pledge installments, equipment, and manufacturing work orders. Construction progress includes a measured-quantity correction through the append-only native reversal service.

The policy lives in `engine/src/sample-companies/policy.ts`. Amounts are exact decimal commercial assumptions; no invented statutory facts or rates are included. Authored orders and expenses remain drafts until normal native release and posting. Their references are validated within the company and every insertion is actor-audited. Required independent approvals refuse with a remedy; preparation never substitutes an artificial approval or posted state.

## Feature coverage additions

The source manifest assigns every available registry key to at least one company and resolves its native dependencies. These additions close the earlier coverage gaps:

| Demonstration | Added capabilities and useful evidence |
| --- | --- |
| General business | E-invoicing seller configuration; internal billing rule; sales team, quotas and territories; promotions; cash sales and refunds; inactive stored-value programs; disabled outbound webhook endpoint |
| Construction | Contractor evidence workspace with jurisdiction limits; budgeted project progress and correction; work awaiting approval for unbilled-revenue accrual |
| Software and SaaS | Cross-border supply-location evidence; valued subscription quotes; consolidated billing relationships; historical billing-import draft; paused autopay; portal content settings; draft revenue contracts; contract-cost policy |
| Wholesale | Native supplier-owned consignment receipts; item families and variants; package presets; demand policies; disconnected storefront |
| Healthcare | Training-course drafts; recurring shift definition; disconnected attendance device; shift-closing prerequisites; compensation package configuration |

`mode` describes the type of demonstration. `stage` distinguishes draft records, configuration, executed native workflows, workspace evidence and unsupported execution. A workflow draft does not prove execution. The inspection output separately reports each feature's enabled flag, actual table counts, expected stage and verified execution flag. Preserving member refresh never certifies an operator-modified workflow as executed merely because its inherited record remains present.

Contractor withholding requires applicable legal entities and verified registrations; the US sample does not pretend to have UK, Irish or German statutory standing. Shift closing requires reviewed published shifts and clock evidence. Autopay, carrier label purchasing, payment acceptance, storefront sync and outbound delivery remain disconnected. The disabled webhook example uses the installation's existing data-sealing configuration and no event subscriptions or external call.

## Preserving master and member upgrades

Existing exploration companies are upgraded in place. Requesting an already-created sample still opens it; the maintenance refresh handles installed versions explicitly. No reset, drop, replacement tenant or journal rewrite is part of this upgrade.

After installing a qualified production image, review the source expectations and full population inventory. In a source checkout, use `npm -w engine run samples --` in place of `node scripts/sample-companies.mjs`:

```sh
node scripts/sample-companies.mjs manifest
node scripts/sample-companies.mjs refresh-plan
```

The refresh plan includes every active identified synthetic master and every completed native exploration company, with company IDs, industry, owner, source template and installed version. Disabled sources and sources with a retired oracle are classified as retained archives; their records and access are preserved, they are not requalified, and they do not block the active population. The plan separately lists unresolved or incomplete sample candidates with remedies instead of silently losing them. Resolve incomplete provisioning through the normal creation/resume lifecycle. The digest fixes the target membership and versioned source definition; advancing installed versions does not invalidate an interrupted run's retry.

Run the reviewed plan serially in the controlled maintenance lane:

```sh
node scripts/sample-companies.mjs refresh --plan-digest REVIEWED_SHA256
node scripts/sample-companies.mjs inventory
node scripts/sample-companies.mjs inspect --org COMPANY_UUID --industry INDUSTRY_KEY
```

`--industry KEY` is supported by both plan and refresh for a controlled canary. Use the matching plan digest. Each company commits atomically; a refusal stops the sequence and rolls back that company's changes. Successfully refreshed companies remain intact and the same membership digest can resume the run. Per-company output includes counts and digests of preserved posted history and existing records. Full document and line values, drafts, approvals, gates, scenario configuration and existing accounting setup are locked and compared within the transaction; an incompatible mutation rolls the company upgrade back and identifies the table and record. Existing company settings are retained, apart from audited required feature additions and versioned sample metadata. Master accounting qualification runs after scenario installation; a master is advertised only after its required ledger and subledger checks pass. `ready` in inspection describes scenario evidence; `accountingQualified` separately describes the master accounting certificate.

The upgrade resolves authored IDs through the same deterministic rebase contract as native cloning. Existing drafts, operator changes, posted entries, closed periods and reconciliations are preserved. Masters exposed through active member access receive the same protection against editing or posting an existing operator-owned draft; qualification can still refuse missing evidence without rewriting that draft. Required demonstrated feature gates are added in an audited settings change; unrelated feature choices, payroll countries and announcements are retained. New clones restore only the inert authored examples excluded by the clone kernel, before granting member access. The final inventory and per-company inspection are required to establish the population outcome; source changes or a version number alone are insufficient.


For installations with other evaluation companies, `tenant-inventory` lists every tenant's classification, sample provenance, source/owner, installed version, financial-record counts and child-company count. Ordinary companies are explicitly marked for preservation. An unregistered simulation or unknown sample profile requires provenance review; its name alone is not deletion authority. Retirement is a separate maintenance operation requiring exact provenance, dependent-company and access review, a restore-verified backup and explicit approval of the command’s locking behavior. The simulator fixture teardown disables shared-table triggers and demotes posted inventory state; it is not a supported shared-database retirement command. Do not run it on a shared evaluation server or rename a tenant to bypass its guards. Never use ad-hoc SQL to delete tenant data.

Wholesale distribution adds three native stock shipments and linked returns at requested, received and rejected stages. Construction adds three draft site tickets, each with three exact linked time rows and a native labor snapshot; capturing that evidence does not approve time or post payroll. These are additional versioned identities, preserving the earlier demonstration records.

## Explicit population operator

`refresh-plan --actor UUID` pins the selected operator in its digest and reports the native permission requirements for each selected industry. Pass the same `--actor UUID` to `refresh --plan-digest SHA256`; changing or omitting it invalidates that reviewed plan. The native single-company scenario installer also accepts `install-scenarios --org UUID --industry KEY --actor UUID`. Omitting the option keeps the existing local seeded administrator selection.

The selected identity must be active in the target company, or an explicitly chosen active platform superadmin. Planning checks native permissions and legal-entity scope; execution revalidates them under command locks. A foreign platform identity remains locked in its home identity transaction while all business writes use the target's ordinary tenant transaction. The installer never changes role definitions, grants or deny overrides, and never chooses a platform superadmin automatically. A refusal identifies the missing permission or scope for supported operator remediation.

General business e-invoicing settings, nonprofit framework configuration, and healthcare compensation/training/roster/device records require a home-company author under their native tenant foreign keys. `refresh-plan` reports the exact authored tables and actor columns, and a foreign author receives `SAMPLE_LOCAL_AUTHOR_REQUIRED` before scenario writes. Use a local author for these three industries; explicit platform authors remain supported for the other industries. Healthcare training and roster authorship additionally require a local person identity. Select an authorized local author for that industry's plan; a foreign platform operator cannot replace this authorship. Existing people and permission settings are preserved. Sample preparation links an unlinked local scenario author to a synthetic person with actor audit only after authority succeeds.
