import type { DocArticle } from "../types";

export const crewTimeEntry: DocArticle = {
  slug: "crew-time-entry",
  title: "Crew time entry",
  category: "projects",
  order: 12,
  summary:
    "How foremen enter a day's crew time in one batch: lines per worker, equipment hours, sign-and-submit, stage approvals, and posting.",
  updated: "2026-09-21",
  keywords: [
    "crew time",
    "foreman",
    "crew batch",
    "sign and submit",
    "approval stages",
    "equipment hours",
    "post crew time",
    "crew approval",
  ],
  related: ["field-clock-in", "labor-costing", "payroll"],
  body: `# Crew time entry

When the foreman holds the time for the whole crew, one batch per
project per day replaces a dozen clock pages. The foreman enters a
line per worker — hours, time type, task, cost code, and equipment —
signs once, and submits. Approval runs the declared stage chain, and
posting creates the time entries plus the equipment charges in one
transaction.

## The batch page

Open Time entry, then Crew. Each batch is a project and a day: crew
rows with hours, time type, task, cost code, and equipment inputs,
editable inline while the batch is a draft. Copy-yesterday starts a
day from the last one; the phone renders each worker as a card.

Only the foreman assigned to the project crew — or someone with
time.manage — can enter its batches. Lines validate as entered:
positive hours, equipment as a unit-plus-hours pair, equipment hours
inside the entry plus the org's tolerance, and the unit active in the
org.

## Sign, submit, approve

Submitting a draft needs the foreman's signature when the org requires
it (the default): the signature seals the lines, and any later edit
needs a withdraw back to draft first — history stays in the batch
events either way. Submitted batches run the multi-stage chain through
Flows: supervisor, then project manager, then payroll, or whatever the
org declares in Timesheets setup. Each stage approves or rejects with
a reason; rejection returns the batch with the reason attached.

## Posting

A fully-approved batch posts once: one submitted time entry per line
with a back-link to the line, plus one project-charge document per
equipment line priced from the unit's equipment-charge item. Posting
twice refuses — the second post would double the hours — and a unit
with no charge item refuses by name rather than posting a zero.
Equipment cost lands on the job through the same balanced charge the
equipment register posts, attributed to the unit.

Turn the crew feature off and the pages and routes go away; the posted
entries and their history stay exactly where they were.
`,
};
