# Accounting standards conformance matrix

Each row is one requirement of a published accounting standard, encoded as an executable fixture and run against OpenBooks. Amounts are compared exactly — a hundredth of a cent is a failure. Requirements the product does not implement are listed as **GAP**; they are never omitted and never counted as passing.

The wording of each requirement is our own restatement. Verify a row by reading the cited paragraph in an authoritative copy of the standard.

**40 passing · 0 failing · 0 gaps · 0 not run**

Commit `ddbd5016939077a73c972487604dbccb9bbe70f5` · 2026-08-26T13:28:48.589Z

## ASC 360

| Requirement | Citation | Status | Conformance |
| --- | --- | --- | --- |
| **An impaired asset is written down to fair value and the loss is recognised immediately**<br><sub>The carrying amount falls to fair value by exactly the shortfall, and the whole shortfall is charged to profit or loss in the period — no part of it is deferred or spread.</sub> | ASC 360 360-10-35-17<br>IAS 16.63 | PASS | Implemented (different mechanism) |
| **The written-down amount becomes the new cost basis for future depreciation**<br><sub>Future depreciation runs off the impaired carrying amount, so the asset is never depreciated back through an amount that has already been written off.</sub> | ASC 360 360-10-35-20<br>IAS 36.63 | PASS | Implemented |
| **Derecognition removes cost and accumulated depreciation and recognises the gain or loss**<br><sub>On sale, the asset's cost and its accumulated depreciation both leave the balance sheet entirely and the profit or loss recognised is exactly proceeds less carrying amount — a disposal cannot leave a stub balance behind.</sub> | ASC 360 360-10-40-5<br>IAS 16.71<br>IAS 16.68 | PASS | Implemented |
| **US GAAP prohibits reversing an impairment of a held-and-used asset**<br><sub>The same fair-value recovery after an impairment is refused outright under US GAAP — the impaired amount is the new cost basis — and recognised under IFRS only up to the unreversed impairment, so the carrying amount can never climb back above depreciated historical cost through the remeasurement path. The answer comes from the organisation's configured reporting framework.</sub> | ASC 360 360-10-35-20<br>IAS 36.114<br>IAS 36.117 | PASS | Implemented |

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
| **Variable consideration is constrained to the amount not subject to significant reversal**<br><sub>A contingent bonus is estimated by the stated method, the constraint caps what enters the transaction price, and the held-back amount is carried explicitly — so revenue can never include consideration management has judged subject to significant reversal.</sub> | ASC 606 606-10-32-11<br>ASC 606 606-10-32-8<br>IFRS 15.56 | PASS | Implemented |
| **A significant financing component is separated from revenue**<br><sub>Revenue on a contract paid materially in arrears is measured at the cash selling price — the promised amount discounted at the rate a separate financing would carry — and the difference accretes as interest, year by year, landing exactly on the billed amount.</sub> | ASC 606 606-10-32-15<br>IFRS 15.60 | PASS | Implemented |

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
| **Current tax is measured on taxable profit for the period**<br><sub>Taxable profit reflects permanent differences, utilised loss carryforwards, AND the year's originating movement in temporary differences — so income tax payable is the amount actually owed on the return, and the current/deferred split is right whenever timing differences exist.</sub> | ASC 740 740-10-30-2<br>IAS 12.12 | PASS | Implemented |
| **A taxable loss does not produce a negative current tax charge**<br><sub>A loss-making year reports no current tax rather than a negative payable, and the reconciliation discloses the unrecognised current benefit explicitly instead of burying it.</sub> | ASC 740 740-10-25-2 | PASS | Implemented |

## ASC 842

