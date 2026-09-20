import type { DocArticle } from '../types'

export const recruitingFunnel: DocArticle = {
  slug: 'recruiting-funnel',
  title: 'Recruiting: Requisitions, Candidates, and Hires',
  category: 'administration',
  order: 12,
  summary:
    'A vacancy opens as a requisition against the headcount plan, candidates move through the hiring funnel with recorded evidence, and an accepted offer becomes the hire through the same approval path as every other employment start.',
  updated: '2026-09-20',
  keywords: ['recruiting', 'requisition', 'candidate', 'interview', 'offer', 'hire', 'pipeline', 'time to fill'],
  related: ['positions-and-headcount', 'hrm-processes', 'setup-company-group'],
  body: `# Recruiting: Requisitions, Candidates, and Hires

A vacancy today has no path to a hire except a manual employee record. Recruiting closes that loop: a requisition opens against a position (or a planned headcount), candidates move through a configurable pipeline with recorded events, an accepted offer becomes the hire through the same change-request and approval path every other employment start uses, and the requisition fills when its headcount is met.

Enable the module in Company Settings → Features → HRM. Employment records stay readable while HRM is off, but requisitions, candidates, and offers exist only while it is on.

## Requisitions

The Recruiting tab lists every opening with its number, title, position, department, filled-versus-planned headcount, hiring manager, opening date, and status. Status segments filter the list; a row opens the requisition drawer.

A requisition starts as a draft and opens explicitly. Opening is refused when the position is closed, or when the position shows no vacant full-time equivalent as of the target start without the explicit over-establishment decision: over-establishment is named, never silent. A planned headcount with no position yet opens freely. Numbers come from one org-wide sequence, so concurrent openings never collide.

An open requisition holds, resumes, or cancels with a reason. Cancelling retains the opening as history. The fill itself happens only through hire: each hire bumps the filled count, and the status turns filled when headcount is met.

## Candidates and the funnel

A candidate is a name plus contact details — never an employee record until hired. A duplicate email refuses unless it names the existing candidate to merge into; then no new record is created and the candidacy attaches to the survivor with the merge recorded as evidence.

Each candidacy sits on exactly one funnel stage of the requisition's own pipeline. Moves across pipelines refuse, the hired stage is reached only through hire, and terminal candidacies never move. Every transition appends its event in the same transaction as the state change, and the event ledger is append-only: history is recorded, never rewritten.

The hiring manager reads and moves candidates on their own requisitions without the org-wide grant, but never sees contact details. An interviewer on the panel sees the candidate name and the interview, nothing else.

## Interviews and offers

Interviews schedule on active candidacies with a kind, time, and optional employee panel — every panel member must be an employee the scheduler can see. Completion records the verdict with optional feedback and scorecard; completed sittings stand as recorded.

At most one live offer stands per candidacy. Sending opens the response window; a sent offer past its expiry reads expired with no background process, and the next write records it. Declining and withdrawing both take a reason.

Accepting an offer is the hire: one transaction creates the employee record (or reuses it), files the hire change request for approval exactly as a manually proposed hire, links the offer, marks the candidacy hired, and fills the requisition. Any refusal — a requisition gone from open, a position no longer vacant, a refused change request — rolls the whole hire back, so no party, no draft, and no fill ever survives without its approval path. The employment itself comes into existence when the change request is approved, as always.

## Configuration, reporting, and assistance

Funnel configuration lives under Setup → Workforce → Pipeline Templates, with the ordered stages beside it under Pipeline Stages. Each stage names its kind; the funnel ends exactly in hired or rejected. Retire a template with its active switch instead of deleting it — a template that opened requisitions is retained as history.

The Requisitions and Applications workforce reports list openings with headcount versus filled, and candidacies with their funnel stage plus time-to-fill from opening to hire. The assistant read tool answers funnel questions from the same canonical read service as the tab, with candidate names only — contact details never leave through it.
`,
}
