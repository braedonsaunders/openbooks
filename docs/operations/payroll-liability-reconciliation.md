# Payroll liability account reconciliation

Migration 0095 adds an audited, one-time resolution path for liability lines
whose original account is unknown. It preserves all existing account stamps,
amounts and posted history. Remittance reports and bills refuse nonzero unknown
liabilities; changing current component or statutory setup cannot repair them.

Use the archived original payroll posting/register to review each mapping.
The account must be a posting liability account in the same organization.
An inactive historical account can still identify the original accrual. Do not
substitute the current account when historical evidence is unavailable.

The command follows the existing filing-account reconciliation workflow. It
requires a live actor with `payroll.manage` and access to the original pay-run
legal entity. Employee transfers do not change that historical scope. Supply
a JSON array of at most 1,000 reviewed rows:

```json
[
  {
    "lineId": "<pay-stub-line UUID>",
    "accountId": "<original liability account UUID>",
    "reason": "Verified the original payroll posting",
    "reference": "<durable reference to the retained original evidence>"
  }
]
```

Configure the normal database environment for the intended installation. Preview
executes the guarded writes and audit inserts, then rolls back the transaction:

```sh
node --import tsx scripts/payroll-reconcile-liability-accounts.ts \
  --org '<organization UUID>' --actor '<authorized actor UUID>' \
  --input '/absolute/path/reviewed-liabilities.json'
```

After reviewing the preview and the original evidence, apply the same file:

```sh
node --import tsx scripts/payroll-reconcile-liability-accounts.ts \
  --org '<organization UUID>' --actor '<authorized actor UUID>' \
  --input '/absolute/path/reviewed-liabilities.json' --apply
```

A missing, foreign, already captured or already reconciled line refuses the
entire batch. The database enforces unchanged payroll amounts, tenant-owned
liability accounts and immutable reconciliation evidence. Each transition logs
the actor, timestamp, full before/after line, reason and evidence reference.
Repeated application is refused; verify stored evidence after an interrupted
client before retrying. Do not disable triggers to reconcile production data.

Apply 0095 before the application version using this command. During rollback,
retain its column, guards and audit evidence. Pause unresolved remittance work
rather than rolling back to software that infers liability accounts from live
configuration. An incorrectly captured or reconciled account requires a separate
controlled correction; this command cannot overwrite established history.
