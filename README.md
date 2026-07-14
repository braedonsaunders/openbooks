# openbooks

**The open business suite. Run on open books.**

Open-source, NetSuite-class ERP: double-entry general ledger kernel with
dimensions, subledgers (AR/AP/inventory), multi-entity, multi-currency,
period close, and an ad-hoc reporting engine — built on Next.js / React /
Drizzle / Postgres.

## Status

Pre-alpha. Current phase: extracting and redesigning the schema from a live
NetSuite instance (records catalog, COA, transaction shapes, saved searches)
into a clean, world-class data model.

## Structure

- `extraction/` — raw NetSuite metadata dumps (SDF objects, records catalog, SuiteQL schema probes)
- `schema/` — the redesigned openbooks schema (Drizzle + design docs)
