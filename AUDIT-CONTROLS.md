<!--
  Audit-assertion control matrix.

  Written for accountants and auditors, not engineers. Every control named here
  is real, is enforced at the layer stated, and is exercised by the test or
  harness named in the Evidence column. Anything not enforced is in "Known
  control gaps" at the end rather than omitted.

  When you add or move a control, update the row. A matrix that drifts from the
  code is worse than no matrix.
-->

# Audit-assertion control matrix

This document maps the controls built into OpenBooks to the financial-statement
assertions and IT general controls an auditor works from. It exists so a
controller can hand something concrete to an audit partner during planning, and
so a reviewer can test a control rather than take a claim on trust.

Every row names where the control is enforced and how you can reproduce its
evidence yourself.

> [!IMPORTANT]
> **What this document is not.** OpenBooks is alpha software. This matrix is a
> description of controls that exist in the software, prepared by the project.
> It is **not** a SOC 1 or SOC 2 report, not an ISAE 3402 assurance report, not
> a service auditor's opinion, and not evidence that any control operated
> effectively over a period. No independent accounting, security, or controls
> audit has been performed. A control existing in software is a *design*
> matter; whether it *operated* in your entity over your period is a matter for
> your own testing.

## How controls are enforced

Controls sit at three layers, and the layer matters when you assess whether a
control can be circumvented.

| Layer | What it means for testing |
| --- | --- |
| **Database** | Enforced by PostgreSQL triggers, constraints, and row-level security. Applies to *every* write, including direct SQL, imports, background jobs, and any future code path. Cannot be bypassed by application changes. |
| **Service** | Enforced in the accounting engine, above the database but below the user interface. Applies to every posting path including the REST API and background workers. |
| **Application** | Enforced in the web application — navigation, page, and route authorisation. Protects the user experience; the layers below it are what protect the ledger. |

The controls an auditor most cares about — balance, period cutoff, tenant
ownership, and audit-trail immutability — are enforced at the **database**
layer.

As of this revision the schema carries **117 triggers**, **116 PL/pgSQL guard
functions**, **336 row-level-security policies**, and row-level security
enabled on **327 tables**.

---

## Financial statement assertions

### Existence and occurrence
*Recorded transactions and events occurred and pertain to the entity.*

| # | Control | Layer | Evidence |
| --- | --- | --- | --- |
| E1 | A journal entry cannot be created from a source document that has not completed its approval lifecycle. `postDocument` refuses any document that is draft, voided, or not approved. | Service | `engine/src/flows/approval-lifecycle.integration.test.ts` |
| E2 | Every posted document carries exact journal identity: `validate_document_posted_period_identity` rejects a posted document whose journal entry is missing, belongs to another tenant, or sits in a different accounting period. | Database | `engine/src/close-period-identity.integration.test.ts` |
| E3 | Approval gates support quorum, delegation, escalation, and **prevention of self-approval**, so the approver is a different person from the submitter. | Service | `engine/src/flows/quorum.test.ts` |
| E4 | The audit log is append-only. `audit_log_append_only_guard` raises on any update or delete. | Database | `audit_log_append_only` trigger; exercised by `engine/src/document-correction.integration.test.ts` |
| E5 | Close evidence, sign-offs, and close events are append-only once recorded. | Database | `close_events_append_only`, `close_signoffs_append_only`, `close_evidence_append_only` triggers |
| E6 | Inventory movements cannot be deleted once posted (`inv_move_guard`), so stock history cannot be rewritten to fabricate quantities. | Database | `engine/src/inventory.integration.test.ts` |
| E7 | Field-ticket signatures and signature requests are immutable once captured, with HMAC signing. | Database | `field_ticket_signature_immutable`, `field_ticket_signature_request_immutable` |

### Completeness
*All transactions and events that should have been recorded have been recorded.*

