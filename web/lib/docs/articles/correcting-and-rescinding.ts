import type { DocArticle } from '../types'

export const correctingAndRescinding: DocArticle = {
  slug: 'correcting-and-rescinding-changes',
  title: 'Correcting and Rescinding Changes',
  category: 'administration',
  order: 13,
  summary:
    'Action and reason codes on every change request, and the three event verbs — cancel an in-flight request, rescind a completed change, or correct it — all as appended events, never edits.',
  updated: '2026-09-20',
  keywords: ['rescind', 'correct', 'cancel', 'reason code', 'action code', 'reverse', 'change request'],
  related: ['hrm-processes', 'automations'],
  body: `# Correcting and Rescinding Changes

Every change request files under a generic HR action (hire, transfer, promotion, pay change, manager change, termination, and more) with a reason code from the vocabulary configured beside the change-request queue. While the reason-code switch is on, submitting without both is refused; while it is off, classification is ignored and nothing is asked.

History is never edited. All three corrections are appended events on the immutable change ledger, each visible in the change history with its verb chip:

- Cancel withdraws an in-flight request with a reason. Only drafts and pending requests cancel; anything decided or applied is terminal.
- Rescind reverses a completed change: it closes the version the change created and reopens the prior image at the original effective date, writing a rescind event naming the reversed change. It refuses when a later change depends on the target (working newest to oldest instead) and when payroll has consumed the period.
- Correct fixes a completed change. By default it opens a new pre-filled change request so the correction itself passes approval; orgs that allow direct correction apply it as a new version at the same effective date with a correct event naming the corrected change.

Rescinding and correcting need the employment approval and management permissions respectively, and every verb carries the written reason the audit needs.
`,
}
