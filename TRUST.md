<!--
  The trust corpus: what OpenBooks checks about itself, continuously, in public.

  This file is the human-readable half. The machine-readable half is published
  by .github/workflows/trust.yml as artifacts and as a badge endpoint, and
  accumulates into docs/trust/history.json.

  Rule for maintainers: if you weaken, rename, or remove an invariant, change
  this file in the same commit. An invariant that quietly disappears is worse
  than one that was never claimed.
-->

# Trust

Accounting software asks for an unusual amount of trust: you are handing it the
record that your auditors, your bank, and your tax authority will rely on. This
page is our answer to *why should you believe it works* — not a claim, but a
set of checks you can read, run yourself, and watch run on every commit.

Three things are published here:

1. **The invariants** — properties the ledger must always hold, checked
   continuously.
2. **The conformance corpus** — requirements of published accounting standards,
   encoded as executable fixtures with exact expected entries.
3. **The results** — per-commit, from CI, including the failures.

> [!IMPORTANT]
> OpenBooks is alpha software. These checks are extensive and they are honest,
> but they are **our own** checks. No independent accounting audit, controls
> audit, security audit, or penetration test has been performed, and no
> attestation exists. Evaluate OpenBooks with test or parallel books before
> placing production financial records on it.

---

## Current results

| What | Status |
| --- | --- |
| Test suite (unit, integration, coverage, browser) | [![Tests](https://github.com/braedonsaunders/openbooks/actions/workflows/test.yml/badge.svg)](https://github.com/braedonsaunders/openbooks/actions/workflows/test.yml) |
| Ledger invariants + standards conformance | [![Trust](https://github.com/braedonsaunders/openbooks/actions/workflows/trust.yml/badge.svg)](https://github.com/braedonsaunders/openbooks/actions/workflows/trust.yml) |
| Standards conformance | ![Conformance](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/braedonsaunders/openbooks/main/docs/trust/badge-conformance.json) |
| Ledger invariants | ![Invariants](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/braedonsaunders/openbooks/main/docs/trust/badge-invariants.json) |

- **[Latest conformance matrix](docs/trust/conformance-matrix.md)** — every
  standards requirement, its citation, and its status.
- **[Latest invariant checkpoint](docs/trust/checkpoint.json)** — the diffable
  trial balance, control tie-outs, check results, and report timings.
- **[History](docs/trust/history.json)** — one append-only record per commit,
  for charting the trend over time.

Every run also uploads its full artifacts to the workflow run, including the
conformance JSON and the harness checkpoint.

---

## The invariants

These are the properties the ledger must hold at all times. They are checked by
the golden harness (`engine/src/harness/scenario.ts`), by the business simulator
after every simulated action, and — for the ones marked *kernel* — by PostgreSQL
itself on every single write, including direct SQL.

### 1. Global balance

> The sum of every posted journal line in the tenant is exactly zero.

Not "close to zero", not "within a rounding tolerance" — exactly zero, in
integer units of one hundredth of a cent. This is the single strongest
statement you can make about a double-entry ledger: no value has ever been
created or destroyed inside the books.

*Checked by:* harness (`global-balance`), simulator after every persona action.

### 2. Per-entry balance

> Every individual posted journal entry balances, balances **within each legal
> entity**, and has at least two lines.

Global balance alone can hide two offsetting broken entries. This checks each
one. The by-subsidiary requirement is what makes entity-level statements
possible: an entry that balances overall but not per entity would make one
subsidiary's balance sheet wrong.

*Checked by:* **kernel** (`jl_check_balanced` on every line write;
`je_check_posted_balance` on transition to posted), harness
(`per-entry-balance`), simulator.

### 3. Document total agrees with the ledger

> Every posted invoice, bill, and credit memo's stated total equals its net
> posting to the receivable or payable control account.

This is the check that catches a document header saying one thing while the
accounting says another — the class of defect that makes a customer statement
disagree with the aged receivables report. It is retainage-aware: a
construction pay application legitimately has a total equal to the net amount
due while its gross work is split across revenue and a separate retainage
receivable, so the comparison is against the control-account posting rather
than the whole debit sum.

*Checked by:* simulator (`doc-total-tieout`).

### 4. Subledger ties to the general ledger

> For every receivable and payable control account, the general-ledger balance
> equals the open-item subledger plus any direct journal postings, measured
> point-in-time as at the reporting date.

Both sides are reconstructed to the same cutoff date, so payments applied after
the cutoff cannot create a phantom mismatch. Direct journal entries to a control
account are separated out rather than treated as errors, which isolates genuine
application-graph anomalies — settlements that fail to net between the two open
items they link — from legitimate manual activity.

This is the reconciliation an auditor performs first, and the one that most
often fails in production accounting systems.

*Checked by:* harness (`subledger-gl-tieout`).

### 5. Open balances are not stale

> Every posted document's stored open balance equals the balance recomputed from
> its journal lines and the applications settled against them.

A cached balance that has drifted from the underlying record is how aged
receivables reports quietly go wrong. The harness recomputes from source and
compares.

*Checked by:* **kernel** (`recompute_document_open_balance` maintains it on
every application), harness (`open-balance-fresh`).

### 6. Closed periods are immutable

> A document dated inside a closed accounting period cannot be posted.

Asserted by **probe**, not by assumption: the simulator builds a real draft
document dated inside a closed period, attempts to post it through the real
kernel, and halts the entire run if the kernel does not refuse. Close is
per-module — receivables, payables, and general ledger lock independently — and
a reopen carries an expiry after which the lock re-asserts itself.

*Checked by:* **kernel** (`period_module_blocks_write`), simulator
(`immutabilityProbe`).

### 7. Posted documents carry exact journal identity

> A posted document must reference exactly one journal entry, in the same
> tenant, in the same accounting period.

Prevents the class of corruption where a document claims to be posted into one
period while its accounting sits in another — invisible on a trial balance,
fatal at year end.

*Checked by:* **kernel** (`validate_document_posted_period_identity`).

### 8. Postings go only to real, postable accounts

> Every journal line targets an account that exists, is active, is not a summary
> account, and carries every dimension that account requires.

Posting to a roll-up parent silently corrupts every subtotal beneath it. The
kernel refuses. Required dimensions — project, department, location, class,
party, or any custom segment — are enforced per account at the same layer.

*Checked by:* **kernel** (`jl_check_account`,
`jl_check_required_dimensions`).

### 9. Overhead never changes company profit

> Overhead application must net to exactly zero **per account**, and the
> project-tagged legs must be debits.

Overhead absorption is a job-costing mechanism, not a profit-and-loss event.
Netting to zero is necessary but not sufficient: a pair can net to zero and
still be applied backwards, crediting every job. The profit and loss would look
correct while job cost was understated by the entire overhead amount —
invisible on a trial balance, visible only in job costing. So the direction is
asserted too.

*Checked by:* harness (`overhead-pair-zero`, `overhead-burdens-jobs`).

### 10. The audit trail cannot be rewritten

> The audit log, close evidence, close sign-offs, and close events are
> append-only. Posted inventory movements cannot be deleted. Captured
> signatures are immutable.

Enforced by database triggers that raise on any update or delete, so this holds
against direct SQL access, not merely against the application.

*Checked by:* **kernel** (`audit_log_append_only_guard`,
`close_events_append_only`, `inv_move_guard`, and related triggers).

### 11. Posting is exactly-once and period processes are idempotent

> Posting the same document twice produces one entry. Running revenue
> recognition, depreciation, or foreign-currency revaluation twice for the same
> period recognises nothing further.

The failure mode this prevents — a retried job double-recognising revenue — is
one an auditor will specifically ask about whenever a process is automated.

*Checked by:* `engine/src/posting-exactly-once.integration.test.ts`, conformance
case `rev-recognition-is-idempotent`.

### 12. Tenants cannot see each other

> Organisation-owned data is isolated by PostgreSQL row-level security, on 327
> tables with 336 policies, and the application connects as a role that is
> neither superuser nor `BYPASSRLS`.

Verified at every bootstrap, not only at first install: the provisioner refuses
to complete if the runtime role is over-privileged or if row-level security is
missing from any organisation-scoped table.

*Checked by:* **kernel**, `scripts/bootstrap.ts`,
`engine/src/db-rls.integration.test.ts`.

---

## The conformance corpus

Beyond internal consistency, the corpus asks a different question: *is the
accounting right according to the standards?*

Each case encodes one requirement of a published standard — ASC 606 / IFRS 15,
IAS 2 / ASC 330, IAS 21, ASC 360 / IAS 16, ASC 740 / IAS 12, ASC 842 / IFRS 16 —
as stated facts, a paragraph citation you can look up, and the exact journal
entries required. Amounts are compared as exact four-decimal strings. **A
hundredth of a cent is a failure.**

Requirements the product does not implement are **published as gaps**, never
omitted and never counted as passing. The test suite asserts that each gap is
*still a gap*, so the day someone implements one, the build fails and tells
them to reclassify the case rather than letting this page quietly understate
what the software does.

The corpus has already done its job once: its first publication identified five
measurement gaps — no lessee lease accounting, no lower-of-cost-and-NRV
inventory measurement, current tax computed without temporary differences,
foreign-currency retranslation limited to three account types, and no variable
consideration constraint — and each was then implemented as real product
capability (schema, engine, and tests) and its case flipped from GAP to
passing. The remaining published gap: restoration of an impaired held-and-used
asset is not yet blocked under US GAAP (ASC 360-10-35-20) nor capped under
IAS 36. One partial: lessor straight-line levelling is engine arithmetic that
the property-management billing pipeline does not yet apply automatically.

Full detail, including the shortfall text for every gap and partial:
**[docs/trust/conformance-matrix.md](docs/trust/conformance-matrix.md)** and
[engine/src/conformance/README.md](engine/src/conformance/README.md).

---

## Independent recomputation

Checking your own arithmetic against yourself has a limit. Two harnesses go
outside it:

**Differential ledger parity.** The same economic events are driven through the
OpenBooks posting kernel and through a separate, independently written
accounting system, and the resulting functional-currency general-ledger impact
is compared at every lifecycle checkpoint — draft, post, allocate, amend,
cancel, and period lock. There is **no rounding tolerance; a one-cent
difference fails**. A capability that is unsupported or unclassified is a
coverage failure, never an implicit pass. See
[engine/src/harness/ledger-parity/README.md](engine/src/harness/ledger-parity/README.md).

**Seeded business simulation.** A synthetic company is generated from a seed,
advanced through simulated time, and driven through real business activity by
persona agents. The invariant oracle runs after every action; on failure the run
**halts** and writes a defect bundle containing the failing invariant, the
reproduction recipe, and the seed. The operator protocol in that bundle is
explicit: fix the defect in the product — never the harness, never relax the
invariant. See [engine/src/sim/README.md](engine/src/sim/README.md).

---

## Reproduce all of it yourself

Nothing here requires our infrastructure. From a clean checkout:

```bash
npm test
```

```bash
npm -w engine run conformance -- report
```

```bash
npm -w engine run harness
```

```bash
npm -w engine run sim -- provision --profile general-contractor --seed 1
```

The conformance corpus's computation tier needs nothing but the repository. Its
ledger tier, the harness, and the simulator need `OPENBOOKS_DB_URL` pointed at a
**throwaway** PostgreSQL database — never a production one. The simulator
additionally refuses to run unless `OPENBOOKS_SIM=1` is set and the database
name is clearly isolated.

If a check fails on your machine and passes on ours, that is a bug report we
want.

---

## What would make this stronger

Stated plainly, because a trust page that lists only strengths is marketing.

- **Independent assurance.** No third party has audited the accounting, the
  controls, or the security. A controls audit and a penetration test are the
  two highest-value things this project does not have.
- **Browser coverage.** End-to-end testing is a smoke tier. Full user-journey
  coverage per module is not yet in place.
- **Concurrency and fault injection.** There is no suite that fires parallel
  postings at the same period, item, or open invoice, and none that kills the
  process mid-transaction to prove no half-posted state survives.
- **Scale evidence.** No published benchmark at ten million journal lines with
  stated hardware.
- **Standards coverage.** Business combinations, financial instruments,
  employee benefits, provisions, and share-based payment are not in the
  conformance corpus. Their absence is not evidence of conformance in either
  direction.

See [AUDIT-CONTROLS.md](AUDIT-CONTROLS.md) for the full control matrix mapped
to financial-statement assertions and IT general controls.

## Reporting a problem

A sequence of API calls that leaves the trial balance out of balance, breaks
subledger-to-general-ledger tie-out, posts into a closed period, or crosses a
tenant boundary is the most valuable bug report this project can receive.
Please report it under [SECURITY.md](SECURITY.md) if it has a security
dimension, and as a normal issue otherwise.
