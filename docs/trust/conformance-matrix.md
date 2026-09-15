# Accounting standards conformance matrix

Each row is one requirement of a published accounting standard, encoded as an executable fixture and run against OpenBooks. Amounts are compared exactly — a hundredth of a cent is a failure. Requirements the product does not implement are listed as **GAP**; they are never omitted and never counted as passing.

The wording of each requirement is our own restatement. Verify a row by reading the cited paragraph in an authoritative copy of the standard.

**75 passing · 0 failing · 10 gaps · 0 not run**

Commit `27b75e9d0d1c7cb3266c37e56e8f95b3bc981c1d` · 2026-09-15T21:22:06.529Z

## AL DOR

| Requirement | Citation | Status | Conformance |
| --- | --- | --- | --- |
| **Alabama withholding reproduces the booklet's official worked example**<br><sub>Annualized income of $44,200.00 less the $5,000.00 standard deduction, $3,000.00 personal exemption, $2,000.00 of dependent allowances and $1,829.88 of annualized federal tax leaves the booklet's taxable figure, and the engine's $29.59 matches the printed answer to the cent.</sub> | AL DOR Withholding Tax Tables and Instructions, rev. Aug 2024 — official M-2 / $850 example | PASS | Implemented |

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
| **A change in the progress estimate is caught up in the current period**<br><sub>Revising the estimated progress restates the cumulative target and books only the delta in the current period — an upward revision recognises more, a downward revision reverses what was already recognised, and prior periods are never restated.</sub> | ASC 606 606-10-25-31<br>IFRS 15.39 | PASS | Implemented |
| **A contract modification is assessed as a separate contract or as part of the existing one**<br><sub>Adding distinct services at their standalone selling prices mid-contract creates a separate accounting unit, while other changes remeasure the existing obligation prospectively or with a cumulative catch-up.</sub> | ASC 606 606-10-25-10<br>IFRS 15.18 | GAP | Not implemented |
| **A progress application measures work done, withholds retainage, and states the amount due**<br><sub>Each schedule line reports what was completed this period, the retainage held back on it, and the net now due — and the application's totals are exactly the sum of its lines, so nothing is lost between the detail and the invoice.</sub> | ASC 606 606-10-25-27<br>IFRS 15.35 | PASS | Implemented |
| **An approved change order revises the contract value but never below work already billed**<br><sub>Additions and deductions move the schedule line's capacity by exactly the change amount — but a deduction that would erase already-billed work is refused, so billed revenue can never be stranded without a contract value behind it.</sub> | ASC 606 606-10-25-10<br>IFRS 15.18 | PASS | Implemented |
| **Cost-to-cost measures progress by the share of budget consumed**<br><sub>Progress is the exact share of budget consumed — a quarter of the budget spent is 25% complete — capped at 100% when costs overrun, and zero when there is no budget or no cost yet, so an unbudgeted project can never report phantom progress.</sub> | ASC 606 606-10-25-31<br>IFRS 15.39 | PASS | Implemented |

### ASC 606 — shortfalls

**rev-contract-modification — A contract modification is assessed as a separate contract or as part of the existing one**

> The revenue engine has no contract-modification assessment: setContractPricing can overwrite a contract's total price but nothing classifies a scope-or-price change as a separate contract, a prospective remeasurement, or a cumulative catch-up, and obligations and schedules are never remapped for it.

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
| **An enacted rate change remeasures opening deferred balances in the period of enactment**<br><sub>When the enacted rate moves, the opening deferred balance is carried to the new rate and the whole remeasurement lands in deferred tax expense of the enactment period — current tax is untouched because no new timing difference arose.</sub> | ASC 740 740-10-35-4<br>IAS 12.60 | PASS | Implemented |

## ASC 842

