import type { DocArticle } from '../types'

export const contractorWithholding: DocArticle = {
  slug: 'contractor-withholding',
  title: 'Contractor Withholding',
  category: 'administration',
  order: 4,
  summary: 'Activate a country withholding scheme for a legal entity, record vendor standings, calculate payment deductions, and prepare authority payments and corrections.',
  updated: '2026-10-09',
  keywords: ['withholding', 'country pack', 'CIS', 'Construction Industry Scheme', 'United Kingdom', 'UK', 'Germany', 'Bauabzugsteuer', '§48', 'exemption certificate', 'Freistellungsbescheinigung', 'Ireland', 'RCT', 'Relevant Contracts Tax', 'Italy', 'condominium', 'United States', 'backup withholding', 'Form 945', 'materials cost', 'remittance', 'deposit', 'foreign currency'],
  related: ['tax-configuration', 'setup-taxes-group', 'payments-and-applications', 'purchasing-workflow', 'subcontractor-compliance', 'audit-log'],
  body: `# Contractor Withholding

Contractor withholding deducts statutory amounts from applicable vendor
payments, records the liability, and prepares working papers and authority
payments. It uses the native vendor, bill, payment, and accounting workflows.
Enable **Contractor withholding** in **Company Settings → Features**.

## Country schemes and activation

The existing country tax-pack registry supplies these built-in definitions:

| Country | Scheme |
| --- | --- |
| United Kingdom | Construction Industry Scheme (CIS) |
| Germany | Construction withholding under §48 EStG |
| Ireland | Relevant Contracts Tax (RCT) |
| Italy | Condominium contractor withholding |
| United States | Backup withholding |

Installing a country tax pack does not automatically activate deductions. An
effective-dated **enrollment** selects the scheme for a particular paying legal
entity. Contractor withholding has its own company feature switch and can be
used independently of Projects.

## Set up the paying entity

1. Open [Enrollments](/admin/setup/withholding-enrollments) under **Setup → Taxes**.
2. Select the legal entity and scheme. Enter its registration reference,
   withholding liability account, and effective start date.
3. Select the authority vendor that will receive the remittance, where required.
4. Complete the scheme's applicable filing frequency, threshold basis, payer
   scope, and remittance schedule. Italian condominium withholding is scoped to
   a condominium payer.
5. Where required, record the supporting remittance calendar, coverage dates,
   authority source reference, lookback liability, and other statutory evidence.

Required policy evidence cannot be replaced by a guessed zero or a company
holiday calendar. A refusal identifies the missing policy or evidence so that
an authorized setup user can complete it.

## Record vendor verification

Use [Subcontractor standings](/admin/setup/withholding-standings) to select the
vendor, paying legal entity, scheme, rate band, and validity dates. Supply the
verification reference and payee information required by that scheme. German
exemption certificates require a finite expiry date. Record a new standing when
verification changes; revoke an obsolete standing with a reason.

US backup withholding uses the existing vendor's **Backup withholding** flag
as its subject determination. Do not create a second standing to override that
flag. Irish RCT also requires the authority's authorization reference and exact
authorized statutory-currency amount for the individual payment.

## Bills and payments

For UK CIS, enter the bill line's withholding treatment and **direct materials
cost**. The materials selling price is not the subcontractor's direct cost;
markup remains subject to the scheme's calculation. VAT and materials treatment
come from the native bill evidence.

Create or edit the native vendor payment and save it to recompute the deduction.
Review the last saved amounts before posting. Payment and reporting currencies
may differ: the payment retains its actual cash and deduction amounts, while the
statutory deduction retains the reporting currency and frozen conversion quote.
Missing required conversion evidence refuses rather than silently inventing a
rate. The payment must use the bill's currency; statutory reporting uses its
separate conversion evidence.

Posting records the cash, discount where applicable, and withholding liability
together. Posted payment evidence is immutable. Use the native reversal or
correction workflow to change a posted financial result.

## Working papers, filings, and authority payments

Open [Contractor withholding](/contractor-withholding) and select an enrollment.
Its peer tabs replace the active body:

- **Periods** shows the applicable period and latest working paper or return.
  Prepare a closed period, review its payees and payment evidence, and download
  CSV or PDF output. Record the authority filing reference where required;
  financial working papers use the supported review action.
- **Deposits** appears for schemes with a deposit schedule. Choose the deductions
  through date and prepare the authority document.
- **Subcontractor standings** shows the vendor verification records.

The service generates a native AP bill, AP credit, or journal according to the
amount and accounting correction required. Open that document to review and post
it through the native workflow, then settle an authority bill using the normal
vendor-payment workflow. Preparing a document does not itself post or pay it.
A journal requires journal access; ask an authorized reviewer to open it if your
role does not have that permission.

These workflows record government references and filing outcomes. They do not
register vendors with the government or submit the return to the authority.

## Changed source evidence and corrections

A filed return retains its original lines, totals, and source evidence. If a
source payment changes through a governed reversal or correction, prepare the
supported revision and review what changed. A source-only correction retains
the existing authority filing reference and requires explicit review.

For a posted deposit whose source has changed, use **Correct deposit** on the Deposits
tab. The new authority document accounts for the prior posted settlement so that
the original liability is not paid twice. A nominally zero correction can still
require a journal to clear its original carrying value and currency exposure.

Generated authority documents preserve their financial source. Do not alter
their monetary lines to force a different deduction. Use the supported
correction or reversal action; if required configuration is missing, complete
the named Setup remedy and retry.
`,
}
