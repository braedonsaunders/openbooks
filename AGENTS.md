# Repository Engineering Standards

## Financial-institution-grade ERP standard

All product, domain, data-model, code, API, UI, security, workflow, and architecture decisions in this repository must meet financial-institution-grade enterprise ERP standards. Prefer financial integrity, explicit controls, auditability, deterministic behavior, and long-term operability over implementation convenience.

At minimum, designs and implementations must preserve:

- strict organization and legal-entity isolation;
- balanced, deterministic, idempotent accounting and posting behavior;
- immutable posted history, with corrections performed through controlled reversals or adjusting entries;
- complete audit evidence for material configuration and transactional changes, including actor, timestamp, before/after state, and reason where appropriate;
- explicit lifecycle states, transition rules, approvals, permissions, segregation of duties, and safe concurrency controls;
- effective-dated configuration where changing a rule could otherwise reinterpret historical transactions;
- precise decimal and currency handling with no floating-point financial arithmetic;
- enforced invariants and feature dependencies at the domain/service and API boundaries, not only by hiding UI;
- backward-compatible migrations, preserved tenant data, and reversible operational rollout plans;
- clear ownership and a single source of truth for every financial policy and configuration value.

Do not introduce silent financial fallbacks, ambiguous overlapping configuration, UI-only enforcement, destructive feature toggles, or parallel sources of truth.

## A refusal that is computed must be raised

This repository's most common defect is not a wrong answer. It is a CORRECT
answer that never reaches anyone. The code detects the problem, composes an
accurate message naming the remedy, and then the refusal is dropped on the way
out — so the operator sees success, or silence, or an error about something
else entirely. Six instances were found in six unrelated subsystems in a single
night:

- a partially-refused pay run committed and posted anyway;
- an unconfigured SUI rate accrued 0.00 instead of refusing by name;
- a mis-scoped statutory rate saved, reported `{ok}`, and resolved to `null`,
  so the engine priced the levy as unconfigured forever;
- one country's payroll component silently absorbed another's via
  `on conflict do nothing`, and each remap erased the other's;
- a New York certificate could be filed against a California employee, so the
  employee withheld by the wrong state's table;
- a delete refusal was delivered as a 500 and the client called `res.json()`
  before checking `res.ok`, so the operator read a JSON parse error and no
  human has ever seen the message.

The rules that follow are not style. Each one is a place a refusal was lost.

- **A write that matches zero rows is a failure, not a success.** Check the
  affected row count and throw. Under RLS an unscoped `UPDATE`/`DELETE`
  silently matches nothing and reports success — the most dangerous shape here.
- **Never report `{ok}` for work whose effect no read can observe.** If a save
  stores a row that resolution cannot find, the save was not a save.
- **`on conflict do nothing` must be justified in a comment or not used.** It
  is the quietest way to drop a write. Say why a conflict is expected and
  benign, or handle it.
- **Fail closed on unconfigured inputs that are always owed.** Prefer refusing
  by name over accruing zero. Zero is indistinguishable from "correctly nil".
- **Validate against the subject, not only the declaration.** A form scoped to
  a jurisdiction must be checked against the EMPLOYEE's jurisdiction, not only
  against its own metadata.
- **Error bodies are checked before they are parsed.** `if (!res.ok)` first,
  always; `await res.json()` on an error path turns a refusal into a parse
  error.
- **Prose asserting a guarantee is a claim about code.** A comment saying a
  lock prevents X, or a message saying "do X instead", is load-bearing: it is
  the only evidence a reader has that the mechanism exists. Verify it against
  the code, and when the code changes, THE CLAIM IS PART OF THE CHANGE. These
  survive review because a claim about an ABSENT mechanism contradicts nothing
  — there is no code to compare it against, and absence is invisible. That is
  why "review more carefully" does not catch them: the reviewer is checking for
  contradiction, and there is none to find. Confirm the mechanism exists.