| # | Control | Layer | Evidence |
| --- | --- | --- | --- |
| C1 | **Every journal entry balances.** `jl_check_balanced` recomputes the sum of an entry's lines on every insert, update, and delete and raises if it is not zero. | Database | `engine/src/kernel-constraints.integration.test.ts` |
| C2 | **Every posted entry balances, balances by legal entity, and has at least two lines.** `je_check_posted_balance` enforces all three on transition to posted. | Database | `engine/src/kernel-constraints.integration.test.ts` |
| C3 | **The whole ledger balances.** The golden harness asserts the sum of all posted journal lines across the tenant is exactly zero (`global-balance`). | Harness | `npm -w engine run harness` |
| C4 | **Every entry individually balances**, asserted independently of the trigger, across the entire posted population (`per-entry-balance`). | Harness | `npm -w engine run harness` |
| C5 | **Subledgers agree with the general ledger.** Receivable and payable control-account balances are compared to the sum of open items (`subledger-gl-tieout`). | Harness | `npm -w engine run harness` |
| C6 | **Document totals agree with the ledger.** Every posted invoice, bill, and credit's stated total equals its net posting to the AR or AP control account (`doc-total-tieout`). Retainage-safe. | Simulator | `engine/src/sim/invariants/index.ts` |
| C7 | **Open balances are not stale.** Stored open-item balances are recomputed and compared to the recorded value (`open-balance-fresh`); `recompute_document_open_balance` maintains them on every application. | Database + Harness | `engine/src/payments.integration.test.ts` |
| C8 | **Posting is exactly-once.** Concurrent or repeated posting of the same document produces one entry, not two. | Service | `engine/src/posting-exactly-once.integration.test.ts` |
| C9 | **Period processes are idempotent.** Revenue recognition, depreciation, and FX revaluation each refuse to post twice for the same period, and refuse to skip. | Service | Conformance case `rev-recognition-is-idempotent`; `engine/src/fx-revaluation.test.ts` |
| C10 | Journal entries cannot be orphaned from their tenant or their period: referential-integrity migrations enforce foreign keys across every org-scoped table. | Database | `schema/migrations/generated`, `engine/src/kernel-constraints.integration.test.ts` |

### Accuracy and valuation
*Amounts and other data are recorded appropriately and at appropriate amounts.*

| # | Control | Layer | Evidence |
| --- | --- | --- | --- |
| A1 | **No floating point anywhere in money.** Amounts are stored as `numeric(19,4)` and all arithmetic runs on scaled BigInt integers. | Database + Service | `engine/src/money.ts`, `engine/src/money.test.ts` |
| A2 | **Allocations never lose or invent a cent.** `apportion` distributes a total across weights so the parts sum exactly to the whole, placing the residual deterministically. | Service | Conformance cases `rev-allocate-relative-ssp`, `rev-allocate-no-lost-cent` |
| A3 | Inventory is costed by FIFO, weighted average, or standard cost with purchase-price variance, and cost of sales is recomputed from the actual cost layers consumed. | Service | Conformance cases `inv-fifo-cost-formula`, `inv-weighted-average-cost-formula` |
| A4 | Foreign-currency transactions are translated at the transaction-date rate; monetary balances are retranslated at the closing rate with the difference to profit or loss. | Service | Conformance cases `fx-initial-recognition-at-spot`, `fx-monetary-item-retranslated-at-closing-rate` |
| A5 | Depreciation supports straight-line, declining balance, double declining, sum-of-years-digits, units of production, and custom formulas, across alternate books. | Service | `engine/src/depreciation.integration.test.ts` |
| A6 | Impairment and disposal arithmetic is a pure function that refuses to emit an unbalanced entry. | Service | Conformance cases `ppe-impairment-to-fair-value`, `ppe-disposal-gain-loss` |
| A7 | **Independent recomputation.** A differential harness drives the same economic events through OpenBooks and a separate, independently written accounting system and compares functional-currency general-ledger impact at every lifecycle checkpoint, **with zero rounding tolerance**. | Harness | `engine/src/harness/ledger-parity/` |
| A8 | **Standards conformance.** Requirements of ASC 606/IFRS 15, IAS 2/ASC 330, IAS 21, ASC 360/IAS 16, and ASC 740/IAS 12 are encoded as executable fixtures with exact expected entries. | Corpus | `npm -w engine run conformance -- report` |

### Cutoff
*Transactions and events are recorded in the correct accounting period.*

| # | Control | Layer | Evidence |
| --- | --- | --- | --- |
| K1 | **A closed period rejects postings.** `period_module_blocks_write` is consulted on write; a closed module lock raises regardless of the code path. | Database | `engine/src/posting-period.integration.test.ts` |
| K2 | **A document's posting period must equal its journal's period.** A posted document cannot claim one period while its entry sits in another. | Database | `engine/src/close-period-identity.integration.test.ts` |
| K3 | **Close is sequenced per module.** AR, AP, and GL close independently, so closing receivables does not silently freeze general-ledger adjustments. | Service | `engine/src/close.ts`, `engine/src/flows/close-approval.integration.test.ts` |
| K4 | **Reopening is controlled and audited**, with an expiry after which the lock re-asserts itself automatically. | Database + Service | `period_module_blocks_write` (`reopen_expires_at`), `close_reopen_requests` |
| K5 | **Immutability is probed, not assumed.** The business simulator constructs a document dated inside a closed period, attempts to post it, and halts the run if the kernel does not refuse. | Simulator | `immutabilityProbe` in `engine/src/sim/invariants/index.ts` |
| K6 | Period-end FX revaluation books the adjustment in the period and its reversal in the next, so a reporting-date balance sheet and the following period are both correct. | Service | Conformance case `fx-monetary-item-retranslated-at-closing-rate` |

