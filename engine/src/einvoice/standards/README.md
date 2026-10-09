# Electronic invoice standards

The native invoice model supports CII D16B, UBL 2.1 invoices and credit notes, XRechnung 3.0.2, Factur-X/ZUGFeRD EN 16931 containers, Peppol BIS Billing 3.0, NLCIUS, EHF, and the Australia/New Zealand and Singapore GST specialisations. Profile identifiers, syntax, tax scheme and source edition are declared in `../profiles.ts`.

## Published schema bytes

The CII and UBL files are the unmodified dependency closure from [KoSIT XRechnung validator configuration, 2026-08-31](https://github.com/itplr-kosit/validator-configuration-xrechnung/releases/tag/v2026-08-31). `manifest.json` records the source archive digest and each schema digest. The offline `validateEInvoiceXmlSchema` function checks those digests and runs the existing `xmllint-wasm` dependency with network access disabled.

The CII files retain the UN/CEFACT 2016 copyright and distribution permission in each file. The UBL files retain the OASIS 2013 copyright and distribution permission. Signature-schema dependencies retain their original notices. These schema documents have their own distribution terms; they are not relicensed as OpenBooks code.

The code values in `../standard-codes.ts` were extracted from the [EN 16931 validation artefacts 1.3.16](https://github.com/ConnectingEurope/eInvoicing-EN16931/releases/tag/validation-1.3.16) included in that KoSIT bundle. The source UBL XSLT SHA-256 is `759f2d2e830c7fd1d5a6e8b4f61e5dbafc7a7805862c4ae1c749eeac6adde698`. The source artefacts use EUPL 1.2; its unchanged licence is included in `EUPL-1.2.txt`.

## National editions

- [Peppol BIS Billing 3.0, May 2026](https://docs.peppol.eu/poacc/billing/3.0/) is the common European billing specification, including the Norwegian rules used by EHF.
- [NLCIUS/SI-UBL 2.0.3.13, 2026-05-21](https://github.com/peppolautoriteit-nl/validation/tree/0561da39740b6e753ba3d3dd12b87c3df3bb562f) supplies the Dutch rules. The implementation uses the published seller-country conditions and distinguishes NLCIUS from the Dutch rules for Peppol BIS.
- [PINT A-NZ Billing 1.1.3, 2026-05-21](https://docs.peppol.eu/poac/aunz/pint-aunz/) uses GST, AU ABN/NZ NZBN registration schemes, and specification identifier `urn:peppol:pint:billing-1@aunz-1`.
- [PINT Singapore Billing 1.4.1, 2026-05-25](https://docs.peppol.eu/poac/sg/pint-sg/) uses Singapore GST categories, a UUID for registered supplies, and accounting-currency GST and inclusive/exclusive SGD amounts when required. These amounts come from posted native accounting figures.

`national-manifest.json` pins the reviewed national resource archive digests and relevant Schematron/code-list file digests. These national rule artefacts are reference material for the native rule implementation; they are not executed by `xmllint-wasm`, which validates XSD rather than XSLT 2.0 Schematron.

`peppol-aunz` and `peppol-sg` retain the historical BIS 3.0 specification identifiers for compatibility. They are explicitly labeled as legacy and produce a version advisory. The current PINT identifiers are separate profiles. Receiver capability and acceptance of historical specifications remain part of the transport configuration.

## Validation boundaries

Native model validation enforces supported terms, exact arithmetic, mandatory references, tax categories and national configuration. XML issuance validates the actual serialized bytes against the published syntax schemas. XSD validity alone is not a claim that every published Schematron rule or every receiver policy has been evaluated. Full release conformance can be verified separately with the [KoSIT validator](https://github.com/itplr-kosit/validator) and the pinned national Schematron artefacts.

Factur-X embedding inserts the attachment, associated-file relationship, XMP extension schema, output intent and identifiers. Its preflight refuses known prohibited actions, encryption and unembedded font programs. Transparency is permitted in PDF/A-3. Full visual PDF/A-3b conformance requires validation of the completed file with [veraPDF](https://site.verapdf.org/cli/validation/); adding metadata is not a PDF/A certification. The visual invoice and XML must describe the same transaction.

Inbound XML refuses DTDs and custom entities, resolves namespace identity before reading fields, limits nesting and size, preserves exact prices and quantities, and reconciles totals before accounting mapping. Inbound PDFs are size-limited, attachments are decoded with a bounded read, and multiple competing invoice attachments are refused.

The embedded ICC profile is the International Color Consortium `sRGB2014` profile, revised February 2015. It retains the ICC copyright tag. Its SHA-256 is `384b832de3412066743b52a75ee906b6fb9fb8d9e09e936fc2c43223815c6e0a`; source and redistribution terms are available from the [ICC sRGB profiles](https://registry.color.org/rgb-registry/srgbprofiles) and [ICC profile-library licensing](https://registry.color.org/profile-library/) pages.
