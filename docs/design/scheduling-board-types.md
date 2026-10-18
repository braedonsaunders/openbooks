# Scheduling board types

Unified Scheduling (`engine/src/schedule-boards`) runs every schedule board
through one booking ledger (`schedule_entries`), one publication rule set and
one audit trail. What differs between boards is declared by the board's
**type**, chosen when the board is created and fixed afterwards.

## The registry

`engine/src/schedule-boards/board-types.ts` is the authoritative list.
Each type declares:

| Declaration | Meaning |
| --- | --- |
| `key` | Stable identifier stored in `schedule_boards.board_type`. |
| `rowKind` | What the rows are: `people`, `tasks` or `resources`. |
| `capabilities` | Board features the type offers (see below). |
| `views`, `defaultViews`, `defaultView` | The views a board of the type may show, starts with, and opens on. |
| `defaultGrain` | Day or timed bookings for a new board. |
| `publishPolicies`, `defaultPublishPolicy` | Publication policies the type allows and starts with. |

`SCHEDULE_CAPABILITY_FEATURES` names the Company Settings → Features switches a
capability needs beyond the board family's own switch (for example
`attendance` needs Device attendance).

The registry is mirrored in the database by
`openbooks_schedule_board_types (key, row_kind, capabilities)`;
`schedule_boards.board_type` references it. The board guard fills the type
from the row kind for boards created without one, refuses changing it, and
refuses a governed publish policy on a type without `governed_publication`.
`schedule_board_has_capability(org, board, capability)` lets every
capability-specific table and guard refuse rows on a board whose type does
not declare the capability, so the rule holds for imports, jobs and direct
writes as well as the UI. In services, `requireBoardCapability` checks the
declaration and its features before any capability command.

Consumers read the registry rather than listing types:

- **New board** presets take a type's defaults (`NewBoardDrawer.tsx`).
- **Setup → Schedule boards** offers the people types and each type's
  publication policies (`web/lib/setup/entities/scheduling.ts`), and its
  validation refuses a type whose row kind does not match or a policy the
  type does not allow (`web/lib/setup/scheduling-validation.ts`).
- **The workspace** shows the Roster tools for the capabilities a board's
  type declares (`RosterDrawer.tsx`, `rosterTabs`), and booking chips and
  drawers render attendance, requests and closing only where they apply.

## Capabilities today

| Capability | What it adds | Main code |
| --- | --- | --- |
| `bookings` | People or resources booked on the board. | `entries.ts`, `window.ts` |
| `patterns` | Recurring shift patterns assigned to people, generated idempotently. | `patterns.ts`, `pattern-store.ts` |
| `shift_requests` | Employee release, change and swap requests, decided by optional Flows. | `requests.ts`, `flows/schedule-request-adapter.ts` |
| `governed_publication` | Publication recorded as a Flows subject; published history immutable. | `publications.ts`, `flows/schedule-publication-adapter.ts` |
| `attendance` | Device check-ins observed against published shifts. | `attendance.ts`, `attendance-math.ts` |
| `closing` | Formal closing of ended shifts with complete attendance. | `attendance.ts` |
| `dispatch` | Service visits assigned to technicians from an unscheduled queue, with conflict checks and live field status. Needs Service dispatch. | `engine/src/service/dispatch.ts`, `dispatch-rules.ts` |

Types today: `people` and `resources` (bookings), `tasks` (project Gantt),
`shift_roster` (all of the above for people) and `dispatch` (bookings and
dispatch for people; live publication only, opening on the `dispatch` view).

Dispatch boards are read and worked with the service grants
(`service.read`, `service.dispatch`), not the shift grants, so a dispatcher
works the board without reading every other people board. A visit booking is
an ordinary published `schedule_entries` row carrying `service_visit_id`; the
shared exclusion constraint and leave and qualification guards therefore
refuse double-booking across every board, and the visit guard keeps a visit's
bookings and status in step. The capability's commands live with the service
domain (`engine/src/service`), which owns the visit lifecycle, and call
`requireBoardCapability(board, "dispatch")`; the generic entry commands refuse
to edit a visit booking directly. See `docs/design/service-dispatch.md`.

## Approvals

Approvals are never hard-coded. Governed publications and shift requests are
native Flows subjects (`schedule_publication`, `schedule_entry_request`).
Submitting runs the subject's `on_submit` Flows; when no enabled Flow gates
it, the action applies at once and records that no approval applied. When a
Flow gates it, the release handler registered in `composition/install.ts`
applies the decision. The adapters forbid self-approval through
`selfApprovalPolicy: "forbidden"` and the maker identity.

## Adding a type

A new type (the `dispatch` type is the worked example) is:

1. An entry in `SCHEDULE_BOARD_TYPES` with its row kind, capabilities, views
   and publication policies; new capabilities are added to
   `SCHEDULE_BOARD_CAPABILITIES` and, when they need a feature switch, to
   `SCHEDULE_CAPABILITY_FEATURES`.
2. A forward migration inserting the type (and any new capability) into
   `openbooks_schedule_board_types`, plus the capability's own tables, each
   guarded by `schedule_board_has_capability`.
3. Capability commands that call `requireBoardCapability` (in
   `engine/src/schedule-boards`, or in the domain module that owns the
   booked records, as `engine/src/service/dispatch.ts` does), and a view
   registered for the board's `views`, rendered by the workspace body switch
   (`DispatchView.tsx` for `dispatch`). The database guard
   `schedule_board_views_valid` and the board type guard must admit the new
   view value.
4. A New board preset that takes the type's defaults, and catalog entries for
   the type's Setup option label.

Existing boards and types need no change: their declarations, entries and
publication rules are untouched by a new type.