- **A refusal must name the remedy, and the remedy must exist.** This is the
  sharpest case of the rule above, because a user ACTS on a remedy: a wrong
  comment misleads the next author, but a wrong remedy makes the operator
  destroy the thing the refusal was protecting, holding the product's own
  instructions. Before writing "do X instead", read the code that does X.

Corresponding test rules, because every one of the above was green somewhere:

- A file reporting ZERO tests is a failure, not a pass. A test double missing
  an export the module imports makes that module fail to LINK, and the runner
  reports no tests rather than a failure.
- A red-proof shows the test FIRES; it does not show the failure MESSAGE is
  usable. The message is the entire product of a failing test — nobody reads a
  passing assertion. A conformance test whose red said `declared by both CA and
  CA` named the country twice and identified neither schedule, and was read as
  success because the red arrived on cue. Corollary: a SYNTHETIC collision
  proves the assertion fires, a REALISTIC one proves the message reads —
  duplicating the same object cannot expose a message that fails to tell two
  objects apart.
- A test double that cannot produce the REFUSAL is not a test of the refusal.
  This is the quiet complement of the rule above: a double missing an export
  fails loudly, but a double that is too PERMISSIVE reports passes. A
  `parseJsonBody` stub taking `(request)` instead of `(request, schema)` and
  returning `{ ok: true }` unconditionally made every boundary test in two
  files hollow — only the two asserting a 400 ever revealed it. Never double a
  PURE function: it has nothing to isolate, so the copy can only drift from
  the original. Mock the database, the clock, the network, authz — not
  validation.
- A guard's own tests must assert the property worth guarding, never the
  guard's current reach. If a guard test would still pass when the guard goes
  blind, it is not testing the guard. A control that reads an ambient
  environment variable must treat UNSET as unknown and fail closed: an apply
  guard keyed on `NODE_ENV !== "production"` proceeds when nothing is set,
  which is precisely the state a hand-run maintenance script is in. Prefer
  deciding from the resource the operator had to name explicitly — the
  database URL — over a process variable they can forget.
- Any commit changing an ALGORITHM or a REFUSAL CONDITION must be grepped for
  tests asserting PROPERTIES of the old behaviour, separately from tests that
  IMPORT the changed code. The import graph will not find them.
- When two changes independently implement the same surface, the loser's tests
  are the spec for what the winner must not drop. Run them against the winner
  before deleting them. The trigger is two implementations of one surface —
  not a git conflict, which is merely the easy case.
- Every green names the TREE it was measured on, by sha, and the PARTITION it
  ran in. A green whose tree no longer exists is not evidence, and a count
  without a partition means nothing here: DB-owned tests skip silently in the
  unit partition. `git reset --hard origin/main` on a ref shared across
  worktrees discards other agents' unpushed commits and deletes their tracked
  files — run `git log --oneline origin/main..main` first and treat a
  non-empty result as someone's work, not debris.

## Engine modules are bounded

`engine/src` is a set of declared modules (one directory each, manifest at
`engine/src/modules.json`, rules in `docs/design/engine-modules.md`). No file
lives at `engine/src` root; a module imports only the modules it declares;
declared-but-unused edges and any growth of the pinned dependency cycles are
refused by `npm run check:engine-boundaries`. Extract internals into the same
module as their source; put a shared constant or type LOWER rather than adding
an upward edge.

## Feature-gate hierarchy

Every organization-level feature gate must live on the single authoritative **Company Settings → Features** switchboard, without exceptions. Module-specific settings pages may display effective feature status and link to the Features page, but must not expose a second switch or persist a parallel gate. The main Projects gate on the Features page is the authoritative parent gate for the entire Projects domain.

Project capabilities such as job costing, project types, project billing, construction-style progress billing, schedules of values, change orders, applications for payment, retainage, labor costing/pricing, project reporting, and Field Tickets are subordinate Projects capabilities. Their gates, where a separate gate exists, must also live on the Features page and must not be independently available when the Projects parent gate is off. Enforce that dependency in the Features UI, navigation, pages, APIs, services/jobs, and configuration writes. Turning a feature off must preserve its data and audit history.

