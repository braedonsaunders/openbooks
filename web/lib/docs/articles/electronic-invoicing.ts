import type { DocArticle } from '../types'

export const electronicInvoicing: DocArticle = {
  slug: 'electronic-invoicing',
  title: 'Electronic Invoicing',
  category: 'transactions',
  order: 21,
  summary: 'Enable electronic invoicing, configure sellers and recipients, validate and archive invoice XML or Factur-X PDFs, and review structured supplier invoices.',
  updated: '2026-10-09',
  keywords: ['e-invoice', 'einvoice', 'EN 16931', 'CII', 'UBL', 'XRechnung', 'eRechnung', 'Factur-X', 'ZUGFeRD', 'Peppol', 'PINT', 'NLCIUS', 'EHF', 'Germany', 'Australia', 'New Zealand', 'Singapore', 'XML', 'supplier invoice'],
  related: ['sales-workflow', 'purchasing-workflow', 'tax-configuration', 'setup-billing-group', 'file-cabinet'],
  body: `# Electronic Invoicing

Electronic invoicing prepares a structured invoice from an existing posted
customer invoice or credit. You validate the selected profile, issue the file,
and retain its archived original. Supplier XML and PDFs containing structured
invoice XML enter the existing supplier-invoice review and matching workflow.

## Enable and configure

An administrator enables **Electronic invoicing** in **Company Settings →
Features**. The feature is off by default. Its configuration does not require a
separate country-pack installation: supported standards profiles ship with
OpenBooks.

1. Open [E-invoice seller settings](/admin/setup/einvoice-settings) in **Setup →
   Billing**. Create the settings for the legal entity that issues the invoice.
2. Choose its default profile and enter its fiscal identity, address, electronic
   address and scheme, contact details, and payment instructions as applicable.
3. Open [E-invoice recipients](/admin/setup/einvoice-recipients) to edit the
   existing customer's recipient profile, electronic address and scheme, buyer
   reference, and registration details. Create the customer first if it is new.
4. On the native **Tax Codes** records, set the e-invoice VAT category and its
   effective date. Supply any required exemption reason. In seller settings,
   explicitly configure the category for untaxed lines where applicable.

The seller belongs to the invoicing legal entity; a customer's metadata belongs
to its existing customer role. Missing required fiscal information is a setup
refusal. Complete the named field and validate again.

## Choose a profile

Use the profile required by the recipient. The available profiles include:

| Profile | Output |
| --- | --- |
| EN 16931 | CII or UBL XML |
| XRechnung | CII or UBL XML |
| Factur-X / ZUGFeRD | Invoice PDF with embedded CII XML |
| Peppol BIS Billing | UBL XML |
| NLCIUS and EHF | UBL XML with the selected national profile |
| PINT A-NZ and PINT SG | Australian/New Zealand or Singapore UBL XML |

The profile selector also retains the labelled legacy Peppol A-NZ and Singapore
profiles. Select the version your recipient requires rather than assuming that
two profiles for the same country are interchangeable. Preparing a Peppol file
does not itself transmit it through an access point.

## Validate, issue, and reopen

1. Open a **posted customer invoice or credit** in its native document drawer.
2. Select **E-invoice**, choose the profile, and review the buyer reference.
3. Select **Validate**. Review the findings and resolve fatal refusals before
   issuing. Fiscal amounts come from the posted transaction, not a new editable
   invoice calculation.
4. Select **Issue e-invoice** to create and download the archived original. This
   action requires the native issuance permission in the document's scope.
5. Reopen **E-invoice** to download the original again from the archive list.

The archive retains the exact file bytes, profile, buyer reference, issuance
time, and digest. Issuing the same document/profile again resolves its existing
original. Later configuration or PDF-template changes do not rewrite it.
Correct the financial transaction through the native credit or correction
workflow and issue the resulting document when required.

## Structured supplier invoices

Upload supplier XML or a PDF containing invoice XML through the existing
supplier-invoice intake. Review the extracted document, match the vendor and
other native references, and save through the AP review workflow. Imported
credits remain credits. A refusal or a manual-review requirement must be
resolved before creating the financial document; an attachment is not evidence
that an AP bill has already been posted.

## Validation scope

Validation checks the supported native financial and profile rules. Issuance
also checks the serialized XML against the published syntax schemas. This is
not certification that every external Schematron rule or recipient policy has
been evaluated. Confirm the recipient's acceptance requirements before relying
on the file for delivery.

Factur-X output includes the structured attachment and PDF/A-related metadata
and preflight checks. Full PDF/A conformance requires independent validation of
the completed file. The visible PDF and XML must describe the same transaction.
`,
}