| Requirement | Citation | Status | Conformance |
| --- | --- | --- | --- |
| **A lessee recognises a right-of-use asset and a lease liability at commencement**<br><sub>Commencing a lease puts both an asset and a liability on the balance sheet at the exact present value of the payments — leased capacity and the obligation to pay for it are visible, not off balance sheet, and the discounting is exact to the hundredth of a cent.</sub> | ASC 842 842-20-30-1<br>IFRS 16.26<br>IFRS 16.23 | PASS | Implemented |
| **A finance lease reports interest and amortisation separately**<br><sub>A finance lease produces a front-loaded total charge with the interest element presented in finance costs rather than operating expenses — the split that changes reported operating profit and every coverage ratio computed from it.</sub> | ASC 842 842-20-25-5<br>IFRS 16.49 | PASS | Implemented |
| **A US GAAP operating lease reports a single straight-line lease cost**<br><sub>A lease meeting no finance criterion classifies as operating under US GAAP and charges one flat amount to operating expense each year — while still carrying the asset and liability on the balance sheet, the liability unwinding on the interest method and the right-of-use asset absorbing the difference.</sub> | ASC 842 842-20-25-6<br>ASC 842 842-10-25-2 | PASS | Implemented |
| **A change in the lease payments or term remeasures the liability and the right-of-use asset**<br><sub>Revised payments re-discount to a revised liability with the difference adjusting the right-of-use asset — the balance sheet keeps reflecting what is actually owed, not what was estimated at commencement.</sub> | ASC 842 842-10-35-4<br>IFRS 16.39 | GAP | Not implemented |

### ASC 842 — shortfalls

**lease-remeasurement — A change in the lease payments or term remeasures the liability and the right-of-use asset**

> The lease engine measures once at commencement and posts the frozen schedule: no API re-discounts the remaining payments, adjusts the liability and right-of-use asset, or spreads the revised interest over the remaining term.

## CDTFA Reg 1684

| Requirement | Citation | Status | Conformance |
| --- | --- | --- | --- |
| **California ignores transaction count: only the $500,000 sales threshold binds**<br><sub>$200,000 of sales with one hundred thousand transactions is not nexus in California, while $600,000 with no transactions at all is — the transaction count is genuinely ignored, not merely outweighed.</sub> | CDTFA Reg 1684 Cal. RTC 6203 — $500,000 sales threshold | PASS | Implemented |

## CRA GST34

| Requirement | Citation | Status | Conformance |
| --- | --- | --- | --- |
| **A GST34 return with tax owing computes every box from the ledger**<br><sub>With $1,000.00 of sales, $50.00 of tax collected and $20.00 of input credits, the return computes net tax of $30.00 owing — line 109 flows through 113A and 113C into a $30.00 payment on line 115 with no refund on line 114.</sub> | CRA GST34 GST34 lines 101/103/105/106/108/109/113C/114/115 | PASS | Implemented |
| **A GST34 return with excess credits claims a refund, not a negative payment**<br><sub>With $10.00 collected and $25.00 of credits, the $15.00 negative balance becomes a $15.00 refund on line 114 with $0.00 on the payment line — the return never presents a negative payment.</sub> | CRA GST34 GST34 lines 109/113C/114/115 | PASS | Implemented |

## CRA T4127

