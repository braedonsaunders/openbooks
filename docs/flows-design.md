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
(adapter-mediated document lifecycle transition), `webhook` (POST/PUT, HMAC-signed),
`post_document`.

Gate (approval node): `{ title, assignees: AssigneeTarget[], mode: 'any'|'all',
signatureRequired?, reminderAfterHours?, escalateAfterHours?, escalateTo? }`.
Multi-assignee any/all quorum, reminders, and escalation exceed both beaconhs
(single assignee) and NetSuite (serial-only chains).

AssigneeTarget / RecipientTarget: `user` (id), `role`, `submitter`, `supervisor`
(submitter's manager via `users.partyId → employee_roles.supervisorId`), `field`
(record field holding a user id), and for recipients also `email` literal.

## Execution model

Record-event flows run in-process at the same hook sites as `runTriggerScripts`
(`engine/src/approvals.ts` submit, `engine/src/posting.ts` before/after post,
`engine/src/payments.ts` void). Each execution creates a `flow_runs` row; every
completed action/gate writes a `flow_run_effects` checkpoint keyed
`${flowId}:action:${nodeId}` so re-execution after a failure resumes where it
stopped. Gates pause the run (`status='waiting'`); an atomic conditional UPDATE
on decide prevents double-firing; quorum satisfied → `planFromGate()` resumes
the approve/reject branch. Scheduled triggers and gate reminder/escalation run
off the existing 60s scheduler tick using worker-safe actions only
(email/notify — no gates), enforced by an author-time lint.

Document interplay: `on_submit` flows that produce gates put the document in
`pending_approval`; the approve branch typically carries a
`change_status: approved` action. If no enabled flow matches a document's
submit, the legacy `approval_policies` engine (`engine/src/approvals.ts`) is
the fallback, so existing behavior is preserved.

Permissions: `flows.manage` (author/admin), `flows.approve` (act on gates —
assignees can always act on their own). Nav: Flows under Settings/Build;
gates appear in the existing `/approvals` worklist.
