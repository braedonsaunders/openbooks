# Payroll filing attribution after migration 0093

New payroll records the resolved employer filing account on its pay stub. A
captured null means that the payroll was unassigned; a later default account
does not adopt those wages. Changing an employee's profile affects future
calculation. Historical filing and remittance reports use the stored account.

Existing stubs have no original account snapshot. Migration 0093 preserves all
existing fields and marks their filing attribution `unknown`; it does not infer
an original employer from current profile/default settings. Affected T4, W-2,
Form 941 and remittance reports refuse to generate until the attribution is
reviewed. An inactive account remains available for historical report labels;
new-account selection and remittance-bill creation retain their active checks.

Before rollout, inventory unresolved stubs and obtain their original payroll
registers, issued returns or equivalent employer-account evidence. Complete this
reconciliation before resuming affected filing or remittance work. Apply 0093
before running the new application. Retain its columns, guards and audit records
if the application is rolled back. Older report code still resolves live
assignments and must not be used as an authoritative historical report during a
rollback; pause affected exports until the snapshot-aware version is restored.

The operational command accepts a reviewed JSON array, with at most 1,000 rows:

```json
[
  {
    "stubId": "<pay-stub UUID>",
    "filingAccountId": "<original employer-account UUID>",
    "reason": "Original employer verified against the archived payroll register",
    "reference": "<durable reference to the original evidence>"
  }
]
```

Use an explicit JSON `null` for `filingAccountId` only when the evidence confirms
that the original payroll was unassigned. The referenced account must belong
to the same organization and country as the stub. Do not substitute a current
account when the original evidence is unavailable. Preserve the source evidence
in the organization's controlled records; a reference is not a replacement for
that evidence.

Configure the normal database environment for the intended installation. Use
an active actor with `payroll.manage` permission in the organization. The command
uses tenant transactions and checks the actor's current permission.

```sh
node --import tsx scripts/payroll-reconcile-filing-accounts.ts \
  --org '<organization UUID>' --actor '<authorized actor UUID>' \
  --input '/absolute/path/reviewed-attribution.json'
```

This default preview executes the same guarded updates and audit inserts, then
rolls the entire transaction back. Review the original evidence, mappings and
preview result before explicitly applying the same file:

```sh
node --import tsx scripts/payroll-reconcile-filing-accounts.ts \
  --org '<organization UUID>' --actor '<authorized actor UUID>' \
  --input '/absolute/path/reviewed-attribution.json' --apply
```

Apply changes only unresolved legacy attribution. Each change records the
actor, time, full before/after stub and reason/evidence reference in `audit_log`.
A missing, foreign, already reconciled or invalid row aborts the entire batch.
Reconciliation cannot change monetary fields or overwrite a captured account.
A repeat apply is refused; verify the audit and stored attribution after an
interrupted client session before retrying. A mistaken captured or reconciled
account requires a separately controlled correction; this command is not a
historical reassignment tool.

This migration preserves account assignment, not a reconstruction of evidence
that the original system never stored. Account metadata, opening balances and
remittance destination/accounting policy have separate controls and review
requirements.
