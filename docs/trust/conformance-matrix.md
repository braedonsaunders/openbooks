# Accounting standards conformance matrix

Each row is one requirement of a published accounting standard, encoded as an executable fixture and run against OpenBooks. Amounts are compared exactly — a hundredth of a cent is a failure. Requirements the product does not implement are listed as **GAP**; they are never omitted and never counted as passing.

The wording of each requirement is our own restatement. Verify a row by reading the cited paragraph in an authoritative copy of the standard.

**28 passing · 0 failing · 11 gaps · 0 not run**

2026-08-04T23:45:56.249Z

## ASC 360

| Requirement | Citation | Status | Conformance |
| --- | --- | --- | --- |
| **An impaired asset is written down to fair value and the loss is recognised immediately**<br><sub>The carrying amount falls to fair value by exactly the shortfall, and the whole shortfall is charged to profit or loss in the period — no part of it is deferred or spread.</sub> | ASC 360 360-10-35-17<br>IAS 16.63 | PASS | Implemented (different mechanism) |
| **The written-down amount becomes the new cost basis for future depreciation**<br><sub>Future depreciation runs off the impaired carrying amount, so the asset is never depreciated back through an amount that has already been written off.</sub> | ASC 360 360-10-35-20<br>IAS 36.63 | PASS | Implemented |
| **Derecognition removes cost and accumulated depreciation and recognises the gain or loss**<br><sub>On sale, the asset's cost and its accumulated depreciation both leave the balance sheet entirely and the profit or loss recognised is exactly proceeds less carrying amount — a disposal cannot leave a stub balance behind.</sub> | ASC 360 360-10-40-5<br>IAS 16.71<br>IAS 16.68 | PASS | Implemented |
| **US GAAP prohibits reversing an impairment of a held-and-used asset**<br><sub>Under US GAAP a recovery in fair value after impairment produces no entry; under IFRS a reversal is recognised but is capped at the carrying amount that would have existed had no impairment been recognised.</sub> | ASC 360 360-10-35-20<br>IAS 36.114 | GAP | Not implemented |

### ASC 360 — shortfalls

**ppe-us-gaap-prohibits-restoration — US GAAP prohibits reversing an impairment of a held-and-used asset**

> `remeasureAsset` accepts any new carrying value in either direction. Writing an impaired asset back up is permitted, which IFRS requires but US GAAP forbids, and nothing records whether a given write-up is a permitted IAS 16 revaluation, a permitted IAS 36 reversal, or a prohibited ASC 360 restoration. The organisation already carries an `asc740`/`ias12` reporting-framework flag for income tax; long-lived assets need the same flag to gate this, plus retention of the historical impairment so an IAS 36 reversal can be capped at what depreciated cost would have been.

## ASC 606