| Requirement | Citation | Status | Conformance |
| --- | --- | --- | --- |
| **Weekly CPP and EI apply at statutory rates within their maxima**<br><sub>A $1,500.00 weekly Saskatchewan pay deducts $85.25 of CPP and $24.45 of EI, and the employer accrues $85.25 and $34.23 — every figure the guide's per-period formulas produce, with neither maximum yet in reach.</sub> | CRA T4127 T4127 122nd edition — CPP/QPP and EI factors (C, EI) | PASS | Implemented |
| **Earnings above the YMPE attract the second-tier CPP2 contribution**<br><sub>An employee whose year-to-date pensionable earnings reach $74,000.00 pays $56.00 of CPP2 on a $2,000.00 biweekly pay — 4% on exactly the $1,400.00 of the band this period enters — while base CPP continues against its own remaining room.</sub> | CRA T4127 T4127 122nd edition — second-additional factor (C2, W) | PASS | Implemented |
| **EI premiums stop once the annual maximum is reached**<br><sub>An employee who has already paid the full $1,123.07 of EI pays $0.00 on a further $2,000.00 of insurable earnings — while CPP, which has its own maximum still unreached, continues at $110.99.</sub> | CRA T4127 T4127 122nd edition — EI maximum (D1) | PASS | Implemented |
| **Québec pay carries QPP, QPIP and reduced EI with the federal abatement**<br><sub>A $1,500.00 weekly Québec pay deducts $90.26 of QPP, $19.50 of EI at the Québec rate, and $6.45 of QPIP, while federal tax is reduced by the 16.5% abatement to a $141.63 period withholding — with no provincial T4127 tax, which Revenu Québec administers separately.</sub> | CRA T4127 T4127 122nd edition — Quebec factors (QPP, QPIP, abatement) | PASS | Implemented |
| **A small bonus is taxed at the lump-sum rate, not the marginal rate**<br><sub>A $2,000.00 bonus paid with no other income in the year attracts exactly $300.00 of tax at the 15% lump-sum rate — while CPP and EI still apply to the bonus as pensionable and insurable earnings.</sub> | CRA T4127 T4127 122nd edition — tax on non-periodic payments (TB) | PASS | Implemented |
| **Cumulative averaging (Option 2) for uneven pay**<br><sub>An employee paid unevenly through the year has income tax averaged cumulatively across elapsed periods, so a large early payment does not over-withhold against the annual liability.</sub> | CRA T4127 T4127 — Option 2 cumulative averaging | GAP | Not implemented |
| **Québec provincial income tax (TP-1015)**<br><sub>A Québec pay deducts provincial income tax per the TP-1015 tables alongside federal tax, QPP, QPIP and EI — the stub's total withholding is complete for a Québec employee.</sub> | CRA T4127 T4127 — Quebec provincial tax administered via TP-1015 | GAP | Not implemented |

### CRA T4127 — shortfalls

**payroll-cumulative-averaging — Cumulative averaging (Option 2) for uneven pay**

> The engine implements only the Option-1 periodic method (plus the YTD variant of the K2 credit basis, which is not Option 2). There is no cumulative-averaging computation: uneven pay is annualized period by period, which over-withholds early lump sums relative to the guide's Option 2.

**payroll-quebec-provincial-tax — Québec provincial income tax (TP-1015)**

> Québec provincial income tax is not implemented: the engine computes the federal side for Québec employment (abatement, K2Q, QPP/QPIP) and provincials for every other jurisdiction, but TP-1015 tables are absent, so a Québec stub understates total withholding by the provincial share.

## ETA

| Requirement | Citation | Status | Conformance |
| --- | --- | --- | --- |
| **Tax-exclusive consideration bears GST at the statutory rate**<br><sub>A tax-exclusive line of $100.00 carries exactly $5.00 of GST and settles at $105.00 — the net amount posted to revenue is untouched by the tax.</sub> | ETA 165(1) | PASS | Implemented |
| **A tax-included price yields the exact statutory tax with no residue**<br><sub>A $105.00 tax-included price extracts to exactly $100.00 of revenue and $5.00 of GST — the line cross-foots to the penny with no rounding residue parked anywhere.</sub> | ETA 165(1) | PASS | Implemented |
| **Each line's tax rounds independently before the document total is summed**<br><sub>Three lines of $33.33, $33.33 and $33.34 each carry $1.67 of GST for a $5.01 document tax — one cent above the $5.00 a single $100.00 line would carry. The penny is the deterministic consequence of per-line rounding, stated openly rather than forced to agree.</sub> | ETA 165(1) | PASS | Implemented |
| **A partially recoverable tax splits into credit and cost exactly**<br><sub>A $10.00 tax that is 50% recoverable produces a $5.00 input credit and a $5.00 non-recoverable cost — the split sums to the tax with neither side rounded away.</sub> | ETA 169(1) | PASS | Implemented |
| **Native place-of-supply determination from the delivery address**<br><sub>Given a supply and its delivery province, the kernel selects the applicable sourced rate (GST 5% for Alberta, HST 13% for Ontario) on its own, without the merchant pre-selecting the tax code or calling an external rate service.</sub> | ETA 144.1 (place of supply) | GAP | Not implemented |

