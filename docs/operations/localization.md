# Localization scope and adoption

A country pack is a set of declared capabilities. Its presence does not certify
all employers, regions, tax years, filing formats, or agency submission paths.
Tax workpapers, payroll calculations, electronic file generation, and successful
submission are separate claims.

## Inspect the exact implementation

Run from the repository root after `npm ci`:

```bash
node --import tsx scripts/localization-support-scope.ts > localization-support.json
```

The inventory identifies the full source commit and whether the workspace has
uncommitted changes. It derives countries, statutory currencies, published and
draft table years, regional income-tax coverage, statutory components,
effective-dated remittance schedules and their citations, original filing
exports, and correction exports directly from the engine declarations. The indirect-tax inventory adds pack versions, declared completeness limitations,
jurisdictional effective-rate schedules, return definitions and submission-channel
metadata. A submission-channel declaration does not prove that its transport or
certified government format is implemented. The inventory does
not persist a second feature flag or a second statutory rate table. A published
table year describes calculation tables; it does not establish that every
filing builder supports that year or has been accepted by an agency.

For each intended legal employer and pay date:

1. Confirm the statutory currency, region and tax-year basis. Draft or absent
   tables are not a valid substitute for a published edition.
2. Configure required employer facts, employee certificates, statutory rates,
   control accounts, filing identities and remittance destinations through Setup.
3. Run payroll readiness and review every named refusal. An installable pack may
   still be unable to calculate if a required input has no supported producer.
4. Compare representative calculations with the applicable agency publication,
   including caps, bonuses, retroactive payments, regional and employer levies.
5. Check the exact original and correction export. A population or printable
   workpaper is not an electronic filing file. Keep the agency validation and
   acceptance receipts with the employer's filing evidence.
6. Recheck editions and schedules when crossing effective-date boundaries;
   validate the next tax year before its first run.

The implementation inventory currently covers AU, BR, CA, DE, ES, FR, GB, IE,
IT, JP, NL, PL, SG and US. Query it for actual loaded years and regional refusals;
country counts are not a coverage guarantee. Statutory holiday formulas and
remittance frequencies are supported only where declared. Additional obligations
remain candidates for complete native implementation, rather than permanent
exclusions from the product.

## Indirect tax and workpapers

Inspect `engine/src/country-tax-packs` and the tax setup/filing surfaces for the
applicable return and period. Verify source journals, jurisdiction, tax codes,
filing identity, currency, control-account reconciliation, return mappings,
adjustments and the actual export format. A generic workpaper does not establish
statutory submission support. Never reuse another country's filing or an older
year's rates to bypass a refusal.

## Evidence and limits

The conformance corpus verifies its named scenarios and assertions. Passing
scenarios do not prove every statutory edge case, and a source citation is not
an independent audit. The complete trust bundle identifies its source commit,
execution partitions and component digests; historical checked-in artifacts
must be read using their own provenance. OpenBooks does not claim agency
certification or universal tax/payroll compliance.