| Requirement | Citation | Status | Conformance |
| --- | --- | --- | --- |
| **Transaction price allocates in proportion to standalone selling prices**<br><sub>A bundled contract splits across its performance obligations strictly in SSP proportion, and the split sums to the contract price with no residual cent.</sub> | ASC 606 606-10-32-31<br>IFRS 15.76 | PASS | Implemented |
| **Allocation of an indivisible price loses no consideration**<br><sub>Allocating a price that does not divide evenly still assigns the entire transaction price — the residual is placed deterministically, never dropped or invented.</sub> | ASC 606 606-10-32-28<br>IFRS 15.73 | PASS | Implemented |
| **An obligation satisfied evenly over time recognises revenue ratably**<br><sub>A twelve-month service obligation recognises an equal amount each month and exactly the contract amount in total — the schedule never over- or under-recognises.</sub> | ASC 606 606-10-25-27<br>IFRS 15.35 | PASS | Implemented |
| **A term that does not divide evenly still recognises the full amount**<br><sub>Cumulative revenue over an indivisible term equals the contract amount exactly; rounding is absorbed within the schedule rather than left as a residual.</sub> | ASC 606 606-10-25-31<br>IFRS 15.39 | PASS | Implemented |
| **Billing ahead of performance creates a contract liability that unwinds as performance occurs**<br><sub>Invoicing a twelve-month service up front posts nothing to revenue — it raises a receivable and a contract liability — and the first month's performance moves exactly one twelfth out of that liability into revenue.</sub> | ASC 606 606-10-45-2<br>IFRS 15.106<br>ASC 606 606-10-25-27 | PASS | Implemented |
| **Re-running recognition for a period recognises nothing further**<br><sub>Running the recognition process twice for the same period does not double-recognise revenue — a control an auditor tests directly when the process is automated or re-run after a correction.</sub> | ASC 606 606-10-25-27 | PASS | Implemented |
| **Each revenue line becomes a tracked performance obligation**<br><sub>The system creates and retains an identified performance obligation for each distinct promise, which is the record an auditor inspects when testing the completeness of the revenue schedule.</sub> | ASC 606 606-10-25-14<br>IFRS 15.22 | PASS | Implemented |
| **Variable consideration is constrained to the amount not subject to significant reversal**<br><sub>A contract with a performance bonus recognises only the constrained amount, and the estimate is revisited each reporting period.</sub> | ASC 606 606-10-32-11<br>IFRS 15.56 | GAP | Not implemented |
| **A significant financing component is separated from revenue**<br><sub>Revenue on a contract paid materially in advance or arrears is recognised at the cash selling price, with the difference presented as interest.</sub> | ASC 606 606-10-32-15<br>IFRS 15.60 | GAP | Not implemented |

### ASC 606 — shortfalls

**rev-variable-consideration-constraint — Variable consideration is constrained to the amount not subject to significant reversal**

> There is no model for estimating variable consideration (expected value or most-likely-amount), no constraint assessment, and no re-estimation at each reporting date. Contracts with rebates, refunds, penalties, price concessions or performance bonuses must be constrained manually outside the system.

**rev-significant-financing-component — A significant financing component is separated from revenue**

> Long-dated contracts are recognised at their undiscounted invoice amount. There is no discount-rate configuration, no present-value adjustment at inception, and no interest accretion between recognition and payment.

## ASC 740

| Requirement | Citation | Status | Conformance |
| --- | --- | --- | --- |
| **Total income tax expense is current tax plus deferred tax**<br><sub>The tax charge in profit or loss is the sum of the current-year liability and the movement in deferred taxes — the two components are computed separately and neither is dropped.</sub> | ASC 740 740-10-10-1<br>IAS 12.58 | PASS | Implemented |
| **Deferred tax is measured at the enacted rate expected to apply on reversal**<br><sub>Deferred balances move with the enacted rate: the same temporary difference measured at a different enacted rate produces a proportionally different deferred balance, so a rate change is reflected rather than ignored.</sub> | ASC 740 740-10-30-5<br>IAS 12.47 | PASS | Implemented |
| **A deductible temporary difference creates a deferred tax asset**<br><sub>Deductible and taxable differences are separated rather than netted into one figure, so the gross deferred tax asset and gross deferred tax liability are both visible — the presentation an auditor tests against the tax footnote.</sub> | ASC 740 740-10-25-2<br>IAS 12.24 | PASS | Implemented |
| **A deferred tax asset is reduced when realisation is not expected**<br><sub>Unrealisable deferred tax assets raise the tax charge in the period the judgement is made, and the allowance can never exceed the gross asset it reduces.</sub> | ASC 740 740-10-30-5(e)<br>IAS 12.56 | PASS | Implemented |
| **A valuation allowance greater than the deferred tax asset is rejected**<br><sub>The provision refuses to produce a negative deferred tax asset, so a mis-keyed allowance is rejected at entry rather than becoming a nonsensical balance in the tax footnote.</sub> | ASC 740 740-10-30-5(e) | PASS | Implemented |
| **Permanent differences move the effective rate away from the statutory rate**<br><sub>The rate reconciliation begins at the statutory charge, shows each reconciling item separately, and ends at the reported total — the schedule that supports the effective tax rate disclosure.</sub> | ASC 740 740-10-50-12<br>IAS 12.81(c) | PASS | Implemented |
| **The reduction in a deferred tax asset is labelled per the reporting framework**<br><sub>The same arithmetic is presented in the vocabulary of whichever framework the entity reports under, so an IFRS filer never sees a US GAAP-only term in its tax note.</sub> | ASC 740 740-10-30-5(e)<br>IAS 12.24 | PASS | Implemented |
| **Current tax is measured on taxable profit for the period**<br><sub>Permanent differences and utilised loss carryforwards adjust taxable income and therefore current tax; this case asserts the part that is implemented.</sub> | ASC 740 740-10-30-2<br>IAS 12.12 | PASS | Partial |
| **A taxable loss does not produce a negative current tax charge**<br><sub>A loss-making year reports no current tax rather than a negative payable, and the reconciliation discloses the unrecognised current benefit explicitly instead of burying it.</sub> | ASC 740 740-10-25-2 | PASS | Implemented |