### ETA — shortfalls

**sales-tax-place-of-supply — Native place-of-supply determination from the delivery address**

> The country packs carry sourced jurisdictional rates (Ontario HST 13%, GST 5%) but the kernel never selects among them: the merchant configures which tax code a document line uses, or an external rate provider quotes it. There is no native place-of-supply function mapping a delivery province or address to the applicable pack rate, and the packs self-report sourcingRules as partial.

## HMRC VAT700/12

| Requirement | Citation | Status | Conformance |
| --- | --- | --- | --- |
| **A VAT100 return nets output tax against reclaimed input tax**<br><sub>With £200.00 of output VAT and £50.00 of input VAT, box 3 is £200.00 and box 5 is £150.00 to pay — while boxes 6 and 7 carry the £1,000.00 of net sales and £250.00 of net purchases the tax was computed from.</sub> | HMRC VAT700/12 VAT100 boxes 1/3/4/5/6/7 | PASS | Implemented |

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
| **Freight and duty to bring inventory to its location join the cost of the stock**<br><sub>A freight voucher spreads exactly onto the on-hand layers, raising their carrying amount and debiting inventory against the freight account — the quantity on hand does not move and the subledger stays in agreement with the general ledger.</sub> | IAS 2.11<br>ASC 330 330-10-30-9 | PASS | Implemented |

## IAS 21

