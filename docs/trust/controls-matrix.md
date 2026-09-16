# Internal-controls evidence matrix

Each row is one executable check of an OpenBooks financial control from AUDIT-CONTROLS.md, run against OpenBooks. Amounts are compared exactly — a hundredth of a cent is a failure. Controls the product does not implement are listed as **GAP**; they are never omitted and never counted as passing.

These rows are the system's own controls, not requirements of a published accounting standard: they cite control ids, never standard paragraphs, and they are published here — never in the standards conformance matrix.

**8 passing · 0 failing · 0 gaps · 0 not run**

2026-09-16T23:45:33.151Z

## Control A12

| Check | Control | Status | Conformance |
| --- | --- | --- | --- |
| **Apportioning an indivisible total loses no cent**<br><sub>Splitting 100.00 across three equal weights assigns the entire 100.00 — the one-unit leftover lands deterministically on the first target and is recorded as residual, never dropped or invented.</sub> | A12 | PASS | Implemented |
| **Exploded entry children sum to the entered amount**<br><sub>A 1,000.01 bill line exploded by a 60/30/10 entry rule becomes children of 600.0060, 300.0030, and 100.0010 that sum to exactly the entered 1,000.01.</sub> | A12 | PASS | Implemented |
| **Reversing a posted run restores every balance**<br><sub>Posting a 1,000.00 reclass sweep moves 600.00 and 400.00 onto the two target accounts, reversing mirrors every leg, and the ledger afterwards equals the pre-run ledger on every account.</sub> | A12 | PASS | Implemented |
| **Re-running an unchanged sweep posts nothing new**<br><sub>Re-running a posted sweep with unchanged inputs returns the existing run, posts no journal, and leaves exactly one posted run — the fingerprint comparison, not a second posting.</sub> | A12 | PASS | Implemented |
| **Posting refuses an unbalanced contributor set**<br><sub>A contributor line set whose subsidiary totals do not net to zero is refused before it can join the kernel union — posting throws instead of writing a partial entry.</sub> | A12 | PASS | Implemented |
| **A net-zero pair leaves every account total unchanged**<br><sub>A 1,000.00 net-zero sweep onto three departments posts 600.00, 300.00, and 100.00 of dimensional attribution while the account total stays exactly 1,000.00 — company profit and loss cannot move.</sub> | A12 | PASS | Implemented |
| **A published rule version is frozen**<br><sub>Once published, a version refuses definition edits, target replacement, and re-publication — and its definition hash is byte-identical afterwards, so posted runs stay explainable.</sub> | A12 | PASS | Implemented |

## Control E9

| Check | Control | Status | Conformance |
| --- | --- | --- | --- |
| **Reversing a posted entry restores every balance**<br><sub>Posting a 1,000.00 project cost moves 1,000.00 onto the cost account, reversing mirrors every leg through a posted reversal entry, and the ledger afterwards equals the pre-cost ledger on every account.</sub> | E9 | PASS | Implemented |

## Reproducing this

```bash
npm -w engine run conformance -- controls report
```

Computation-tier cases need nothing but the repository. Ledger-tier cases post real documents through the accounting kernel and need `OPENBOOKS_DB_URL` pointed at a throwaway PostgreSQL database.