### Classification
*Transactions and events are recorded in the proper accounts.*

| # | Control | Layer | Evidence |
| --- | --- | --- | --- |
| L1 | **Postings to summary accounts are refused.** `jl_check_account` raises if the account is a summary (roll-up) account, so parent-account posting cannot corrupt statement subtotals. | Database | `engine/src/kernel-constraints.integration.test.ts` |
| L2 | **Postings to inactive or non-existent accounts are refused.** The only relaxation is an explicitly flagged historical migration replay, which requires direct database access and never relaxes balance, immutability, or summary rules. | Database | `jl_check_account` |
| L3 | **Required dimensions are enforced per account.** An account may require subsidiary, department, project, location, class, party, or any custom segment; `jl_check_required_dimensions` raises if it is missing. | Database | `engine/src/project-gl-controls.integration.test.ts` |
| L4 | Account type carries normal balance and statement placement directly, rather than being re-derived in report code. | Database | `schema/src/coa.ts` |
| L5 | Accounts may be restricted to one subsidiary or currency, preventing cross-entity or cross-currency misposting. | Database | `accounts.subsidiary_id`, `accounts.currency_restriction` |
| L6 | Custom segment values on documents, lines, and journal lines are validated against their segment definitions. | Database | `documents_extra_dims_guard`, `journal_lines_extra_dims_guard` |

### Presentation and disclosure
*Information is appropriately presented and disclosures are clearly expressed.*

| # | Control | Layer | Evidence |
| --- | --- | --- | --- |
| P1 | **Every entry balances per legal entity**, not merely in aggregate, so entity-level statements can be produced from any entry population. | Database | `jl_check_balanced_by_subsidiary` |
| P2 | Consolidation supports ownership percentages, non-controlling interests, goodwill configuration, and intercompany eliminations. | Service | `engine/src/consolidation.integration.test.ts` |
| P3 | Billing ahead of performance is presented as a contract liability, not revenue. | Service | Conformance case `rev-contract-liability-then-recognition` |
| P4 | Gross deferred tax assets and liabilities are presented separately rather than netted, as the tax note requires. | Service | Conformance case `tax-deductible-difference-creates-deferred-asset` |
| P5 | The rate reconciliation runs from the statutory charge through each reconciling item to the reported total, supporting the effective-tax-rate disclosure. | Service | Conformance case `tax-permanent-difference-changes-effective-rate` |
| P6 | Framework-specific terminology is applied automatically — an IFRS reporter does not see US-GAAP-only vocabulary in its tax note. | Service | Conformance case `tax-framework-terminology` |
| P7 | Financial statements drill through to registers and to source transactions, so any figure can be traced to its underlying documents. | Application | `packages/reports` |

### Rights and obligations
*The entity holds or controls the rights to assets, and liabilities are its obligations.*

| # | Control | Layer | Evidence |
| --- | --- | --- | --- |
| R1 | **Tenant isolation is enforced by the database.** Row-level security is enabled on 327 tables with 336 policies; the application connects as a role that is neither superuser nor `BYPASSRLS`. | Database | `engine/src/db-rls.integration.test.ts`, verified at bootstrap |
| R2 | Payment applications cannot exceed the document amount; over-application is refused. | Database + Service | `application_open_balance`, `engine/src/payments.integration.test.ts` |
| R3 | Applications are idempotent under retry, so a repeated request cannot settle the same open item twice. | Database | `application_idempotency_guard` |
| R4 | Vendor payment release can be gated on compliance evidence — insurance certificates and lien waivers — so an obligation is not discharged before conditions are met. | Service | `engine/src/subcontracts.ts` |
| R5 | Inventory concurrency controls prevent overselling stock the entity does not hold. | Database + Service | `engine/src/inventory.integration.test.ts` |

---

## IT general controls

### Logical access

| # | Control | Evidence |
| --- | --- | --- |
| G1 | The runtime database role is verified at bootstrap to be `NOSUPERUSER`, `NOBYPASSRLS`, with fail-closed row-level security. Bootstrap refuses to complete otherwise. | `scripts/bootstrap.ts` |
| G2 | Separate database-owner and constrained application credentials are generated at install; migrations run in a one-shot privileged container, and the long-running web and worker processes never receive the owner login. | `scripts/compose-up.sh` |
| G3 | Role-based permissions with built-in roles; permission changes require re-seeding role snapshots, so a permission cannot be silently granted by editing one row. | `engine/src/seed-roles.ts` |
| G4 | Self-approval prevention, quorum, and delegation provide segregation of duties over material transactions. | `engine/src/flows/quorum.test.ts` |
| G5 | Organisation-scoped API keys with generated OpenAPI documentation; secrets are encrypted at rest with a deployment-supplied data key. | `web/lib/api/openapi.ts` |
| G6 | Sandboxes are clones with outbound side effects neutered and optional data masking, so testing cannot email real customers or move real money. Row-level security is re-verified on the clone. | `engine/src/sandbox/`, `engine/src/sandbox/verify-rls.ts` |