| Requirement | Citation | Status | Conformance |
| --- | --- | --- | --- |
| **A foreign-currency transaction is recorded at the spot rate on the transaction date**<br><sub>A sale invoiced in a foreign currency enters the books translated at that day's spot rate, and both the receivable and the revenue carry the same translated amount — no rate is applied to one leg and not the other.</sub> | IAS 21.21 | PASS | Implemented |
| **Monetary items are retranslated at the closing rate and the difference goes to profit or loss**<br><sub>A foreign-currency receivable is restated to the closing rate at the reporting date, the movement is recognised immediately in profit or loss, and the revenue already recognised at the transaction-date rate is left untouched.</sub> | IAS 21.23(a)<br>IAS 21.28<br>IAS 21.23(b) | PASS | Implemented |
| **A foreign-currency loan is a monetary item and is retranslated at the closing rate**<br><sub>A foreign-currency borrowing carried as long-term debt — outside the bank/receivable/payable account types — is retranslated at the closing rate once the account is designated a monetary item, so debt-heavy balance sheets are not silently left at historical rates.</sub> | IAS 21.16<br>IAS 21.23(a) | PASS | Implemented |
| **Retranslation restates the foreign balance and offsets the whole movement to profit or loss**<br><sub>Across several currencies and both directions of movement, each monetary balance is restated to foreign balance times closing rate and the net of every restatement lands in a single profit-or-loss account — the entry cannot leave a residual.</sub> | IAS 21.23(a)<br>IAS 21.28 | PASS | Implemented |
| **An unchanged closing rate produces no entry**<br><sub>A period in which rates did not move generates no journal entry at all, so period-end processing cannot manufacture immaterial noise in the ledger or in the exchange gain and loss account.</sub> | IAS 21.28 | PASS | Implemented |
| **A multi-line invoice translates balanced through a ten-decimal inverse rate**<br><sub>A multi-line sale invoiced in USD at the ten-decimal inverse of a stored CAD→USD pair — 1.4285714286, exactly the figure posting derives itself as (1 / 0.7)::numeric(19,10) when the exchange table holds only one direction — lands in CAD with every line translated independently and the entry balancing to exactly zero; per-line rounding never leaks a residual into any account, least of all a control account.</sub> | IAS 21.21 | PASS | Implemented |
| **Output tax on a foreign-currency invoice equals the translated statutory amount exactly, and the translation residual lands on a trading line**<br><sub>On a taxed, multi-line USD invoice translated through a ten-decimal rate whose per-line roundings do NOT reconcile, the tax control lines carry exactly tax-total × spot rate and the one-unit translation residual is absorbed by a revenue line — no translation residual is parked on a statutory return line where it would flow straight into a filed figure.</sub> | IAS 21.21 | PASS | Implemented |
| **Settling a monetary item recognises the realized difference in profit or loss**<br><sub>Collecting part of a foreign-currency receivable clears exactly the proportional share of its carrying value, values the cash at the settlement-date rate, and books the difference as a realized gain or loss — the settled slice never leaves a tail behind and the unsettled slice keeps its historical carrying value.</sub> | IAS 21.28<br>ASC 830-20-35-1 | PASS | Implemented |
| **Settling the complete foreign balance consumes the complete carrying value**<br><sub>Taking the complete residual consumes the complete carrying value — including a sub-cent rounding tail — so proportional rounding can never strand an uncloseable one-unit balance on a fully settled item.</sub> | IAS 21.28 | PASS | Implemented |
| **A non-monetary asset measured at historical cost is not retranslated**<br><sub>Equipment bought in a foreign currency keeps its transaction-date translated cost through a period-end close that moves the rate: the revaluation run finds no monetary exposure in the asset or its matching foreign-currency liability and posts nothing — neither a gain nor a loss, and no restatement of cost.</sub> | IAS 21.23(b)<br>ASC 830-10-45-17 | PASS | Implemented |
| **Exchange differences on a net investment in a foreign operation**<br><sub>A long-term intercompany balance that is in substance part of a net investment in a foreign operation has its exchange differences recognised in other comprehensive income until the investment is disposed of.</sub> | IAS 21.32 | GAP | Not implemented |
| **A foreign subsidiary translates profit at the average rate and equity at history**<br><sub>An 80%-owned USD subsidiary with USD 1,000.00 of equity acquired when the policy rate was 1.30 eliminates at CAD 1,300.00, while its USD 100.00 profit translates at the period average of 1.3750 to CAD 137.50 — and the 20% NCI income of CAD 27.50 proves the average, not the spot, was applied.</sub> | IAS 21.39<br>ASC 830-30-45-3 | PASS | Implemented |

### IAS 21 — shortfalls

**fx-net-investment-oci — Exchange differences on a net investment in a foreign operation**

> The product has no net-investment designation for intercompany monetary items: every monetary exchange difference the revaluation engine computes is offset to the profit-or-loss unrealized gain/loss account, and there is no other-comprehensive-income reserve for foreign-operation differences in the ledger.

## IAS 28

| Requirement | Citation | Status | Conformance |
| --- | --- | --- | --- |
| **An associate's profit increases the investment and its dividend reduces it**<br><sub>A 30% associate earning CAD 200.00 and declaring CAD 50.00 of dividends lifts the investment by CAD 45.00 in one entry — CAD 60.00 of equity income less the CAD 15.00 dividend share — with no NCI and no acquisition elimination, because an associate is never combined line by line.</sub> | IAS 28.16<br>ASC 323-10-35-4 | PASS | Implemented |

## IAS 37

