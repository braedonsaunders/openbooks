import type { DocArticle } from '../types'

export const agentWorkbench: DocArticle = {
  slug: 'agent-workbench',
  title: 'Agent Workbench',
  category: 'reporting',
  order: 3,
  summary:
    'Triage background-agent findings in one ranked inbox, apply governed proposals, assign follow-ups, and start the day with a briefing.',
  updated: '2026-09-21',
  keywords: [
    'agents',
    'agent inbox',
    'findings',
    'proposals',
    'briefing',
    'assign',
    'continuous close',
    'dashboard tile',
  ],
  related: ['financial-reports', 'analytics-and-saved-views', 'period-close'],
  body: `# Agent Workbench

The **Agents** page is one ranked inbox across every background-agent pack
you can read: accounting, finance, collections, payables, reconciliation,
hygiene, forensics, and tax. Findings arrive ordered by materiality times
confidence times age, so the riskiest stale item is always on top. You only
ever see packs your role can read; without the assistant permission the
inbox is empty.

The header keeps the Inbox, Proposals, and Briefing views together. Agent run
history and pack configuration live in Company Setup → Agents; operational
activity is not mixed into the workbench switcher. Four vitals sit above the
work queue: open findings, proposals awaiting, overdue assignments, and the
last agent run.

## Inbox filters

Filter by pack, severity, status, and subsidiary, search by finding type or
summary text, narrow to findings that carry a proposal, or narrow to what
changed in the last day or week. The assignment filter offers three views:
assigned to me, unassigned, and overdue. New since your last visit is
highlighted so you can see what changed while you were away.

The inbox ranks by materiality times confidence times age unless you sort a
column: severity, materiality, and last detected sort in both directions,
and a fresh load always returns to the ranked order.

Subsidiary resolves through account-linked findings. Every other finding
buckets as unresolved rather than guessing a subsidiary, and the filter says
so plainly.

## Proposals tab

The Proposals tab is the same inbox narrowed to findings that carry a
proposed fix. Opening one shows the governed review card: what the agent
wants to run, with which inputs, and an Apply action. Some proposals cannot
be resolved into a runnable command; those stay visible with an explanation
instead of a dead button, and opening the finding shows the full evidence.

## Working a finding

Opening a finding shows severity, status, materiality, confidence, the
agent analysis with root causes and recommendations, the evidence list, and
any dismissal reason. From the drawer you can start a review, resolve,
dismiss with a reason, or reopen; ask about the finding in chat with its
evidence attached; assign it; or leave a note.

Assignment names an owner, a team, or both, plus a due date. Saving
replaces the whole assignment, and clearing returns the finding to the
unassigned bucket. A finding past its due date while still open shows as
overdue in the inbox and on the dashboard tile. Notes keep the follow-up
conversation on the finding itself, newest last.

## Morning briefing

The briefing tab holds one narrative per day: what changed, what needs
attention, and what is waiting on whom. Generating takes a minute and needs
a configured AI model; the result is cached for the day and can be sent as
email. When there is no briefing yet, or the model is unavailable, the tab
says so instead of showing stale text.

## Dashboard tile

The **Agent findings** dashboard tile shows open findings over your readable
packs, how many carry proposals, and the last detection across those packs.
It links straight to the workbench. Like the inbox, it hides entirely
without the assistant permission.
`,
}
