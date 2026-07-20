# Flows — approvals & workflow automation

Visual graph automation engine for openbooks, ported from beaconhs-platform's flows
system (pure planner + subject adapters + checkpointed executor) and extended to
exceed NetSuite's SuiteFlow/approval-routing capabilities.

## Architecture (mirrors beaconhs)

- **Pure core** — `packages/forms-core/src/automation.ts`: zod graph schema
  (trigger/condition/action/gate nodes, edges with `next|then|else|approve|reject`
  handles), `planAutomation()` / `planFromGate()` traversal, graph lints. No I/O.
  Reuses the existing `logicRuleSchema` / `evaluateLogicRule` in the same package.
- **Subject profiles** — `packages/forms-core/src/flow-subjects.ts`:
  `FlowSubjectProfile` declares which triggers/actions/statuses/fields a subject
  (document kind) offers; drives both the builder UI and author-time lints.
- **Schema** — `schema/src/flows.ts`: `flows` (graph per subject kind),
  `flow_runs` + `flow_run_effects` (run history + idempotent checkpoints — an
  improvement over beaconhs, which had no run history), `flow_gates` (paused
  human approvals), `notifications` (in-app inbox, new to openbooks).
- **Engine** — `engine/src/flows/`: executor (`execute.ts`), trigger dispatch
  (`run.ts`), gate store/decide/resume (`gates.ts`), adapter registry
  (`registry.ts`, documents adapter first), scheduler integration (scheduled
  triggers via cron cursor, gate reminders/escalation via `remind_at`/`escalate_at`
  scan in `engine/src/scheduler.ts` tick).
- **Web** — `/admin/flows` builder (React Flow / `@xyflow/react`), `/approvals`
  worklist upgraded to flow gates, APIs under `web/app/api/admin/flows` and
  `web/app/api/flows/*`.

## Vocabulary (openbooks ERP adaptation)

Triggers: `on_create`, `on_submit`, `before_post`, `after_post`, `before_void`,
`status_change` (from?/to?), `on_field_value` (LogicRule), `scheduled` (cron, tz),
`manual` (record button: buttonId, label, confirm?, requirePermission?, showIf?).

Actions: `send_email` (recipients, subject/body with `{{field}}` interpolation),
`notify` (in-app), `set_field` (writable header fields only), `change_status`
(adapter-mediated document lifecycle transition), `post_document`, `lock_record`,
and `unlock_record`.

Gate (approval node): `{ title, assignees: AssigneeTarget[], mode: 'any'|'all',
signatureRequired?, reminderAfterHours?, escalateAfterHours?, escalateTo? }`.
Multi-assignee any/all quorum, reminders, and escalation exceed both beaconhs
(single assignee) and NetSuite (serial-only chains).

AssigneeTarget / RecipientTarget: `user` (id), `role`, `submitter`, `supervisor`
(submitter's manager via `users.partyId → employee_roles.supervisorId`), `field`
(record field holding a user id), and for recipients also `email` literal.

## Execution model

Record-event flows run in-process at the same hook sites as `runTriggerScripts`
(`engine/src/flows/submit.ts` submit, `engine/src/posting.ts` before/after post,
`engine/src/payments.ts` void). Each execution creates a `flow_runs` row; every
completed action/gate writes a `flow_run_effects` checkpoint keyed
`${flowId}:action:${nodeId}` so re-execution after a failure resumes where it
stopped. Gates pause the run (`status='waiting'`); an atomic conditional UPDATE
on decide prevents double-firing; quorum satisfied → `planFromGate()` resumes
the approve/reject branch. Scheduled triggers and gate reminder/escalation run
off the existing 60s scheduler tick using worker-safe actions only
(email/notify — no gates), enforced by an author-time lint.

Document interplay: `on_submit` flows that produce gates put the document in
`pending_approval`; the approve branch carries a `change_status: approved`
action that releases it. Flows own approvals outright — there is no separate
approval engine. When no enabled flow gates a submit, the web layer decides:
direct-post kinds and credit memos proceed to `approved`, while kinds that
require approval surface "no approval flow is configured" until one is authored.

Permissions: `flows.manage` (author/admin), `flows.approve` (act on gates —
assignees can always act on their own). Nav: Flows under Settings/Build;
gates appear in the existing `/approvals` worklist.

## Production parity audit (2026-07-17)

The authenticated source-account audit found 18 exportable workflows and 7
vendor-locked workflows. The exportable set uses 41 add-button actions, 67
set-field actions, 19 email actions, 15 display-type actions, 9 record locks,
9 button removals, 6 mandatory-field actions, and 5 custom actions. That audit
drives the implementation order; source-specific identifiers remain tenant
configuration rather than product code.

The current production tenant has six enabled native flows: bill approval,
payment approval, expense approval, journal approval, bank-detail approval,
and scheduled remittance delivery. Every enabled graph validates against its
tenant-aware profile. The remittance flow uses a registered custom sent-at
field, so its scheduled fan-out has an idempotent latch.

Authoring and runtime parity delivered in this slice:

- Manual triggers are arbitrary record-header buttons, including tenant
  permission selection, visibility rules, confirmation copy, and live preview.
  They render on document, bank-account, and budget records.
- Gate approve/reject controls render through the subject adapter, including
  non-document records, and support self-approval prevention.
- Roles, permissions, statuses, event sources, and configured custom fields are
  selected from tenant-aware vocabularies instead of typed as opaque IDs.
- Scheduled flows can fan out over records with a typed filter and bounded
  limit; email actions can attach the active tenant PDF; set-field actions can
  use fixed, date/time, or current-user values.

Exact source parity is not yet assertable for the seven vendor-locked workflows:
their definitions cannot be exported by the authenticated CLI. They require an
authorized source-side unlock/export or a behavioral capture before their
conditions and side effects can be proven equivalent. The product must not
claim those workflows are replicated until that evidence exists.
