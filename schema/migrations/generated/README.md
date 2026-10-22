# Forward migrations

Installations apply the active release baseline named in
`../baseline.json`, then every migration in this directory in ordinal
order. Name each file `NNNN_snake_case.sql` with the next free four-digit
ordinal, carry the standard session header (`scripts/check-migration-headers.mjs`)
and add exactly one preflight decision in `../preflight/`
(`scripts/check-migration-preflights.mjs`). Published migrations are
immutable; correct them with a later migration.

A release cut folds these migrations into a new baseline and retires them;
see `docs/operations/migration-baseline-cutover.md`.
