import type { DocArticle } from '../types'

export const documentsSignaturesAndRetention: DocArticle = {
  slug: 'documents-signatures-and-retention',
  title: 'HR Documents, Signatures, and Retention',
  category: 'administration',
  order: 13,
  summary:
    'How HR issues documents from templates, collects ordered e-signatures and acknowledgments, retains them on schedules with audited deletion, and exports subject data — with categories declared once under Setup.',
  updated: '2026-09-21',
  keywords: ['document', 'template', 'signature', 'acknowledgment', 'retention', 'legal hold', 'export', 'category', 'merge'],
  related: ['positions-and-headcount', 'certifications-licenses-dispatch'],
  body: `# HR Documents, Signatures, and Retention

HR documents answer one question: what did this person sign, and can we prove it. Templates declare the reusable shells, documents carry the issued instances with their ordered signer timeline, retention schedules declare how long each category lives, and subject-access exports answer data requests. Every refusal on these paths names its remedy — an undeclared category points at Setup, a consumed link points at HR.

Enable the module in Company Settings → Features → HRM → Documents. Two subordinate switches ride beneath it: Retention (schedules with audited deletion after a grace period) and Subject-access exports (one-click exports for data subjects). Turning any switch off preserves its data and history; with the switch off, the tab and the API 404 and no gate runs.

## Categories

Categories are the org-declared vocabulary — contract, policy, acknowledgment, letter, form, other, or whatever the org needs — declared under Setup → Workforce → Document Categories and named by templates, documents, and retention schedules alike. A template or schedule naming a key nobody declared is refused by name with the Setup path as the remedy. Deactivating a category never strands issued documents: reads treat an unknown key as "no rule" while writes fail closed.

## Templates

Templates live under Setup → Workforce → Document Templates (rehomed as a section on the Documents page). Each names a category, a mustache body with merge fields from the resolvable allowlist (employee name, dates, employer, and the other documented fields), whether it takes signatures or acknowledgment only, and the ordered signer roles in employee → manager → hr order. A merge key outside the allowlist is refused with the allowed list named.

## Issuing, sending, signing

Generate a document from a template for one person, or upload a finished file (10 MB cap). Sending mints one single-use HMAC token per open signer with a 60-day expiry and delivers it by email where the transport resolves, otherwise by in-app notification — the delivery always records exactly one channel outcome. Signers act strictly in order: a signer whose earlier signer is still pending is refused by name, and the link activates when they have signed.

Signing records the typed name with the timestamp, the document hash, and hashed network evidence as an HMAC record in the file cabinet; the final signature appends the signature certificate page as a new file version and stores the retention clock. Replay is refused by name — a signature is recorded once, never twice. Declines record a reason HR can act on. Reminders re-mint open signers' tokens (the old link dies with the refusal intact) and record reminded events; the daily job nudges signers past the threshold exactly once.

Acknowledgment-only documents never take signatures: the single acknowledgment stamps once, and both the token and the self-service path refuse anything but an unacknowledged document.

Documents have nine lifecycle states — draft, sent, viewed, partially signed, signed, acknowledged, declined, voided, expired — and the register filters on each. Voiding names a reason and kills live tokens; deletion is a tombstone (the file bytes and tokens are purged, the metadata stays for audit).

## Retention

Retention schedules live under Setup → Workforce → Retention Schedules (rehomed as a section on the Documents page): one per category, a year count, the clock start (completion, termination, or creation), and the terminal action (delete or anonymize). The completion job computes each document's due date idempotently; the close runner flags what comes due and executes after the org's grace days. Execution is two-phase with an explicit approval row: propose, then approve — a refused approval names the blocker.

Legal hold blocks execution by name. Expired approvals never auto-execute. Execution is audited per document with the actor, and the retention actions ledger also reads as a report.

## Subject-access exports

A data subject (or HR on their behalf) requests an export naming the person and an optional module scope. The export builds asynchronously in the worker with per-module savepoints — one module's failure aborts only that module and records the error, never a partial success — and lands as a zip in the file cabinet with a grant to the requester only. The subject downloads through their own link; HR managers download through theirs.

## Reports

The Documents register lists every document with title, category, status, and hold state; Document signers lists the ordered timeline; Retention actions lists every flagged and executed pair with blocks named; Survey results aggregates per survey; the Org chart snapshots in-service employments with managers. All require their read grants.

## Setup reference

The Documents page carries three rehomed Setup sections: Templates, Categories, and Retention schedules. Templates edit signer membership as three booleans in canonical order plus a merge-key list — never raw JSON — and the Setup write path shares the engine's own validation, refusing unknown merge keys and undeclared categories with the engine's own words.
`,
}
