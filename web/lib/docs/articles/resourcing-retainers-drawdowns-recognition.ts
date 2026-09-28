import type { DocArticle } from '../types'

export const retainersDrawdownsRecognition: DocArticle = {
  slug: 'retainers-drawdowns-recognition',
  title: 'Retainers, Drawdowns, and Recognition',
  category: 'projects',
  order: 6,
  summary:
    'How prepaid retainers activate, how weekly drawdowns consume them, and how revenue recognition follows the work.',
  updated: '2026-09-28',
  keywords: ['retainer', 'drawdown', 'prepaid', 'recognition', 'hours', 'fees', 'exhaustion'],
  related: ['busy-season-capacity', 'staffing-board-evidence', 'labor-costing'],
  body: `# Retainers, Drawdowns, and Recognition

A retainer is prepaid work: the customer pays up front, in hours or in fees,
and project work draws the balance down. OpenBooks keeps three concerns
separate so none can quietly borrow from another: the prepaid terms, the
weekly drawdowns that consume them, and the revenue recognition that follows
the work actually done.

## Terms and activation

A retainer names a project, a customer, a kind, and a total — hours with a
unit rate, or a fee amount — plus a start and end date and the service item
whose recognition rule governs it. A new retainer is a draft. It activates
when its retainer invoice posts, never before: until money is real, no week
may draw against the balance. Drafts can be edited; active retainers can be
extended but not rewritten.

## Drawdowns consume the balance

Each week of project work drafts a drawdown against the retainer: hours for
an hours retainer, an amount for a fees retainer. A drawdown that would
exceed the remaining balance is refused with the shortfall named, so a week
can never spend what is not there. Posting a drawdown moves the amount out
of the balance permanently; the balance is always the total minus posted
drawdowns, computed in the retainer's own currency, and balances are never
totaled across currencies.

## States tell the lifecycle

Draft, active, exhausted, expired, and closed each mean exactly one thing.
Exhausted means the balance reached zero through posted drawdowns; expired
means the end date passed with balance unspent. Closing requires a zero
balance, so a retainer can never be shelved with value still inside it.
Every transition is an audited event with an actor and a reason.

## Recognition follows the work

Recognition events are posted by the revenue run against the retainer's
obligation, in the open months the run owns. The retainer drawer shows each
event with its posted, pending, or reversed state and links to the revenue
recognition workspace for the full picture. Drawdowns record consumption;
recognition records earning. The two agree over the life of the retainer,
and any gap between them is visible in the drawer rather than reconciled
away.

## Evidence behind every figure

Time entries drawn into a hours retainer stay listed as evidence with the
person, the worked date, and the hours. Fee drawdowns reference their weeks.
Nothing about a retainer balance is a typed-in number: the total comes from
the terms, the drawn figure from posted drawdowns, and the difference is
arithmetic the operator can re-perform from the rows shown.
`,
}
