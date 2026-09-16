import type { DocArticle } from '../types'

export const assistantChat: DocArticle = {
  slug: 'assistant-chat',
  title: 'Chatting with the assistant',
  category: 'getting-started',
  order: 5,
  summary:
    'Start a conversation, read answers with evidence, review drafts before anything is saved, and find old threads again.',
  updated: '2026-09-16',
  related: ['welcome', 'agent-workbench'],
  keywords: ['assistant', 'chat', 'conversation', 'draft', 'history', 'ask'],
  body: `# Chatting with the assistant

The assistant answers questions about your books — balances, statements,
aging, specific bills or entries — and can draft records for you to review.
It only ever sees what your permissions allow, and nothing is saved until
you confirm it.

## Starting a conversation

Choose **New chat** in the assistant sidebar, or ask from anywhere with the
**Ask the assistant** launcher. A new thread appears in the sidebar the
moment it starts, with a provisional title taken from your first question.

After your first answer completes, the assistant replaces that placeholder
with a short generated title. Rename any thread from its menu at any time —
a title you chose is never overwritten.

## Reading an answer

Answers arrive as prose plus the evidence behind them: the records and
reports the assistant actually read, each linked so you can open the source.
While a turn streams you will see a responding indicator; use **Stop** to
cut a turn short and keep what arrived so far.

Every completed answer carries a timestamp. Long threads show only the most
recent messages at first — choose **Load earlier messages** above the thread
to page back through the history without losing your place.

## Drafts need your approval

The assistant can draft journal entries and other records, but a draft
changes nothing until you choose **Apply** on its review card — and posting
still follows the same approvals as a hand-entered record. Discard any draft
you do not want.

## Continuing earlier work

Threads are private to you and listed newest first. Rename the ones you will
return to, delete the ones you will not. From an analysis finding you can
choose **Ask about this** to open the assistant with that finding attached;
remove the context chip in the composer any time you want it gone.
`,
}
