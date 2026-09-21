import type { DocArticle } from "../types";

export const structuredInterviewsOffersJobBoards: DocArticle = {
  slug: "structured-interviews-offers-job-boards",
  title: "Structured interviews, offers and job boards",
  category: "administration",
  order: 10,
  summary:
    "How interview kits with blind scorecards, candidate self-scheduling, template offers with in-product signing, board publishing with disposition sync, and consent-based retention rules extend the recruiting funnel.",
  updated: "2026-09-21",
  keywords: [
    "interview kit",
    "scorecard",
    "blind review",
    "self-scheduling",
    "offer template",
    "e-sign",
    "job board",
    "career page",
    "disposition",
    "retention rule",
    "talent pool",
    "consent",
  ],
  related: ["recruiting-funnel", "employment-migration", "positions-and-headcount"],
  body: `# Structured interviews, offers and job boards

The funnel (openings, candidates, applications, interviews, offers, hire)
gets candidacies in the door. Everything on this page is the depth layer
behind the Recruiting sub-tabs, each behind its own feature switch:
structured interviews, interview scheduling, offer signing, job boards,
candidate retention, and the talent pool. Turning a switch off hides its
surface; rows stay and render again when it comes back on.

## Interview kits and blind scorecards

A kit names the guide for one pipeline stage: free-text instructions for
the panel, the rated attributes (each with a category, an ordering
position, and whether it is a focus attribute), suggested questions
optionally pinned to one attribute, and the rating scale — at least two
keys from the canonical vocabulary (strong_no, no, yes, strong_yes). A
kit with sittings is history-pinned: deactivate it instead of deleting
it, so past verdicts keep their guide.

Scheduling an interview creates one scorecard per panel member from the
kit. Submitting requires an overall verdict plus a rating for every
focus attribute; other attributes are optional. Submitted scorecards are
immutable. The blind rule is enforced on read: an interviewer sees other
panelists' verdicts only after submitting their own, and private notes
stay author-only. The hiring-manager summary aggregates per attribute
only after all scorecards are in, listing the missing panelists by name.

## Candidate self-scheduling

Slots are proposed from an interviewer pool's declared availability
windows — windows the pool declares in Setup, never read from a
calendar. Proposing declines any live batch first, so exactly one
booking link is live per interview, then generates a single-use token
link (the raw token is shown once and emailed; only its hash is stored).
Booking is first-wins at the row: concurrent attempts serialize and the
loser is refused by name. Rescheduling declines old slots and proposes
new ones in the same transaction — a booked row is never edited into a
different time. Calendar providers stay org-declared connectors behind
sync connections; the generic layer builds the link and the slot model,
not vendor OAuth.

## Template offers with in-product signing

An offer template carries a mustache body plus a clause list (key,
label, body, default-on). Rendering an offer against a template with
selected clauses appends a version — versions are immutable evidence,
never overwritten. Sending emails a signed link through the per-org
delivery; the page records views, and signing seals the HMAC record
(signer name, timestamp, IP hash, document hash) with the signed PDF
stored as a new file version. Declining needs a reason; voiding closes
the letter. Hire requires an accepted AND signed offer while the offer
signing switch is on, and refuses an unsigned offer by name; with the
switch off, hire behaves as before.

## Job boards and the career page

A posting binds one requisition to one board key: the generic layer
ships the internal career page and a signed feed, and named boards are
connectors behind sync connections. The public career page lists
published postings with an apply form (honeypot plus rate limit) that
writes an application carrying the posting source and the captured
consents. Every application status change on a posting-sourced
application appends a disposition-sent event with the stage and
rejection reason the board contract expects, and enqueues the connector
job; the internal and feed boards implement the contract as logging
no-ops.

## Consent, retention, and talent pools

Candidates carry consents per purpose (this application, future roles,
talent pool) with grant, expiry, withdrawal, and source. A daily job
evaluates retention rules by region scope: inactivity (last application
event older than the retain months) or consent expiry. Extension emails
go out lead-days before expiry and record the request; anonymizing
replaces PII with fixed tokens (name becomes "Anonymized candidate",
contact fields cleared, the resume file deleted through the File
Cabinet) so funnel analytics survive, while deleting removes the
candidate and cascades applications but keeps application events as
orphan-safe aggregates. A candidate with an open application is never
touched, and every run writes a retention-runs row.

Talent pools group past candidates; rediscovery matches pool members to
an open requisition by declared tags (no AI) for the hiring manager to
review.
`,
};
