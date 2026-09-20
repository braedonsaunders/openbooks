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

The small `widgets.tsx` registry composes twelve domain families; only the four
renderers that look up another widget stay beside it. Families do not import
the registry or its slot consumers. `widget-slot.tsx` owns slot rendering and
field-reference resolution, and its callers import it directly.

All 403 renderer bodies and key membership are preserved. Enumeration now follows
family order; runtime consumers use keyed lookup, name validation compares
membership, and contract generation sorts keys. Generated prop contracts remain
byte-identical. Boundary tests enforce a 200-line composition limit, 500-line
family limits and the absence of reverse imports.