### ASC 740 — shortfalls

**tax-current-tax-omits-temporary-differences — Current tax is measured on taxable profit for the period**

> Current tax is computed from book income adjusted for PERMANENT differences and loss carryforwards only. Originating and reversing TEMPORARY differences drive the deferred computation but do not adjust taxable income, so the current-tax figure is not taxable profit as ASC 740-10-30-2 and IAS 12.12 define it. Total tax expense (current plus deferred) is unaffected because the same differences flow through deferred tax, but the split between current and deferred — and therefore income tax payable — is misstated whenever temporary differences exist. Entities must reconcile the current-tax line to the filed return before publishing the tax note.

## ASC 842

| Requirement | Citation | Status | Conformance |
| --- | --- | --- | --- |
| **A lessee recognises a right-of-use asset and a lease liability at commencement**<br><sub>Entering into a lease puts both an asset and a liability on the balance sheet at commencement, so leased capacity and the obligation to pay for it are visible rather than off balance sheet.</sub> | ASC 842 842-20-30-1<br>IFRS 16.26<br>IFRS 16.23 | GAP | Not implemented |
| **A finance lease reports interest and amortisation separately**<br><sub>A finance lease produces a front-loaded total charge and puts the interest element into finance costs rather than operating expenses, which changes reported operating profit and every leverage and coverage ratio computed from it.</sub> | ASC 842 842-20-25-5<br>IFRS 16.49 | GAP | Not implemented |
| **A US GAAP operating lease reports a single straight-line lease cost**<br><sub>Under US GAAP an operating lease charges one flat amount to operating expenses each year, while still carrying the asset and liability on the balance sheet — a presentation that differs from IFRS for identical economics.</sub> | ASC 842 842-20-25-6<br>ASC 842 842-10-25-2 | GAP | Not implemented |

### ASC 842 — shortfalls

**lease-lessee-initial-recognition — A lessee recognises a right-of-use asset and a lease liability at commencement**

> There is no lessee lease accounting. No schema exists for lease contracts, discount rates, lease terms, renewal or termination options, or payment schedules; nothing computes a present value; and no right-of-use asset or lease liability is ever recognised. Leases entered into as lessee are accounted for only as the cash payments are made, which is the pre-ASC 842 and pre-IFRS 16 treatment. Any entity with material leases must maintain the lease schedule and the balance-sheet amounts outside the system and post them by manual journal.

**lease-finance-interest-and-amortization — A finance lease reports interest and amortisation separately**

> There is no lessee lease accounting. No schema exists for lease contracts, discount rates, lease terms, renewal or termination options, or payment schedules; nothing computes a present value; and no right-of-use asset or lease liability is ever recognised. Leases entered into as lessee are accounted for only as the cash payments are made, which is the pre-ASC 842 and pre-IFRS 16 treatment. Any entity with material leases must maintain the lease schedule and the balance-sheet amounts outside the system and post them by manual journal.

**lease-operating-single-cost — A US GAAP operating lease reports a single straight-line lease cost**

> There is no lessee lease accounting. No schema exists for lease contracts, discount rates, lease terms, renewal or termination options, or payment schedules; nothing computes a present value; and no right-of-use asset or lease liability is ever recognised. Leases entered into as lessee are accounted for only as the cash payments are made, which is the pre-ASC 842 and pre-IFRS 16 treatment. Any entity with material leases must maintain the lease schedule and the balance-sheet amounts outside the system and post them by manual journal. There is additionally no lease classification test, so the finance/operating distinction that drives the entire US GAAP presentation difference cannot be made.