| Requirement | Citation | Status | Conformance |
| --- | --- | --- | --- |
| **A contract expected to lose money provides for the full loss immediately**<br><sub>The moment a contract is forecast to lose money, the entire expected loss is charged to profit or loss at once — it is never spread over the remaining term to flatter early periods.</sub> | IAS 37.66<br>ASC 450 450-20-25-2 | GAP | Not implemented |
| **A probable, estimable obligation is recognised as a provision**<br><sub>A lawsuit that will probably cost 50,000.00 appears on the balance sheet now — a probable obligation is never left off the books until the cash leaves.</sub> | IAS 37.14<br>ASC 450 450-20-25-2 | GAP | Not implemented |
| **A provision is measured at the best estimate and reviewed every period**<br><sub>The provision tracks the current best estimate — when new information moves the estimate from 50,000.00 to 65,000.00, a further 15,000.00 is charged in the period the estimate changes.</sub> | IAS 37.36<br>IAS 37.59 | GAP | Not implemented |

### IAS 37 — shortfalls

**con-expected-loss-provided — A contract expected to lose money provides for the full loss immediately**

> No engine assesses construction contracts for expected losses: progress billing tracks completed value and billings, but nothing forecasts cost to complete, tests the contract for a loss, or posts a provision for it.

**prov-recognition-threshold — A probable, estimable obligation is recognised as a provision**

> No provisions engine exists: nothing records a present obligation, tests it against the probable-and-estimable threshold, or posts the resulting liability — such obligations can only be entered as manual journals with no recognition discipline behind them.

**prov-best-estimate-measurement — A provision is measured at the best estimate and reviewed every period**

> With no provisions ledger there is nothing to remeasure: no periodic review of open provisions, no adjustment path for a changed estimate, and no utilisation tracking when the obligation settles.

## IFRS 10

| Requirement | Citation | Status | Conformance |
| --- | --- | --- | --- |
| **Full consolidation eliminates the subsidiary and recognises NCI**<br><sub>Acquiring 80% of a subsidiary eliminates its acquisition-date equity against the parent's investment, recognises the 20% non-controlling interest at its proportionate share of fair value with goodwill for the remainder, and allocates 20% of the period's profit to NCI — every leg exact to the cent.</sub> | IFRS 10.22<br>IFRS 10.B94<br>ASC 810-10-45-16 | PASS | Implemented |
| **Intercompany balances eliminate to zero while standalone views stay untouched**<br><sub>A CAD 1,000.00 intercompany receivable on the parent exactly offsets the subsidiary's CAD 1,000.00 payable, and the elimination entry reverses both — the consolidated view nets to zero while the source postings on each entity stand unchanged.</sub> | IFRS 10.B86<br>ASC 810-10-45-1 | PASS | Implemented |
| **Loss of control derecognises the subsidiary and remeasures any retained interest**<br><sub>Selling down from 80% to 20% removes the subsidiary's net assets and NCI from the consolidated balance sheet, books the retained 20% at its fair value, and recognises the resulting gain or loss with the accumulated translation difference reclassified out of equity.</sub> | IFRS 10.25 | GAP | Not implemented |

### IFRS 10 — shortfalls

**consol-loss-of-control — Loss of control derecognises the subsidiary and remeasures any retained interest**

> The engine has no loss-of-control accounting: closing or narrowing an ownership policy simply stops future consolidation generations, leaving the parent's investment at cost with no derecognition of the subsidiary's net assets, no release of NCI, no fair-value remeasurement of any retained interest, and no reclassification of translation differences.

## IFRS 11

| Requirement | Citation | Status | Conformance |
| --- | --- | --- | --- |
| **Proportionate consolidation combines only the owned share, with no NCI**<br><sub>A 50%-owned joint operation eliminates the owned half of its acquisition-date equity against the parent's investment with no NCI entry at all — the reporting layer weights the subsidiary's lines, so the run posts the owned-share elimination and stops.</sub> | IFRS 11.20 | PASS | Implemented |

## IFRS 16

