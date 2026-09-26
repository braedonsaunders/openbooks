# Migrations: table-driven module registries

Module-owned lists live in registry tables, never in function bodies: `openbooks_query_catalog_relations` (relation, added_in) is the single source of truth for the governed query set consumed by `openbooks_refresh_query_catalog()`, and `openbooks_document_close_modules` (kind, close_module, added_in) is the storage mirror of `DOCUMENT_CLOSE_MODULES` read by `document_close_module()`. A schema pack that adds a governed relation or a document kind registers a row and refreshes, and never redefines either function — redefinitions replay in ordinal order, so the last one would silently drop every earlier module's rows. The close-module vocabulary is ar/ap/banking/assets/tax/gl.

```sql
insert into openbooks_query_catalog_relations (relation, added_in) values (...) on conflict (relation) do nothing -- expected on replay; the seed is idempotent
select openbooks_refresh_query_catalog();
insert into openbooks_document_close_modules (kind, close_module, added_in) values (...) on conflict (kind) do nothing -- expected on replay; the seed is idempotent
```

A pack that adds a document kind also adds the kind to `DOCUMENT_CLOSE_MODULES` in the same change. Turning a feature off preserves its registry rows and audit history.
