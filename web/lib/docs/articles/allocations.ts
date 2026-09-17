import type { DocArticle } from '../types'

export const allocations: DocArticle = {
  slug: 'allocations',
  title: 'Cost Allocations',
  category: 'accounting',
  order: 6,
  summary:
    'Distribute pooled costs to targets on a driver with one rule model bound at three moments: splits at entry, contributions at posting, and scheduled period sweeps.',
  updated: '2026-09-16',
  keywords: ['allocation', 'apportion', 'driver', 'distribution', 'sweep', 'reclass', 'lineage', 'period run', 'residual'],
  related: ['overhead-costing', 'fixed-assets-depreciation', 'scripting-engine', 'period-close'],
  body: `# Cost Allocations

Cost allocations move pooled amounts — rent sitting in an Overhead
department, monthly IT spend, shared services — onto the departments,
projects, locations, classes, or accounts that consumed them. OpenBooks
expresses every allocation as ONE rule model bound at three moments:

| Moment | When the rule fires | What it produces |
|---|---|---|
| **At entry** | When a document line is saved | The line is replaced by a group of child document lines |
| **At posting** | Inside posting, on the transaction's own journal entry | Extra journal lines stamped with the contributing rule |
| **Period sweep** | On demand, on schedule, or from a close step | A run row plus its own allocation journal entry |

Anything that already allocates stays where it is: revenue recognition,
depreciation, leases, landed cost, and labor distribution are untouched.
What follows describes exactly how the kernel behaves, so a controller can
predict the ledger before anything posts.

## Guided setup

New rule on Setup → Allocations opens the house wizard (the same stepper as
payroll onboarding): when it fires, which lines it catches (transaction type
plus any matcher dimension — department, location, class, project, subsidiary,
party, item, or a custom segment), how the amount splits, where the money
goes, and what the books should do. A **1 : 2 : 3 : 4**
ratio is a first-class answer — the wizard stores it as percents that sum to
100 so entry, posting, and period sweeps all run. Drivers stay a separate
registry; pick one on the split step only when the weights should change each
period. After create, the rule drawer still has every advanced field.

## Rules and versions

A rule has a stable key, a name, one of the three moments above, a sort
order, and an active flag. The model also reserves engine-owned system
rules for allocations the engine itself must always apply: they cannot be
deleted, and only their activity flag and ordering can change.

The definition lives in versions. A version moves **draft** (editable) to
**published** (frozen) to **retired**, and only one published version is
current at a time. Publishing stamps a definition hash over the version
plus its targets; that hash is copied onto every run and lineage row, so a
posted allocation is always explainable by the exact definition that
produced it. Two published versions of one rule can never cover
overlapping effective windows — publishing into an occupied window is
refused — and anything that edits a published version or its targets is
refused as frozen. To change a live rule, draft a new version from the
current one, set its effective window, and publish it; history keeps the
old definition untouched.

Other version settings you will meet everywhere below: which books the
rule may touch, the memo and line-description templates
(**{{rule.name}}**, **{{period.name}}**, **{{target.label}}**), and the
scheduling fields for period sweeps.

## Applicability: which lines a rule considers

Entry and posting rules select lines with the same matcher, and period
rules use the same fields as their source filter:

- **Document kinds** — an optional list; empty means every kind.
- **Account scope** — any account, a chosen list of accounts, or an
  account group (a named pool such as the overhead accounts).
- **Dimension filters** — departments, locations, classes, projects,
  subsidiaries, parties, items, and custom segments. Every filter you set
  must match (AND); a filter you leave empty matches anything. The
  **untagged** option matches only lines with NO value in that dimension,
  which is how a sweep collects the classic untagged pool.
- **Apply policy** (entry moment) — **automatic** explodes the line on
  save, **suggest** offers a chip in the line grid that applies the split
  on click, and **manual** only appears in the line's distribution picker.

When several rules match one line, the most specific rule wins: the one
with the most matching filters, then the lower sort order, then the rule
key. The choice is deterministic across locales and sessions.

## Bases and the driver registry

A rule splits its amount by **fixed percent**, by a **driver**, or by
**stepped** tiers. Fixed percent and driver run at every binding moment;
stepped tiers are stored on the version but entry explosion, posting
contributions, and period sweeps all decline them, so publish a rule on
one of the two working bases.

A driver is a named measure in the driver registry: a key, a unit, one
dimension (department, location, class, project, subsidiary, or a custom
segment), a source kind, and configuration. Six source kinds exist:

| Source kind | Configuration | Measured from |
|---|---|---|
| **statistical journal** | unit, optional accounts | quantity totals grouped by the dimension, in the period |
| **GL activity** | account scope | signed posted activity per dimension value, in the period |
| **GL balance** | account scope | period-end balance per dimension value |
| **native measure** | headcount, labor hours, billed hours, labor cost, revenue, direct cost, or rentable area | people records, approved time only, posted GL, or active property units |
| **manual** | none | the effective-dated values table for the as-of date |
| **report definition** | report, dimension column, value column | a saved report run with the period injected |

Native measures only fit some dimensions and say so loudly: headcount is
department only, labor and billed hours are department or project,
rentable area is location only. A measure that cannot honestly be computed
fails instead of returning silent zeros. Manual values are effective-dated
rows per dimension value, and the Drivers tab previews the exact vector a
run would apportion on.

A **report definition** driver runs the saved report under the identity of
the actor triggering the run, so the report engine's permission checks
stay authoritative. The actor
needs the reports read permission plus whatever the report's own entity
demands, the entity's feature must be on, and the definition must be an
entity query: statement, custom-record, and mixed-denomination measures
are refused rather than blended.

Drivers are read as of the **period**, the **document date**, or the
**prior period**, per the version. Dynamic targets always need a driver
basis.

## Targets

**Explicit** targets list each destination: an optional target account
(empty keeps the source account), any dimension values (empty inherits
the source line's), a fixed percent or a manual weight, and a label.
Fixed percents must each sit inside 0 to 100 and total exactly 100
unless one target takes the **remainder**; at most one target may take it,
and a remainder target cannot mix with manual weights. Percent grids and
manual-weight grids cannot mix on one version either — ambiguous grids
fail closed instead of under-allocating or dropping money.

**Dynamic** targets name a dimension plus optional include and exclude
lists, a minimum weight, and an optional target account. At run time the
target set becomes every active value of that dimension whose driver
weight clears the minimum. Dynamic targets cover department, location,
class, project, and subsidiary.

Targets with no positive weight anywhere fail the run instead of
inventing attribution, and a zero-weight target at posting writes no
zero-amount line.

## Impacts: what the split writes

- **Reclass** moves the cost: credit the source coordinate (or the
  configured offset account, such as a clearing account) and debit each
  target. The trial balance total never moves.
- **Net-zero pair** keeps the cost where it is and adds dimensional
  attribution: debit each target coordinate and credit the same account at
  the source coordinate. No account total can move — targets must use the
  source account, and anything else is refused at publish and again at
  posting. Company profit and loss never changes; this is the doctrine
  behind statistical allocations.
- **Report only** writes no journal lines at all, only lineage rows that
  reports read.

## Residuals: no lost cent

Money splits are exact integer arithmetic, so a split that does not divide
evenly leaves a residual of a few units. The version names where it goes:
**largest share**, **first target**, **last target**, or an **explicit
target**. The placement is deterministic for the same inputs, recorded per
target in the run and in lineage, and the parts always sum exactly to the
source — nothing is dropped and nothing is invented.

## At entry: splits on the document

An automatic entry rule explodes a matching saved line into child lines
that share one distribution group: amounts are apportioned, quantities are
split proportionally when the line carries one, and item, description, tax
code, party, and billing flags are inherited with the target account and
dimensions overridden. A line may also name a rule explicitly with its
distribution key — unknown, inactive, or wrong-moment keys are refused —
and imports carry the same key.

Editing a child by hand locks its group: later amount changes no longer
re-explode locked groups. Unlocked groups whose total changed regenerate
from the group total; unchanged groups are kept as-is. **Un-split**
collapses a group back into one line at the first child's coordinates. A
misconfigured automatic rule never breaks the save — the line simply stays
whole.

## At posting: contributions on the entry

A posting rule fires inside posting after the kernel lines are built and
before subsidiaries are applied, for postings whose date falls in the
version window and whose book the version covers. Each kernel line is
matched independently and the most specific rule wins that line; lines
with no match and zero-amount lines contribute nothing.

Each contributor's line set must balance per subsidiary on its own, and
the check runs before its lines join the kernel union — an unbalanced set
refuses the whole posting with no partial write. Kernel lines are never
mutated. Rules scoped beyond the primary book write their legs as a
separate allocation entry in that book inside the same transaction.
Reversing a document mirrors contributed lines through the normal reversal
path. Migration replay and suppressed automation never contribute, and
posting rules fire only while both the allocations switch and the
at-posting switch are on.

The journal view groups entry lines by contributor — standard lines first
and locked, then one group per rule and per script — so authorship is
visible where the entry is read.

## Period runs: preview, post, reverse, re-run

A period sweep runs one rule over one period and one book. **Preview**
computes only: it reads the pool (excluding lines the same rule already
produced, which is what makes re-runs idempotent), resolves the driver
vector, apportions per source coordinate so multi-account pools stay
exact, and stores the full computation — sources, driver vector,
per-target weight, share, amount, and residual, journal lines — with a
fingerprint hash. Preview never writes the general ledger.

**Post** writes the stored computation and never recomputes: the
allocation journal is dated at period end, numbered from the rule key and
period, and stamped with one lineage row per line. Posting needs a reason,
refuses a closed period exactly like depreciation does, and there is at
most one posted run per rule, period, book, and subsidiary — a second post
is refused. Report-only versions post lineage only.

**Reverse** mirrors the stored lines (never recomputed) with a reason of
at least five characters, and refuses a closed period. Reversing a
report-only run negates its statistical rows so attribution nets to zero
in reports.

**Re-run** recomputes and compares fingerprints: identical input returns
the existing run and posts nothing new; changed input reverses (or
supersedes, when the old run never posted) and posts the fresh run, linked
both ways. Every transition is audit-logged with actor and reason.

## Lineage and explain

Every allocated line traces to its source: mode, rule, frozen version,
definition hash, run or document, journal line, source line, driver and
its value and total, share, amount, and residual. The explain endpoint
answers from exactly one anchor — a run, a journal entry, or a document —
and the Runs tab drills from a run into its sources, vector, targets, and
journal. The Reports hub carries built-in Allocation summary and
Allocation lineage reports over the same rows.

## Scripts: the custom lines trigger

Tenant scripts with the custom lines trigger add extra balanced lines to
a document's own journal entry after the rule contributions. Each active
script for the document kind runs in sort order with a read-only view of
the document, its lines, and the kernel lines including rule
contributions; its main function returns a lines array or nothing. The
host validates every line: at most 200 per script, nonzero amounts with at
most four decimals, an account id or code that resolves to an active
non-summary account in this organization, organization-owned dimensions, a
memo of at most 500 characters, and — per subsidiary, defaulting to the
document's — a set that balances to zero. A non-primary book pin is
refused rather than silently posted to the primary book.

Scripts run deterministically — no clock, no randomness — with the
standard lines locked out of reach and direct journal writes unavailable.
The posting caller needs the posting permission re-resolved live, both the
scripts switch and the at-posting switch must be on, every run is recorded
as script evidence, and the first refusal halts posting before the posting
transaction opens, so a refused script leaves no partial write.

## Scheduling and close automation

Period rules carry a run policy. **Manual** runs only on demand.
**Auto preview** computes a previewed run once the period has been over
for the configured offset days. **Auto post** additionally posts it. The
scheduler enqueues one outbox row per due occurrence — every published,
active, non-manual version, every ended period in its window, every book
in its scope — unless a previewed, approval-waiting, or posted run already
covers that occurrence, and each enqueue is idempotent per occurrence key.
Organizations with the allocations switch off are skipped outright, and a
rule that went away skips quietly instead of retrying forever. The version
records which approval flow governs it, and the approval permission is
held by the Controller role.

Close automation adds a run allocation action: name every rule or all
active period rules in rule order, and choose preview or preview-plus-post
for the close run's own period and book. Each rule commits under its own
stage checkpoint, so a crash mid-fan-out resumes with finished rules
skipped instead of re-fired.

## Features and permissions

| Switch | Default | Effect |
|---|---|---|
| **Allocations** | Off | Master switch on the Features switchboard; off hides every binding moment and the setup pages, and keeps all data |
| **Allocations at entry** | On, under Allocations | Entry explosion, suggestions, and the distribution picker |
| **Allocations at posting** | On, under Allocations | Rule contributions and the custom lines trigger |
| **Scripts** | Per organization | Second half of the custom lines gate |

Turning Allocations off is never blocked: the Features page counts the
active rules and open previewed runs that go dark so the operator can see
the impact first.

Four permissions scope the work: allocations read, allocations manage,
allocations run, and allocations approve. The Controller role holds all
four; the Accountant role holds read, manage, and run. Listing and
explaining need read; configuring rules, drivers, and versions needs
manage; previewing, posting, reversing, and re-running need run — and
posting a run additionally needs the general-ledger posting permission.
Subsidiary-restricted callers only see runs inside their scope, and every
route answers as missing when the master switch is off.

## Worked examples

An Overhead-department bill auto-split 60, 30, 10. An entry rule matches
vendor-bill lines coded to the Overhead department and carries three
explicit targets — Engineering 60 percent, Sales 30 percent, Support 10
percent — on a fixed-percent basis with the residual to the largest share.
Saving a 1,000.00 bill line explodes it into three children at the three
departments for 600.00, 300.00, and 100.00. If the bill is really
1,000.01, the extra cent lands on Engineering and lineage says so. A hand
edit to any child locks the group against later re-explosion.

A monthly IT cost sweep by headcount. A period rule filters the source to
the IT service accounts with no department tag, uses a native headcount
driver as of the period, dynamic department targets, and a reclass impact.
Each month-end preview reads the untagged pool, resolves headcount per
department, and apportions; posting writes one allocation journal that
moves each share onto its department while the trial balance total holds.
Next month the same rule re-resolves headcount, so growth moves cost
without touching the definition.

A script that adds a statistical pair. A custom lines script for vendor
bills reads the kernel lines, totals the facilities tags, and returns two
balanced lines — debit the facilities-attribution coordinate, credit the
same account untagged — each tagged by department. The host checks the
pair balances per subsidiary, stamps both lines with the script as
contributor, and shows them in their own group in the journal view while
the standard lines stay locked.

## Limits worth knowing

Fixed-percent and driver bases run everywhere; stepped tiers are stored
but declined at every binding moment. Dynamic targets resolve active
department, location, class, project, and subsidiary values; custom
segments are not target dimensions yet. Period-source filters cannot use
item filters. When several rules sweep one close, the close action runs
them in rule sort order. Simultaneous (reciprocal) solving is not
implemented: versions that select it are refused at publication and at
every run, and the setup UI offers sequential only.
Report-backed drivers need an actor with report rights. Each one declares
a temporal contract: period activity weighs the run window on the report's
date field (refusing reports with no date field), balance as of weighs the
snapshot at the window end, and fixed query weighs the report's own scope
untouched. Previews and runs echo the enforced contract, and evidence that
reaches the report row cap is refused instead of weighed truncated.
`,
}