| Requirement | Citation | Status | Conformance |
| --- | --- | --- | --- |
| **IFRS applies one lessee model to every lease**<br><sub>The identical lease produces a front-loaded charge under IFRS and a flat charge under US GAAP — the classification step is skipped entirely under IFRS, and a dual-reporting entity gets each framework's answer from the same source data by switching the configured framework.</sub> | IFRS 16.22<br>IFRS 16.31 | PASS | Implemented |
| **Short-term and low-value leases may be kept off balance sheet**<br><sub>An elected short-term lease recognises no asset or liability at commencement and charges rent straight to expense as paid — and the election is validated against eligibility, so a thirteen-month lease cannot quietly take it.</sub> | IFRS 16.5<br>ASC 842 842-20-25-2 | PASS | Implemented |
| **A lessor classifies each lease and accounts for it accordingly**<br><sub>A lessor tests each lease against the classification criteria — sales-type, direct financing (selling profit deferred into the net investment), or operating; an operating lease's escalating rent levels to straight-line income with the accrual returning to exactly zero over the term, and the levelling accrual is posted against the property billing pipeline by the levelling service, not left as a manual adjustment.</sub> | IFRS 16.61<br>IFRS 16.81<br>ASC 842 842-30-25-1 | PASS | Implemented |

## IRS Pub 15

| Requirement | Citation | Status | Conformance |
| --- | --- | --- | --- |
| **Supplemental wages past $1M and wages past the Social Security base are handled exactly**<br><sub>A $200,000.00 bonus on top of $900,000.00 of prior supplemental pay withholds $59,000.00 — $100,000.00 at 22% and $100,000.00 at the mandatory 37% — while Social Security caps at $11,439.00, Medicare runs uncapped at $2,943.50, and Additional Medicare takes $27.00 on the slice above $200,000.00.</sub> | IRS Pub 15 Pub 15 section 7 — supplemental wage withholding<br>IRC 3101/3111 IRC 3101(b)(2) — Additional Hospital Insurance Tax | PASS | Implemented |

## IRS Pub 15-T

| Requirement | Citation | Status | Conformance |
| --- | --- | --- | --- |
| **US federal withholding follows Worksheet 1A with FICA alongside**<br><sub>A single filer earning $3,000.00 biweekly withholds $320.38 of federal income tax — $8,330.00 of tentative annual tax de-annualized over 26 periods — plus $186.00 of Social Security and $43.50 of Medicare, each matched by the employer.</sub> | IRS Pub 15-T Pub 15-T Worksheet 1A (percentage method)<br>IRC 3101/3111 IRC 3101(a)-(b) / 3111(a)-(b) — OASDI and Hospital Insurance rates | PASS | Implemented |

## NY Tax Law 1101

| Requirement | Citation | Status | Conformance |
| --- | --- | --- | --- |
| **New York requires both $500,000 of sales and 100 transactions**<br><sub>$600,000 with 50 transactions is not nexus in New York, while the same sales with 150 transactions is — the conjunction is enforced, not treated as a disjunction.</sub> | NY Tax Law 1101 Tax Law 1101(b)(8)(iv) — $500,000 and 100 transactions | PASS | Implemented |

## RQ QST

| Requirement | Citation | Status | Conformance |
| --- | --- | --- | --- |
| **QST compounds on the GST-included price**<br><sub>On a $100.00 Québec sale the engine charges $5.00 of GST and then 9.975% on the GST-included $105.00 — $10.47 of QST — for a $115.47 total. The compounding order is the return-affecting figure, and it is exact.</sub> | RQ QST RQ calculating GST and QST | PASS | Implemented |

## SD v. Wayfair

| Requirement | Citation | Status | Conformance |
| --- | --- | --- | --- |
| **A default state is met through either the sales or the transaction trigger**<br><sub>Either trigger alone creates the obligation: $120,000 with 5 transactions is met, 250 transactions at $40,000 is met, and $40,000 with 5 transactions is not.</sub> | SD v. Wayfair 585 U.S. 342 (2018) | PASS | Implemented |

## Reproducing this

```bash
npm -w engine run conformance -- report
```

Computation-tier cases need nothing but the repository. Ledger-tier cases post real documents through the accounting kernel and need `OPENBOOKS_DB_URL` pointed at a throwaway PostgreSQL database.