| Requirement | Citation | Status | Conformance |
| --- | --- | --- | --- |
| **A lessee recognises a right-of-use asset and a lease liability at commencement**<br><sub>Commencing a lease puts both an asset and a liability on the balance sheet at the exact present value of the payments — leased capacity and the obligation to pay for it are visible, not off balance sheet, and the discounting is exact to the hundredth of a cent.</sub> | ASC 842 842-20-30-1<br>IFRS 16.26<br>IFRS 16.23 | PASS | Implemented |
| **A finance lease reports interest and amortisation separately**<br><sub>A finance lease produces a front-loaded total charge with the interest element presented in finance costs rather than operating expenses — the split that changes reported operating profit and every coverage ratio computed from it.</sub> | ASC 842 842-20-25-5<br>IFRS 16.49 | PASS | Implemented |
| **A US GAAP operating lease reports a single straight-line lease cost**<br><sub>A lease meeting no finance criterion classifies as operating under US GAAP and charges one flat amount to operating expense each year — while still carrying the asset and liability on the balance sheet, the liability unwinding on the interest method and the right-of-use asset absorbing the difference.</sub> | ASC 842 842-20-25-6<br>ASC 842 842-10-25-2 | PASS | Implemented |

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
| **Inventory is written down to net realisable value when NRV falls below cost**<br><sub>When net realisable value falls below cost, the carrying amount of inventory is reduced to NRV through the cost layers themselves — the loss is recognised immediately, the on-hand QUANTITY is unchanged, and the inventory subledger stays in agreement with the general ledger.</sub> | IAS 2.9<br>IAS 2.28<br>ASC 330 330-10-35-1C | PASS | Implemented |
| **Reversal of a write-down is required under IFRS and prohibited under US GAAP**<br><sub>The same recovery in net realisable value reverses the write-down under IFRS — capped so cumulative reversals never exceed the cumulative write-down — and is refused outright under US GAAP, where the written-down amount is the new cost basis. The answer comes from the organisation's configured reporting framework, not from which function was called.</sub> | IAS 2.33<br>ASC 330 330-10-35-14 | PASS | Implemented |

## IAS 21

| Requirement | Citation | Status | Conformance |
| --- | --- | --- | --- |
| **A foreign-currency transaction is recorded at the spot rate on the transaction date**<br><sub>A sale invoiced in a foreign currency enters the books translated at that day's spot rate, and both the receivable and the revenue carry the same translated amount — no rate is applied to one leg and not the other.</sub> | IAS 21.21 | PASS | Implemented |
| **Monetary items are retranslated at the closing rate and the difference goes to profit or loss**<br><sub>A foreign-currency receivable is restated to the closing rate at the reporting date, the movement is recognised immediately in profit or loss, and the revenue already recognised at the transaction-date rate is left untouched.</sub> | IAS 21.23(a)<br>IAS 21.28<br>IAS 21.23(b) | PASS | Implemented |
| **A foreign-currency loan is a monetary item and is retranslated at the closing rate**<br><sub>A foreign-currency borrowing carried as long-term debt — outside the bank/receivable/payable account types — is retranslated at the closing rate once the account is designated a monetary item, so debt-heavy balance sheets are not silently left at historical rates.</sub> | IAS 21.16<br>IAS 21.23(a) | PASS | Implemented |
| **Retranslation restates the foreign balance and offsets the whole movement to profit or loss**<br><sub>Across several currencies and both directions of movement, each monetary balance is restated to foreign balance times closing rate and the net of every restatement lands in a single profit-or-loss account — the entry cannot leave a residual.</sub> | IAS 21.23(a)<br>IAS 21.28 | PASS | Implemented |
| **An unchanged closing rate produces no entry**<br><sub>A period in which rates did not move generates no journal entry at all, so period-end processing cannot manufacture immaterial noise in the ledger or in the exchange gain and loss account.</sub> | IAS 21.28 | PASS | Implemented |

## IFRS 16

| Requirement | Citation | Status | Conformance |
| --- | --- | --- | --- |
| **IFRS applies one lessee model to every lease**<br><sub>The identical lease produces a front-loaded charge under IFRS and a flat charge under US GAAP — the classification step is skipped entirely under IFRS, and a dual-reporting entity gets each framework's answer from the same source data by switching the configured framework.</sub> | IFRS 16.22<br>IFRS 16.31 | PASS | Implemented |
| **Short-term and low-value leases may be kept off balance sheet**<br><sub>An elected short-term lease recognises no asset or liability at commencement and charges rent straight to expense as paid — and the election is validated against eligibility, so a thirteen-month lease cannot quietly take it.</sub> | IFRS 16.5<br>ASC 842 842-20-25-2 | PASS | Implemented |
| **A lessor classifies each lease and accounts for it accordingly**<br><sub>A lessor tests each lease against the classification criteria — sales-type, direct financing (selling profit deferred into the net investment), or operating; an operating lease's escalating rent levels to straight-line income with the accrual returning to exactly zero over the term, and the levelling accrual is posted against the property billing pipeline by the levelling service, not left as a manual adjustment.</sub> | IFRS 16.61<br>IFRS 16.81<br>ASC 842 842-30-25-1 | PASS | Implemented |

## Reproducing this

```bash
npm -w engine run conformance -- report
```

Computation-tier cases need nothing but the repository. Ledger-tier cases post real documents through the accounting kernel and need `OPENBOOKS_DB_URL` pointed at a throwaway PostgreSQL database.
