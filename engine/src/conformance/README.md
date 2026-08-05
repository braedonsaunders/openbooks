# Accounting standards conformance corpus

This directory encodes requirements of published accounting standards as
executable fixtures and runs them against the real product. It answers one
question, in a form an accountant can check without reading any code:

> Does this system produce the accounting the standard requires, to the cent?

## What a case is

One case is one requirement. It carries:

| Field | Purpose |
| --- | --- |
| `citations` | The paragraph an accountant can look up, plus our restatement of it |
| `support` | `supported`, `semantic`, `partial`, or `not-implemented` |
| `tier` | `computation` (pure functions, no database) or `ledger` (real postings) |
| `assertion` | What passing proves, written for a controller rather than an engineer |
| `facts` | The scenario, with every number stated |
| `expected` | The exact journal entries and/or figures required |
| `limitation` | Required for `partial` — precisely what the product does not do |
| `gap` | Required for `not-implemented` — precisely what is missing |
| `run` | Drives the product. Absent for declared gaps |

## The rules that make this evidence

**No tolerance.** Amounts are compared as exact four-decimal strings. A
hundredth of a cent is a failure. There is no rounding allowance anywhere in
the comparison.

**No implicit pass.** A requirement the product does not implement is declared
with `support: "not-implemented"`, published as a **GAP**, and asserted by the
test suite to *still be a gap*. When someone implements leases, this suite
fails and tells them to reclassify the case — the published matrix can never
quietly understate or overstate what the product does.

**Roles, not account numbers.** Cases assert on semantic roles ("deferred
revenue"), so they stay valid across every industry chart-of-accounts preset.
An account a case touches that has no role bound is a loud failure, not a
silent omission.

**Complete observation.** A `ledger` case snapshots *every* account in the
tenant before and after a business step, so it sees the whole accounting
consequence — including subledger entries the step posts indirectly. Because
the observation is complete and every posting balances, the movement always
nets to zero, and the runner asserts that independently of the expectation. A
case cannot pass on an unbalanced entry.

**Fresh tenant per ledger case.** Several cases deliberately leave stock and
receivables behind. Sharing a tenant would let one case's residue change
another's answer.

## Copyright

This corpus contains **no text from any accounting standard**. Standards are
copyrighted works. Each case states the requirement in our own words, cites the
paragraph, and encodes numeric facts. To verify a case, read the cited
paragraph in an authoritative copy.

Where a case is derived from a worked example published inside a standard the
citation is marked `illustrative-example`; otherwise it is marked `requirement`,
which claims only that the cited paragraph says what our restatement says it
says. The distinction is deliberate: a mislabelled citation is worse than no
citation, because it is checkable and wrong.

## Running it

```bash
npm -w engine run conformance -- list
npm -w engine run conformance -- run
npm -w engine run conformance -- report --out .local/conformance
```

`report` writes `conformance-matrix.md` (for publication) and
`conformance.json` (for CI and the trust badge).

Computation-tier cases need nothing but the repository. Ledger-tier cases post
real documents through the accounting kernel and need `OPENBOOKS_DB_URL`
pointed at a throwaway PostgreSQL database — never a production one. Without a
database they report as **not run** rather than passing, the same anti-false-
green rule the integration CI job enforces with its canary.

The corpus also runs as an ordinary test file, so `npm test` covers it:

```bash
node --import tsx --test engine/src/conformance/conformance.test.ts
```

## Adding a case

1. Find the paragraph. Restate it in one sentence, in your own words.
2. Write the facts with every number explicit.
3. Write the expected entries. They must balance — `validateCorpus` rejects an
   expectation that does not.
4. Write `run` so it drives **product code**, not a reimplementation. A case
   that recomputes the answer itself proves nothing.
5. If the product cannot do it, do not delete the case — set
   `support: "not-implemented"`, write the `gap`, and drop `run`.

Case ids are stable and appear in published reports. Never renumber or reuse
one.

## Scope today

Covered: ASC 606 / IFRS 15 revenue (including variable-consideration
constraint and financing-component separation), ASC 842 / IFRS 16 lessee
leases, IAS 2 / ASC 330 inventories (including lower-of-cost-and-NRV with the
framework-divergent reversal rule), IAS 21 foreign currency (including
designated monetary items beyond trade balances), ASC 360 / IAS 16 long-lived
assets, and ASC 740 / IAS 12 income taxes.

Not yet covered, and therefore **not claimed**: business combinations,
consolidation procedure, financial instruments, employee benefits, provisions
and contingencies, share-based payment, government grants, hyperinflation,
segment reporting, and interim reporting. Absence from this corpus is not
evidence of conformance in either direction.
