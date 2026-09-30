# Engine modules

`engine/src` is a set of bounded modules, one directory each, declared in
[`engine/src/modules.json`](../../engine/src/modules.json) and enforced by
`npm run check:engine-boundaries` (`scripts/check-engine-boundaries.mjs`),
which runs ahead of every test partition and every release verification.

## The rules

1. **No file lives at `engine/src` root.** Every source file sits inside a
   module directory, and every directory is a declared module with a
   description and a `dependsOn` list.
2. **A module imports only what it declares.** A non-test file may import
   another module only when its own module lists that module in `dependsOn`.
   The check names the file, the line, both modules and the remedy.
3. **Engine code never imports the web app.** Only engine tests may reach into
   `@/…` (see `engine/tsconfig.json`).
4. **Every declared edge is used.** A declaration nothing relies on is stale or
   a permission granted in advance; both are refused.
5. **The module graph is acyclic.** The last cycle was broken and the
   `cycles` pin retired: the check refuses any cycle, and it
   refuses a non-empty pin, so the pin stays empty.

Tests, and everything under `engine/src/testing/`, are composition and may
import any module.

## Adding a file or a dependency

- Put a new file in the module whose description covers it. If none does, add
  a module: a directory, a manifest entry, and the edges it needs.
- Extract internals into the SAME module as the file they come from. A piece of
  `ledger/posting-commit.ts` stays in `engine/src/ledger/`.
- When a file needs a module it does not declare, first ask whether the shared
  piece belongs lower (a constant or a type that two modules both need usually
  belongs in `records`, `organization`, `money` or `platform`). Only then add
  the edge, and run the check: if it reports a cycle, the edge is refused and
  the piece must move instead.

## Layering

The lowest modules have no engine dependencies at all (`money`, `platform`,
`navigation`, `connectors`, `country-tax-packs`); `records`, `organization`,
`fx`, `banking`, `compliance`, `crm`, `reports`, `apps`, `qbd` and `delivery`
sit directly above them. Subledgers (`inventory`, `assets`, `revenue`,
`projects`, `payroll`, `tax`, `tax-returns`, `billing`, `payments`, …) build on
those, and the tooling modules (`worker`, `harness`, `sim`, `conformance`,
`sample-companies`) sit on top.

The module graph is acyclic. The posting kernel lives below orchestration,
so subledgers can use its financial invariants without importing document
posting orchestration back into their own modules. Guards and durable effects
preserve each operation's transaction ownership. The manifest and boundary
checker are authoritative; a new dependency must preserve this layering.

## Moving files

Relocations are recorded in `scripts/engine-modules/moves.json` (old path to
new path), so a reference written against an older layout can be traced to the
file's current home.

Operation ownership and transaction boundaries are described in
[Financial operation boundaries](financial-operation-boundaries.md).