### Change management

| # | Control | Evidence |
| --- | --- | --- |
| G7 | Schema changes are tracked migrations applied in a fixed order by the authoritative provisioner, which is the same code path in CI and in production. | `scripts/bootstrap.ts`, `schema/migrations/` |
| G8 | The live schema is compared against a committed catalogue snapshot, so an out-of-band schema change is detected. | `scripts/schema-catalog-snapshot.ts`, `scripts/compare-schema-catalogs.mjs` |
| G9 | Every change runs a four-job test gate: unit, database integration, coverage, and browser end-to-end. The integration job includes a **canary that fails the build if database-backed tests silently skipped** — a green build cannot mean "nothing ran". | `.github/workflows/test.yml` |
| G10 | A release verification command runs container-security checks, type checking across all workspaces, the full test suite, and a production build. | `npm run verify:release` |
| G11 | Row-level security is re-verified on every org-scoped table at every bootstrap, not only at first install. | `scripts/bootstrap.ts` |

### Data integrity and operations

| # | Control | Evidence |
| --- | --- | --- |
| G12 | The audit log and all close evidence are append-only at the database layer. | `audit_log_append_only_guard` and the close-evidence triggers |
| G13 | Continuous-close detectors run configurable accounting and finance exception checks and raise findings for review. | `engine/src/continuous-close.ts` |
| G14 | A seeded business simulator advances a synthetic company through time and **halts on the first invariant failure**, writing a defect bundle with a reproduction recipe. Its operator protocol requires fixing the product — never the harness, never relaxing the invariant. | `engine/src/sim/` |
| G15 | The golden harness produces a diffable checkpoint — counts, trial balance, control tie-outs, check results, and report timings — that can be compared across commits to detect an unintended change in reported figures. | `engine/src/harness/scenario.ts` |
| G16 | A health endpoint reports application and background-worker status. | `GET /api/v1/health?include=worker` |

---

## Known control gaps

These are stated because a control matrix that lists only strengths is not
usable for planning.

**Assurance.** No independent accounting audit, controls audit, security audit,
or penetration test has been performed. There is no SOC 1, SOC 2, ISO 27001, or
PCI DSS attestation, and no government filing certification.

**Measurement gaps identified by our own conformance corpus.** These are
published in full with the shortfall described in each case:

- **No lessee lease accounting.** ASC 842 and IFRS 16 right-of-use assets and
  lease liabilities are not implemented. Leases are accounted for as cash is
  paid, which is the pre-2019 treatment. Lessor-side property rent billing
  exists but is not derived from a lease classification test and does not
  level escalating rents on a straight-line basis.
- **No lower-of-cost-and-net-realisable-value inventory measurement.** There is
  no value-only inventory remeasurement, so an NRV write-down must be booked as
  a manual journal, leaving the inventory subledger and the general ledger
  disagreeing by the amount of the write-down.
- **Current tax excludes temporary differences.** Current tax is computed from
  book income adjusted for permanent differences and loss carryforwards only.
  Total tax expense is unaffected, but the split between current and deferred —
  and therefore income tax payable — is misstated whenever temporary
  differences exist. Reconcile the current-tax line to the filed return before
  publishing the tax note.
- **Foreign-currency retranslation scope is narrow.** Period-end retranslation
  covers bank, receivable, and payable accounts. Foreign-currency loans, other
  long-term debt, and other monetary balances outside those types are not
  retranslated and need a manual adjustment.
- **No variable-consideration constraint and no significant-financing-component
  adjustment** under ASC 606 / IFRS 15.

**Coverage gaps.** Browser end-to-end coverage is a smoke tier only. There is
no automated segregation-of-duties conflict report, no automated
authorisation-matrix test across every route and role, and no concurrency or
fault-injection suite.

**Operator responsibilities.** For a self-hosted deployment, transport
security, backup and restore, retention, monitoring, secret management, network
policy, production access logging, and change advisory are the operator's
controls, not the software's. See [SECURITY.md](SECURITY.md).

---

## Reproducing the evidence

Every control above can be exercised from a clean checkout.

Run the full test suite, including the database-backed integration tier:

```bash
npm test
```

Run the standards conformance corpus and produce the published matrix:

```bash
npm -w engine run conformance -- report
```

Run the golden harness against a company and produce a diffable checkpoint:

```bash
npm -w engine run harness
```

Run the seeded business simulator, which halts on the first invariant failure:

```bash
npm -w engine run sim -- provision --profile general-contractor --seed 1
```

See [TRUST.md](TRUST.md) for what each invariant checks and where the published
results live.