## IAS 16

| Requirement | Citation | Status | Conformance |
| --- | --- | --- | --- |
| **Scrapping an asset with no proceeds recognises the whole carrying amount as a loss**<br><sub>A write-off with no proceeds charges the full remaining carrying amount to profit or loss and produces a balanced entry with no proceeds line at all.</sub> | IAS 16.67<br>ASC 360 360-10-40-5 | PASS | Implemented |

## IAS 2

| Requirement | Citation | Status | Conformance |
| --- | --- | --- | --- |
| **First-in, first-out assigns the earliest costs to the earliest sales**<br><sub>Cost of sales is charged with the oldest layer first at its actual cost, and the remaining inventory carries the newest costs — the property an auditor recomputes when testing inventory valuation under FIFO.</sub> | IAS 2.25<br>IAS 2.34<br>ASC 330 330-10-30-9 | PASS | Implemented |
| **Weighted average assigns a blended cost to each unit sold**<br><sub>Cost of sales uses the blended average of all units held rather than any particular purchase, and the remaining inventory is carried at that same average.</sub> | IAS 2.25<br>IAS 2.27 | PASS | Implemented |
| **Inventory cost becomes an expense in the period its revenue is recognised**<br><sub>Revenue and its matching cost of sales are recognised in the same accounting period and neither can occur without the other — the matching property behind gross margin.</sub> | IAS 2.34<br>ASC 330 330-10-35-1B | PASS | Implemented |
| **Buying inventory is not an expense**<br><sub>A purchase of stock capitalises into inventory and never touches profit or loss, so gross margin cannot be distorted by purchasing activity in the period.</sub> | IAS 2.9 | PASS | Implemented |
| **Inventory is written down to net realisable value when NRV falls below cost**<br><sub>When net realisable value falls below cost, the carrying amount of inventory is reduced to NRV, the loss is recognised immediately, and the on-hand QUANTITY is unchanged.</sub> | IAS 2.9<br>IAS 2.28<br>ASC 330 330-10-35-1C | GAP | Not implemented |
| **Reversal of a write-down is required under IFRS and prohibited under US GAAP**<br><sub>Under IFRS a recovered net realisable value reverses the earlier write-down up to original cost; under US GAAP the written-down amount is the new cost basis and no reversal is recognised.</sub> | IAS 2.33<br>ASC 330 330-10-35-14 | GAP | Not implemented |

### IAS 2 — shortfalls

**inv-lower-of-cost-and-nrv — Inventory is written down to net realisable value when NRV falls below cost**

> There is no value-only inventory remeasurement. `adjustInventory` changes QUANTITY — writing inventory down through it would remove units that physically exist and misstate the count. The only cost-layer revaluation path in the engine is landed-cost allocation, which increases carrying value. A period-end lower-of-cost-and-NRV write-down must therefore be booked as a manual journal, leaving the inventory subledger and the general ledger disagreeing by the amount of the write-down.

**inv-writedown-reversal-policy-divergence — Reversal of a write-down is required under IFRS and prohibited under US GAAP**

> This requirement cannot be implemented until lower-of-cost-and-NRV measurement exists (see inv-lower-of-cost-and-NRV). It additionally needs a reporting-framework policy switch: the same fact pattern must reverse under IFRS and must NOT reverse under US GAAP. The organisation already carries an `asc740`/`ias12` framework flag for income tax; inventory has no equivalent.

## IAS 21

