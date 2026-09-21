import type { DocArticle } from '../types'

export const inboxAndHome: DocArticle = {
  slug: 'inbox-and-home',
  title: 'Your Inbox and Home',
  category: 'administration',
  order: 12,
  summary:
    'One inbox where approvals, checklist steps, requests, and notices complete in place, and a home dashboard composed for employees, managers, and admins.',
  updated: '2026-09-20',
  keywords: ['inbox', 'my tasks', 'approvals', 'home', 'dashboard', 'notices', 'persona'],
  related: ['self-service', 'hrm-processes'],
  body: `# Your Inbox and Home

The inbox is where work waiting on you completes. Approvals, checklist steps, leave and change requests, reviews, enrollment windows, signatures, timesheets, expenses, and notices each render as one row with the actions its own surface allows — approve, reject, submit, complete, acknowledge, mark read — and every action runs through that surface's service, so the inbox and the native page can never disagree. A refusal names its remedy: a rejection without a reason, a delegation without a colleague, or an item someone else already decided.

Filter the list by approvals, my tasks, signatures, notices, or overdue. Decision rows (flow gates, documents, pay runs, budgets) decide through the same controls as ever, including bulk approve and out-of-office delegation. Task rows complete in place and disappear with a confirmation; the row stays put with the service's message when the action is refused.

The badge on the Inbox entry counts pending decisions plus unread notices. Notices also live under their own route, and every new alert source writes a notice row — one channel, readable in both places.

## Home

The home dashboard composes itself from what you hold. Everyone gets my tasks, pay, time-off balances with one-tap requests, who's out, upcoming dates, celebrations, announcements, and the ask box. Managers add approvals awaiting them, team absence, overdue team steps, nudges, and team headcount. Admins add the attention rollup, workflow errors, and the compliance calendar. Every tile links where its rows live; a tile with nothing true to say renders empty rather than a zero as a fact.

A dashboard you customized stays yours. Announcements are authored under Setup → Company → Announcements with audience scope and dates. Celebrations and manager nudges are optional modules on Company Settings → Features and hide without deleting anything when off.

## Reporting and assistance

The inbox_items assistant tool reads the caller's own items through the same adapters as the page, so its answers always agree with the screen. Authoring stays human-attested: filing, submitting, and deciding happen in the product, never through the assistant.
`,
}
