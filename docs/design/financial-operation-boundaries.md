# Financial operation ownership

The inventory, pay-run, ledger-posting, payment and close subsystems import
operations from their owning files. There is no compatibility entrypoint or
barrel that recreates the former large files. Callers select the operation they
need; shared contracts and pure policies have their own owners.

## Ownership and transactions

| Domain | Operation owners | Transaction boundary |
| --- | --- | --- |
| Inventory | movements, transfers, transfer-orders, reversal, assembly, revaluation, landed-cost; document integrations separated by purchasing, vendor credits and sales | Existing transaction/executor arguments travel through position locks and cost-layer mutations. Helpers do not open a replacement transaction. |
| Payroll | run-lifecycle, run-calculation, run-stub-compute, run-commit; setup, earnings, protection and persistence have separate owners | Calculation and commitment retain their original transactions, employee locks and refusal checks. Stub helpers receive the active executor. |
| Ledger | posting-document coordinates preparation, commitment and effect dispatch; posting-replay owns controlled replay | Preparation retains its original pre-transaction sequence. The accounting transaction remains in posting-commit, including the durable effects row. Dispatch follows commitment. |
| Payments | `payment-documents`, `payment-posting`, `payment-return`, `payment-queries`; run creation/readiness/claim/posting/cancellation/remittance/files | Existing posting transactions and claim fences remain with the operation that owns the lifecycle transition. |
| Close | run-start, run-automation, tasks, approvals, run-completion, reopening and period-locks | Locking, approval evidence and close/reopen transitions retain their original executor and transaction scope. Mutually recursive readiness/automation work stays together. |

These are behavior-preserving ownership changes. A shorter file is not evidence
that accounting behavior is correct: journal, isolation, replay and concurrency
integration tests remain required at the combined-tree gate.

## Document application boundary

Engine `records/document-edit-policy` owns revision and correction refusal
policy. `ledger/document-input` owns input types; `ledger/document-service` owns
explicit-organization reads and control-account dependencies. Callers import
these owners directly. The web editor owns web draft/edit orchestration and
has no forwarding exports for the extracted engine services.

The application adapter still explicitly composes web correction editing and
feature checks. This is a remaining dependency, not a claim that the entire
application layer is independent of web. Moving that editor requires its own
controlled change with custom-field, allocation, audit and flow evidence.

## Enforced boundaries

- The five retired engine entrypoint files must be absent. The repository
  source census in `scripts/operation-imports.test.mjs` reports zero references
  for each path, including dynamic imports, loader maps and embedded scripts.
- Domain boundary tests enforce bounded operation files, direct ownership and
  acyclic internal static imports. Financial transaction bodies must not be
  split merely to meet the size threshold.
- `check:engine-boundaries` enforces module ownership, declared dependencies and
  non-growth of the two pre-existing cross-module cycles. Internal operation
  DAGs do not imply that those wider cycles have disappeared.
- Mutation targets follow the moved financial policies; historical mutation
  reports remain historical rather than being rewritten as current evidence.

Changes that alter financial results, refusal conditions, lock ordering or
posted history require separate behavioral proof. The revenue modification,
lease remeasurement and lease termination conformance gaps remain open.

## Widget composition

The small `widgets.tsx` registry composes thirteen domain families; only the four
renderers that look up another widget stay beside it. Families do not import
the registry or its slot consumers. `widget-slot.tsx` owns slot rendering and
field-reference resolution, and its callers import it directly.

All 412 renderer bodies and key membership on the rebased main are preserved,
including the five subsequently added HRM adapters. Enumeration now follows
family order; runtime consumers use keyed lookup, name validation compares
membership, and contract generation sorts keys. Generated prop contracts remain
byte-identical. Boundary tests enforce a 200-line composition limit, 500-line
family limits and the absence of reverse imports.


## Final mutation evidence

The full database-mode run at `1d6e4fec443071149393ad5545e13fdc1a55d311`
measured all 32 configured targets, sampling up to 25 mutants per target with
240-second timeouts. The atomic publisher accepted the report: 539 assertion
kills, 129 survivors, 3 timeouts, zero errors, zero skipped mutants (671 measured).
Every existing and inherited floor passed, including when timeout credit is
excluded. This is sampled regression evidence, not complete branch coverage or
an independent accounting certification.

Timeouts were posting-effects line 335 (`0` to `1`) and line 239 (`!id` guard
negation), and sync/applications line 152 (`1` to `0`). The existing scoring
policy includes timeouts: effects reports 1.0, but assertion kills alone are
23/25 (0.92), above its 0.20 floor; applications reports 0.40, but assertion
kills alone are 9/25 (0.36), above its unchanged zero floor. No passing floor
depends on a timeout. The zero applications floor remains a weak historical
ratchet; this work does not claim otherwise.

First floors, ratified from this full run only, are Canada statutory 20/23,
Canada employer levies 15/25, and US statutory 15/23, all in database mode.
These preserve demonstrated detection as regression minima. The remaining
3, 10, and 8 survivors respectively remain coverage obligations; these floors
do not establish adequate statutory coverage by themselves. No prior floor
was reduced. Each extracted target retains its predecessor's ratified floor.

Five initially low targets were repaired by mapping existing owner tests:
earning-lines (union/fringe/adjustments), posting-document (deferred effects),
prepare and commit (atomic posting, inventory, allocations), and replay
(source correction and expense settlement). Payment-documents separately gained
a real persisted entity-selection assertion. Employer levies also gained its
previously omitted existing Quebec HSF suite; US statutory gained its existing
MFJ/FICA/SUI/GL run scenario. A mapping repair and a new assertion are distinct
changes and neither implies every branch is now covered.

The run used an isolated template matching the measured checkout, a private
nonce-marked database, the database-bypass preload, and scratch-owned TypeScript
resolution. Both database and template were dropped afterwards. CI-form
workspace typechecks passed on the measured source; targeted mutation harness
and evidence checks passed 36/36 with zero skips after publication. Combined
unit and full integration gates remain the integrator's landing obligation.