## Reuse-first: never rebuild what the app already has

Every module composes the SAME shared machinery. A new feature that hand-rolls
its own list, report, filter bar, drawer, or settings screen is wrong even if
it works. Before building ANY new user-facing surface, name the existing
exemplar page and copy its composition exactly — "looks similar" is not the
bar; it must BE the same component.

| Need | Use | Exemplar |
| --- | --- | --- |
| Any report | Report engine: `report_definitions` + `packages/reports` entities/built-ins, rendered by `ReportFilterBar` + `ReportPaper`/`PaperView` + `ExportMenu` + `SaveViewButton` | `web/app/(app)/reports/pnl/page.tsx` |
| Any list page | `RecordListView` (documents) or `PagedTable` + list source registry | any documents list |
| Module landing | Module-home cockpit + group-tabs strip (`web/components/module-home/`) | `/purchasing` |
| Record detail popups | `UrlDrawer` / `Drawer` flyouts — never expanded table rows | party/document drawers |
| Org settings | Setup registry (`web/lib/setup/registry.ts`) → `/admin/setup` tabs, or `SetupEntitySection` rehomed onto the module | tax setup |
| Printable record output | PDF template designer (`web/lib/pdf-templates/*` + `packages/pdf`) | invoice PDFs |
| Outbound email | `packages/emails` templates + per-org transport (`engine/src/delivery/email-config.ts`) | record send dialog |
| Menus/prompts | `ContextMenu`/`useContextMenu`, `promptDialog` | existing usages |
| People/companies | The native `parties` model + role views (`/entities/employees` …) — never a parallel roster | entities pages |
| Numbers | `engine/src/money/money.ts` bigint helpers — never floats | everywhere |
| Refusing an unreadable amount | `web/lib/payroll-decimal-refusal.ts` (`decimalNullRefusal`, `decimalNullCause`, `suppliedValue`) — **never a second decimal classifier** | `payroll/profiles`, `payroll/runs/[id]` |

**Why that last row is a rule and not a preference.** `canonicalDecimal` returns
null for SEVEN different reasons — too many decimal places, thousands
separator, decimal comma, ambiguous comma, currency symbol, scientific
notation, genuinely non-numeric — and they need seven different remedies. The
dangerous one: seven of the fourteen payroll packs are decimal-comma locales
(IT, FR, DE, NL, ES, PL, BR), so `12,34` is twelve-thirty-four written
CORRECTLY, and telling that operator to "remove the thousands separator" makes
them enter 1234 — a **100x error in a payroll amount**. `1.234,56` is worse: the
naive advice walks them to 1.2346 for 1234.56, a 1000x error. The rule that
resolves it is "when a dot and a comma both appear, the LAST one is the decimal
point", and a genuinely ambiguous `1,234` must be refused as ambiguous with
both readings named rather than guessed. That logic took three rounds to get
right and is covered by tests. Never strip or coerce a separator to be helpful:
refuse with a precise remedy, because guessing what someone meant is how you
store a number nobody typed.

Corollaries:

- Tabular/analytical output is a **report** in the report engine — first-class
  in the Reports hub with the native filter bar (period picker included),
  never a bespoke screen. Module pages may LINK to it; module-specific UI
  stays in the module.
- Anything reasonably configurable is a Setup-registry setting with an
  editable UI — never hardcoded.
- New UI matches house chrome: `PageHeader`, the group-tab switcher in the
  same position as sibling pages, shared layouts (`ListPageLayout` /
  `DetailPageLayout`), one house-style New button, no duplicate header actions.
- When a shared component almost fits, extend it (new prop/slot) — never fork
  it or approximate it with local markup.

Litmus test before writing code: "Which existing screen already does this kind
of thing, and am I using its exact components?" If you cannot name the
exemplar file, stop and go find it.