| Requirement | Citation | Status | Conformance |
| --- | --- | --- | --- |
| **A foreign-currency transaction is recorded at the spot rate on the transaction date**<br><sub>A sale invoiced in a foreign currency enters the books translated at that day's spot rate, and both the receivable and the revenue carry the same translated amount — no rate is applied to one leg and not the other.</sub> | IAS 21.21 | PASS | Implemented |
| **Monetary items are retranslated at the closing rate and the difference goes to profit or loss**<br><sub>A foreign-currency receivable is restated to the closing rate at the reporting date, the movement is recognised immediately in profit or loss, and the revenue already recognised at the transaction-date rate is left untouched.</sub> | IAS 21.23(a)<br>IAS 21.28<br>IAS 21.23(b) | PASS | Partial |
| **Retranslation restates the foreign balance and offsets the whole movement to profit or loss**<br><sub>Across several currencies and both directions of movement, each monetary balance is restated to foreign balance times closing rate and the net of every restatement lands in a single profit-or-loss account — the entry cannot leave a residual.</sub> | IAS 21.23(a)<br>IAS 21.28 | PASS | Implemented |
| **An unchanged closing rate produces no entry**<br><sub>A period in which rates did not move generates no journal entry at all, so period-end processing cannot manufacture immaterial noise in the ledger or in the exchange gain and loss account.</sub> | IAS 21.28 | PASS | Implemented |

### IAS 21 — shortfalls

**fx-monetary-item-retranslated-at-closing-rate — Monetary items are retranslated at the closing rate and the difference goes to profit or loss**

> The monetary-item population is narrower than IAS 21.16 requires. Period-end retranslation covers accounts typed as bank, receivable and payable only. Foreign-currency loans and other long-term debt, accrued liabilities, and other monetary balances carried outside those three account types are NOT retranslated and must be adjusted by manual journal.

## IFRS 16

| Requirement | Citation | Status | Conformance |
| --- | --- | --- | --- |
| **IFRS applies one lessee model to every lease**<br><sub>The identical lease produces a different expense profile under IFRS than under US GAAP — front-loaded rather than flat — which is why a dual-reporting entity cannot use one set of numbers for both.</sub> | IFRS 16.22<br>IFRS 16.31 | GAP | Not implemented |
| **Short-term and low-value leases may be kept off balance sheet**<br><sub>An elected short-term lease charges rent straight-line to expense and recognises no asset or liability, and the election is recorded so it can be applied consistently and disclosed.</sub> | IFRS 16.5<br>ASC 842 842-20-25-2 | GAP | Not implemented |
| **A lessor classifies each lease and accounts for it accordingly**<br><sub>A lessor tests each lease against the classification criteria, recognises operating-lease rent evenly over the term regardless of the billing pattern, and derecognises the underlying asset for a sales-type lease.</sub> | IFRS 16.61<br>IFRS 16.81<br>ASC 842 842-30-25-1 | GAP | Not implemented |

### IFRS 16 — shortfalls

**lease-ifrs-single-lessee-model — IFRS applies one lessee model to every lease**

> There is no lessee lease accounting. No schema exists for lease contracts, discount rates, lease terms, renewal or termination options, or payment schedules; nothing computes a present value; and no right-of-use asset or lease liability is ever recognised. Leases entered into as lessee are accounted for only as the cash payments are made, which is the pre-ASC 842 and pre-IFRS 16 treatment. Any entity with material leases must maintain the lease schedule and the balance-sheet amounts outside the system and post them by manual journal. A dual-reporting entity additionally needs the same lease to produce the IFRS single-model result and the US GAAP operating-lease result from one set of source data.

**lease-short-term-and-low-value-exemption — Short-term and low-value leases may be kept off balance sheet**

> Without lessee lease accounting there is nothing to exempt from. When the module is built, the election must be recorded per class of underlying asset, applied consistently, and disclosed — an election taken silently is itself an audit finding.

**lease-lessor-classification — A lessor classifies each lease and accounts for it accordingly**

> The property-management module bills tenant rent and recognises it as revenue when charged, which resembles operating-lease lessor accounting but is not derived from a classification test. There is no assessment of whether a lease transfers substantially all the risks and rewards of ownership, no sales-type or direct-financing treatment, no net investment in the lease, and no straight-line levelling of escalating rents — an escalating lease is recognised as billed rather than levelled over the term.

## Reproducing this

```bash
npm -w engine run conformance -- report
```

Computation-tier cases need nothing but the repository. Ledger-tier cases post real documents through the accounting kernel and need `OPENBOOKS_DB_URL` pointed at a throwaway PostgreSQL database.
