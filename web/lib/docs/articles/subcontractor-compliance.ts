import type { DocArticle } from '../types'

export const subcontractorCompliance: DocArticle = {
  slug: 'subcontractor-compliance',
  title: 'Subcontractor Compliance',
  category: 'projects',
  order: 6,
  summary:
    'Track certificates of insurance, exchange lien waivers for payment, and file 1099-NEC/MISC and T4A information returns — with payment holds when a subcontractor’s coverage lapses.',
  updated: '2026-07-25',
  keywords: [
    'compliance',
    'certificate of insurance',
    'COI',
    'lien waiver',
    'W-9',
    '1099',
    '1099-NEC',
    '1099-MISC',
    'T4A',
    'information return',
    'subcontractor',
    'additional insured',
    'backup withholding',
  ],
  related: ['project-types', 'field-tickets', 'purchasing-workflow'],
  body: `# Subcontractor Compliance

Paying a subcontractor whose insurance lapsed a month ago is how a general
contractor inherits somebody else's claim. Paying one without a signed lien
waiver is how a paid-for job ends up with a lien on it anyway. This module makes
both impossible by putting the control where the money moves: **a bill for a
non-compliant subcontractor cannot enter a pay run, and cannot be released.**

Switch it on in **Company Settings → Features → Subcontractor compliance**. It
is off by default and turns itself on for the Construction and
Engineering/Architecture industry presets in the setup wizard. Turning it back
off preserves every certificate, waiver and filing — the only thing it refuses
is going dark while a finalized information return has not been filed yet.

## The three things it does

**Certificates of insurance and other evidence.** What each kind of counterparty
must carry, the limits and endorsements it must show, and what happens when it
lapses.

**Lien waivers.** Conditional and unconditional, progress and final, received
from subcontractors and issued to owners — with the through-date and amount the
payment control actually reads.

**Information returns.** 1099-NEC, 1099-MISC and T4A, computed from the cash you
actually paid in the calendar year rather than from what you were billed.

The lien-waiver surface additionally requires the **Projects** feature: a lien is
a claim against improved real property, and there is nothing to waive without a
project. Insurance tracking and 1099 filing stand on their own.

## Setting up the policy

Everything the module enforces is a row you author, not a hardcoded rule.

### Counterparty classes

**Setup → Compliance → Counterparty classes.** A class is what kind of
counterparty a vendor is — Trade Subcontractor, Material Supplier, Professional
Consultant, Equipment Rental. It carries two decisions:

| Setting | What it decides |
|---|---|
| Lien waiver control | None, warn, or block payment until a signed waiver covers the bill |
| Default waiver form | Which of the four statutory forms to request by default |
| Default information return | Which form vendors of this class file on, unless they say otherwise |

A vendor with **no class is not tracked** and never blocks a payment. There is no
separate "tracked" flag to fall out of sync — the class is the switch.

### Requirements

**Setup → Compliance → Compliance requirements.** One row per policy: General
Liability at two million naming us as additional insured, Workers' Compensation,
a current trade licence, a W-9. Each row says:

- **Applies to class** — leave empty and it applies to every tracked counterparty.
- **Limits** — a minimum per-occurrence and aggregate limit, plus the currency
  they are stated in. Limits are **never converted** between currencies: a
  certificate written in another currency fails the check rather than being
  silently approximated.
- **Endorsements** — additional insured, waiver of subrogation, primary and
  non-contributory.
- **On failure** — report only, warn on payment, block payment, or block the
  bill from being recorded at all. Blocking the bill is strictly stronger than
  blocking payment.
- **Grace days** and **warn before expiry** — the courtesy window after a lapse,
  and how far ahead a coming expiry starts surfacing.

Want the same certificate demanded of two classes with different limits? That is
two rows. This is deliberate: every enforced number has exactly one home.

## Day to day

### Recording a certificate

Open a subcontractor from **Compliance → Subcontractors**, or from the vendor
record, and record the certificate on the Compliance tab: insurer, policy
number, effective and expiry dates, limits, endorsements. Attach the PDF — it
lands in the File Cabinet and stays linked to the record.

A certificate is recorded as **pending review**. It does not count until someone
**else** verifies it. The person who recorded it can never be the person who
verifies it, and that is enforced at the API, not just hidden in the interface.

Renewals are new records, not edits. Point the new certificate at the one it
renews and the old row is marked superseded, keeping its dates and its
verification trail intact. The resolver always evaluates whichever record covers
furthest.

### The matrix

**Compliance → Subcontractors** is a grid: one row per tracked subcontractor,
one column per policy. A per-vendor list makes it impossible to notice that nine
subs all let the same certificate lapse in the same week; the grid makes it
obvious. Every cell is the same evaluation the pay run performs, so a green row
is a promise the pay run will keep.

### Exceptions

Sometimes you have to pay anyway. An **exception** is the only legitimate way
past a blocking requirement, and it is deliberately expensive to use: its own
permission, a mandatory reason, a mandatory end date capped at 120 days, and a
permanent audit entry. Revoking one is recorded rather than deleted — the window
during which a control was suspended is exactly what a reviewer needs to see.

A longer suspension is a policy change. Change the policy.

## Lien waivers

The four standard forms differ in what they release and when, and the difference
is not cosmetic:

| Form | Releases | Effective |
|---|---|---|
| Conditional progress | Work through a date | Only once the payment clears the bank |
| Unconditional progress | Work through a date | Immediately, cleared or not |
| Conditional final | The whole contract, retention included | Only once final payment clears |
| Unconditional final | The whole contract, retention included | Immediately, cleared or not |

Create a waiver from **Compliance → Lien waivers**, print the form, and record
it as signed once the executed document is in hand. Marking a waiver signed is
what releases a blocked payment, so it is the one action in the module treated
as consequential: it demands the signatory's name and the date, records who in
your organisation attested to receiving it, and freezes the amount and
through-date afterwards.

The printed form is our own document reproducing the operative language of the
type you chose, with the jurisdiction you name printed on it. It is not a
government-issued form — have counsel confirm the wording your jurisdiction
requires.

### How coverage is judged

A waiver releases a bill when it is **signed**, for the **same project**, its
through-date **reaches the bill's date**, and its amount **at least matches** the
bill, in the same currency. A waiver explicitly linked to a bill governs that
bill even when a larger unlinked one exists — that is the pairing the signatory
intended.

## What the control does to payments

When compliance is on, three points evaluate every subcontractor bill:

1. **Pay-run creation** refuses a selection containing a blocked bill. It refuses
   the whole selection rather than silently dropping bills, because a quietly
   shortened run leaves an operator believing a subcontractor was paid.
2. **Run readiness** re-evaluates before the file is generated — a run created on
   Monday can be released on Friday, by which time a certificate may have
   lapsed.
3. **Posting the run** evaluates once more and blocks the individual instruction,
   so one lapsed certificate never strands everyone else's money.

A **block the bill** requirement goes further and refuses the posting itself, in
the kernel, so no import, script, or API route can route around it. Historical
migration posts are exempt — old books are reproduced as they were, not
re-adjudicated.

Every one of those evaluations is written out in full: what the policy was, what
was on file, and what was decided. That frozen snapshot is why tightening a
policy tomorrow never reinterprets a release granted today.

## Information returns

**Compliance → Information returns** prepares 1099-NEC, 1099-MISC and T4A.

Open a filing for a completed calendar year and compute it. The figure is
**cash paid**, not billed: every posted vendor payment in the year is traced
through its applications to the bills it settled, through those bills to their
expense lines, and through each line's account to a box. A payment that settled
nothing — a retainer or an advance — lands in the recipient's default box,
because the money did leave.

The allocation is exact: a recipient's boxes always re-add to the cash that left
the bank, to the penny, with no rounding residue.

### Mapping accounts to boxes

Boxes are law; which of **your** accounts feeds which box is your configuration,
in **Setup → Compliance → Information return boxes**. Anything unmapped falls to
the vendor's default box, so an organisation that reports all subcontract cost as
nonemployee compensation configures nothing at all. Unmapped spend is reported as
an exception rather than absorbed silently.

### The readiness queue

Below the filings list is the queue that has to be empty before January:

- reportable vendors with **no taxpayer identification number** on file;
- reportable vendors with **no form assigned**;
- vendors **paid over the threshold that nobody flagged** as reportable;
- **corporations flagged as reportable**, which are generally outside 1099
  reporting except for attorney gross proceeds and medical payments;
- vendors flagged for **backup withholding** where nothing was withheld.

Taxpayer identification numbers are sealed at rest. Only the last four digits are
ever displayed, and the full number never appears in the audit trail or in the
transmittal export.

### Reviewing and filing

The worksheet shows the computed figure and any deliberate adjustment side by
side. Adjustments are stored as **signed deltas** against the ledger figure and
require a reason, so the trace back to the books is never overwritten;
recomputing preserves them, along with any recipient a person chose to exclude.

**Finalize** freezes the filing and snapshots the payer identification that will
be transmitted. It refuses to freeze a filing that still has a recipient with no
identification number — collect the W-9 or exclude them first. Afterwards the
filing is read-only: corrections go on a new corrected filing.

Recipient copies print as a substitute Copy B, clearly marked not for filing.
The transmittal export is the file your filing channel or agent consumes.

## Permissions

Five keys, because these are five different duties:

| Permission | Allows |
|---|---|
| compliance.read | See the matrix, waivers and filings |
| compliance.manage | Record certificates, waivers and filings; classify vendors |
| compliance.verify | Attest that a certificate satisfies the policy |
| compliance.waive | Grant and revoke exceptions to a blocking requirement |
| compliance.file | Finalize, transmit and export information returns |

Recording evidence is not verifying it, granting an exception to a payment block
is neither, and transmitting a statutory filing is its own authority.
`,
}
