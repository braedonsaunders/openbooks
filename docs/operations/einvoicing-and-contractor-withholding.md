# Electronic invoicing and contractor withholding

These capabilities ship with OpenBooks. Upgrade the application using the
[upgrade runbook](upgrades.md), including the native database migration runner,
before configuring them. Both features are disabled by default. An administrator
enables them in **Company Settings → Features**; each legal entity's operational
configuration belongs in Setup.

## Electronic invoicing

1. Enable **Electronic invoicing**.
2. Open **Setup → Billing → E-invoice seller settings**
   (`/admin/setup/einvoice-settings`). Select the invoicing legal entity, default
   profile, fiscal identity, address, contact and payment instructions.
3. Open **E-invoice recipients** (`/admin/setup/einvoice-recipients`) to configure
   existing customers' recipient addresses, profiles and buyer references.
4. Set the electronic-invoice VAT category and effective date on the native tax
   codes. Configure an explicit category for untaxed lines where applicable.
5. Open a posted customer invoice or credit. Use **E-invoice**, select its profile
   and buyer reference, validate, then issue and download the archived original.

Profiles are built-in standards definitions rather than separately installed
country packs. They include EN 16931 CII and UBL, XRechnung, Factur-X / ZUGFeRD,
Peppol BIS, NL CIUS, EHF and the Australian/New Zealand and Singapore PINT
profiles. Select the profile required by the recipient. Issuance preserves the
original bytes and digest; later configuration changes do not rewrite them.

Upload a supplier XML or a PDF containing structured invoice XML through the
existing supplier-invoice review workflow. Review and match it before creating
the native AP document.

Validation checks the supported native rules and published XML syntax schemas.
It does not certify every receiver's rules or full PDF/A conformance. See the
[standards scope](../../engine/src/einvoice/standards/README.md).

## Contractor withholding

The existing country tax-pack registry supplies these schemes:

| Country | Scheme |
| --- | --- |
| United Kingdom | Construction Industry Scheme (CIS) |
| Germany | Construction withholding under §48 EStG |
| Ireland | Relevant Contracts Tax (RCT) |
| Italy | Condominium contractor withholding |
| United States | Backup withholding |

Installing a country tax pack does not automatically activate payment deductions.

1. Enable **Contractor withholding**.
2. Open **Setup → Taxes → Enrollments**
   (`/admin/setup/withholding-enrollments`). Select the legal entity and scheme;
   supply the registration reference, liability account, effective date and
   authority vendor. Complete the scheme's required threshold, filing or
   remittance policy and supporting calendar or lookback evidence.
3. Record each applicable vendor's verification, rate band or exemption in
   **Subcontractor standings** (`/admin/setup/withholding-standings`). US backup
   withholding uses the existing vendor's backup-withholding flag. Irish RCT
   also requires the authority's authorization reference and amount for the
   individual payment.
4. Save the native vendor payment to compute its deductions. UK CIS materials
   exclusions require direct materials cost; a selling price is not that cost.
5. Open **Contractor withholding** (`/contractor-withholding`). Select the
   enrollment and use the Periods, Deposits or Subcontractor standings tabs.
   Prepare and review the applicable workpaper, record the authority filing
   reference where required, and create its native authority bill or correction.

Government submissions and verification references are recorded from the
authority; these workflows do not themselves submit returns or register vendors
with the government. Posted documents retain their original policy and source
evidence. Use the supported correction and reversal actions when facts change.
