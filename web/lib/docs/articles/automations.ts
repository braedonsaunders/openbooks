import type { DocArticle } from '../types'

export const automations: DocArticle = {
  slug: 'automations',
  title: 'Automations',
  category: 'administration',
  order: 12,
  summary:
    'Trigger-based recipes on Flows: schedule, date-relative, field-change, event, document, and manual triggers firing ordered actions with rules, conditions, exception-only approval, simulation, and a run log.',
  updated: '2026-09-20',
  keywords: ['automation', 'trigger', 'workflow', 'recipe', 'schedule', 'webhook', 'simulate', 'run log', 'exception approval'],
  related: ['hrm-processes', 'setup-company-group'],
  body: `# Automations

Automations are the trigger side Flows does not have on its own: time, date-relative, field-change, document, and approvable-event triggers firing ordered actions — create tasks, send email and notifications, start processes, update allowlisted fields, call declared webhooks, wait, and auto-approve steps. Approval chains, gates, delegations, and escalation stay in Flows; automations only decide when a recipe fires and what it runs.

Enable the module in Company Settings → Features → Automations (under Flows), with sub-features for date triggers, field triggers, webhooks, and the simulator. While the feature is off, recipes stop firing and the builder 404s; rows stay and resume when it returns.

## Recipes

A recipe names its trigger (one of six kinds), who it applies to (entity scope filters: subsidiary, department, location, worker type, position, custom attributes), a when-clause (an all/any tree over field conditions), and an ordered action list. Every edit bumps the recipe version, and every run records the version it executed, so the run log replays exactly what fired.

Five recipes ship as templates: welcome tasks three days before start, the probation-end reminder, the qualification-expiring warning, document-signed starts onboarding, and the unsubmitted-timesheet nudge.

## Exception-only approval

Per subject kind, approval settings tune the existing Flows gates instead of replacing them: within the configured thresholds (hours, days, amounts) the gate auto-approves as a system decision naming every threshold checked with its value; outside them the normal human route runs untouched. Delegation after N days reuses out-of-office delegations, and the initiator can never approve their own request.

## Simulation and the run log

Simulate dry-runs a recipe against a chosen subject (or the last few real ones) producing the step list with no writes at all. Every live firing appends a run row — queued, running, succeeded, failed, skipped when nothing matched, or simulated — with per-step output and error. A re-fired trigger collapses onto one run row, so a double-click never double-runs. Failures surface as run rows the inbox shows, plus a note to the recipe owner.

## Reporting and assistance

The Automations and Automation runs workforce reports list recipes with status and version, and every firing with its steps and error. The assistant read tool answers recipe and error questions from the same read service as the builder, so the numbers always agree.
`,
}
