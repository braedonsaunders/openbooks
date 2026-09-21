import type { DocArticle } from '../types'

export const certificationsLicensesDispatch: DocArticle = {
  slug: 'certifications-licenses-dispatch',
  title: 'Certifications, Licenses, and Dispatch Gating',
  category: 'administration',
  order: 12,
  summary:
    'Which certifications and licenses each worker holds, when they lapse, what each job demands, and whether that person can be on that job today — with renewals as new rows and expiry projected at read, never stored.',
  updated: '2026-09-21',
  keywords: ['certification', 'license', 'qualification', 'dispatch', 'gating', 'renewal', 'expiry', 'equipment', 'scheduling'],
  related: ['positions-and-headcount', 'certified-payroll-prevailing-wage-per-diem', 'field-tickets'],
  body: `# Certifications, Licenses, and Dispatch Gating

Certifications and licenses answer one question: can this person be on that job today. The register records what each worker holds, requirements declare what each project, equipment, position, or classification demands, and the dispatch gate compares the two on the assignment date. A block-severity gap refuses the assignment; a warn-severity gap records the override and lets it through.

Enable the module in Company Settings → Features → HRM → Certifications. Three subordinate switches ride beneath it: Dispatch gating (which also needs Projects and Scheduling), Equipment qualifications (which also needs Equipment), and Certification alerts. Turning any switch off preserves its data and history; with the switch off, no gate runs and no alert fires.

## Qualification types

The taxonomy lives under Setup → Workforce → Qualification Types. Each type names a code, a category, the issuing body, a validity in months, a renewal lead time in days, and whether evidence is required. The six base categories are safety, trade, driving, medical, equipment, and compliance; an org that needs more declares them under Qualification Settings, and a category nobody declared is refused by name with the Setup path as the remedy.

A type that stops being issued is retired, never deleted: history keeps pointing at it, and recording against a retired type is refused with the replacement named. Validity months default the expiry at save; the renewal lead time schedules the alert.

## Holding, verifying, renewing, revoking

Recording a qualification stores the worker, the type, the license number, issuance and expiry, and the evidence file when the type requires one — a type that requires evidence refuses the save until the file is attached. Verification is a second pair of eyes: the verifier and timestamp are stored on the row, and verification is its own event in the ledger.

Storage holds only three statuses: valid, revoked, and pending verification. Expiring and expired are projected at every read from the expiry date against the org business day — they are never written, so a status can never go stale. Renewing records a brand-new row and links it to the old one through a renewal event; the old row stays as history. Revoking keeps the row visible with its reason. Every one of these writes appends an event to the qualification ledger, which is append-only: events are never updated, and only the governed amend path removes them.

License numbers are sensitive: sandbox clones blank them, and the assistant register answers from type, dates, and status without pulling identifiers through the conversation.

## Requirements and the gate

Requirements live wherever the work is defined: a project, a piece of equipment, a position, or a classification names the qualification types it demands, each with a severity (block or warn) and an effective window. The gate reads the requirements in force on the assignment date, matches them against the worker's held qualifications as projected that day, and returns a verdict: allowed with warnings, or refused with the blocking gaps named.

The gate runs on the scheduling assignment path, on field-ticket crew rows, on timesheet chips, and through the check API — all four read through the same evaluation, which never writes. A warn-severity override is recorded as its own warned event inside the caller's transaction, so the evidence of who accepted the risk sits beside the assignment. With dispatch gating off, the assignment path never calls the gate.

## Renewal alerts

The daily scan reads each type's renewal lead time and writes one alert row per qualification per lead-day, idempotently: running the scan twice writes nothing the second time. Alerts surface in the inbox and, where configured, by email; sending marks the row sent. The alert queue also reads as a report, so the upcoming renewals for any window list in one place.

## Reports

The Qualifications register lists every held certification and license with holder, employer, type, issuance, expiry, and stored status; the Qualification alerts queue lists every alert with its due day and sent state. Both clamp to the reader's employer subsidiary and require the certifications read grant.
`,
}
