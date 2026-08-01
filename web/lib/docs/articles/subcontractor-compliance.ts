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

The Subcontractor Compliance module applies insurance and lien-waiver controls
to vendor payments. When policy requires a blocking response, a bill for a
noncompliant subcontractor cannot enter or be released from a pay run.

Switch it on in **Company Settings → Features → Subcontractor compliance**. It
is off by default and is enabled automatically for the Construction and
Engineering/Architecture industry presets in the setup wizard. Turning it back
off preserves every certificate, waiver, and filing. The feature cannot be
disabled while a finalized information return remains unfiled.

## Functional areas

**Certificates of insurance and other evidence.** Defines required evidence by
counterparty class, including coverage limits, endorsements, and lapse behavior.

**Lien waivers.** Tracks conditional, unconditional, progress, and final waivers
received from subcontractors or issued to owners, including the through-date and
amount used by payment controls.

**Information returns.** Calculates 1099-NEC, 1099-MISC, and T4A amounts from
cash payments made during the calendar year rather than billed amounts.

The lien-waiver surface additionally requires the **Projects** feature: a lien is
a claim against improved real property and therefore requires a project.
Insurance tracking and information-return filing operate independently.

## Setting up the policy

Module controls are configuration-driven rather than hard-coded.

### Counterparty classes

**Setup → Compliance → Counterparty classes.** A class categorizes a vendor,
such as Trade Subcontractor, Material Supplier, Professional Consultant, or
Equipment Rental. It defines the following controls:

| Setting | Control |
|---|---|
| Lien waiver control | None, warn, or block payment until a signed waiver covers the bill |
| Default waiver form | Which of the four statutory forms to request by default |
| Default information return | Form assigned to vendors in the class unless a vendor-specific override exists |

A vendor with **no class is not tracked** and does not block payment. Assigning a
class enables compliance tracking for the vendor.

### Requirements

**Setup → Compliance → Compliance requirements.** One row per policy: General
Liability at two million naming us as additional insured, Workers' Compensation,
a current trade licence, or a W-9. Each row defines:

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
- **Grace days** and **warn before expiry** — the permitted grace period after a
  lapse and the advance-warning interval before expiry.

Create separate requirement rows when counterparty classes use different limits.
Each enforced limit is stored in one requirement row.

## Daily operations

### Recording a certificate

Open a subcontractor from **Compliance → Subcontractors**, or from the vendor
record, and record the certificate on the Compliance tab: insurer, policy
number, effective and expiry dates, limits, and endorsements. The attached PDF
is stored in the File Cabinet and remains linked to the record.

A certificate is recorded as **pending review** and does not satisfy a
requirement until a different authorized user verifies it. The API enforces this
separation of duties.

Renewals are new records, not edits. Point the new certificate at the one it
renews and the old row is marked superseded, keeping its dates and its
verification trail intact. Evaluation uses the applicable verified record with
the latest coverage date.

### The matrix

**Compliance → Subcontractors** presents one row per tracked subcontractor and
one column per policy. This matrix identifies common or simultaneous coverage
gaps across vendors. Each cell uses the same evaluation as pay-run processing,
so displayed status corresponds to the current payment-control result.

### Exceptions

An authorized **exception** can temporarily override a blocking requirement. It
requires a dedicated permission, a reason, an end date no more than 120 days in
the future, and a permanent audit entry. Revocation is recorded rather than
deleted so the period of suspended enforcement remains auditable.

A suspension longer than 120 days requires a policy change rather than an
exception.

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
it as signed after receiving the executed document. Because a signed waiver can
release a blocked payment, the action requires the signatory name and date,
records the user who attested to receipt, and makes the amount and through-date
immutable.

The printed waiver is a system-generated document containing the configured
operative language and jurisdiction. It is not a government-issued form.
Organizations should obtain legal review of jurisdiction-specific language.

### How coverage is judged

A waiver releases a bill when it is **signed**, for the **same project**, its
through-date **reaches the bill's date**, and its amount **at least matches** the
bill, in the same currency. A waiver explicitly linked to a bill governs that
bill even when a larger unlinked waiver exists. The explicit link takes
precedence over inferred coverage.

## What the control does to payments

When compliance is on, three points evaluate every subcontractor bill:

1. **Pay-run creation** refuses a selection containing a blocked bill. It refuses
   the complete selection rather than omitting blocked bills, so the operator
   receives an explicit failure.
2. **Run readiness** re-evaluates before the file is generated — a run created on
   Monday can be released on Friday, by which time a certificate may have
   lapsed.
3. **Posting the run** evaluates once more and blocks the individual instruction,
   so one blocked instruction does not prevent unrelated payments.

A **block the bill** requirement rejects posting in the transaction kernel, so
imports, scripts, and API routes cannot bypass it. Historical
migration posts are exempt — old books are reproduced as they were, not
re-adjudicated.

Each evaluation records the applicable policy, evidence, and decision. The
resulting snapshot prevents later policy changes from altering an earlier
release decision.

## Information returns

**Compliance → Information returns** prepares 1099-NEC, 1099-MISC and T4A.

Open a filing for a completed calendar year and compute it. The figure is
**cash paid**, not billed: every posted vendor payment in the year is traced
through its applications to the bills it settled, through those bills to their
expense lines, and through each line's account to a box. A payment without an
application, such as a retainer or advance, is assigned to the recipient's
default box because it remains a reportable cash payment.

For each recipient, allocated box amounts reconcile to the corresponding cash
payments without a rounding residual.

### Mapping accounts to boxes

Statutory box definitions are fixed; account-to-box mappings are configured in
**Setup → Compliance → Information return boxes**. Unmapped activity falls to
the vendor's default box, so an organisation that reports all subcontract cost as
nonemployee compensation configures nothing at all. Unmapped spend is reported as
an exception rather than absorbed silently.

### Readiness queue

Resolve the following readiness items before filing preparation:

- reportable vendors with **no taxpayer identification number** on file;
- reportable vendors with **no form assigned**;
- vendors **paid over the threshold but not flagged** as reportable;
- **corporations flagged as reportable**, which are generally outside 1099
  reporting except for attorney gross proceeds and medical payments;
- vendors flagged for **backup withholding** with no withholding amount.

Taxpayer identification numbers are sealed at rest. Only the last four digits are
ever displayed, and the full number never appears in the audit trail or in the
transmittal export.

### Reviewing and filing

The worksheet shows the computed figure and any deliberate adjustment side by
side. Adjustments are stored as **signed deltas** against the ledger figure and
require a reason, so the trace back to the books is never overwritten;
recomputing preserves them, along with any excluded recipient.

**Finalize** freezes the filing and snapshots the payer identification that will
be transmitted. It refuses to freeze a filing that still has a recipient with no
identification number — collect the W-9 or exclude them first. Afterwards the
filing is read-only: corrections go on a new corrected filing.

Recipient copies print as a substitute Copy B, clearly marked not for filing.
The transmittal export is the file your filing channel or agent consumes.

## Permissions

Five permissions separate the relevant duties:

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
