import type { DocArticle } from '../types'

export const issueReporting: DocArticle = {
  slug: 'issue-reporting',
  title: 'Reporting a Product Issue',
  category: 'administration',
  order: 6,
  summary:
    'Report a defect from any page, what the reporter removes before filing, and how an operator chooses the destination.',
  updated: '2026-09-17',
  keywords: [
    'report',
    'issue',
    'bug',
    'defect',
    'feedback',
    'problem',
    'broken',
    'wrong',
    'tracker',
    'github',
  ],
  body: `# Reporting a Product Issue

When something in OpenBooks behaves wrongly, the report control in the
application header opens a short conversation about it. It is for defects in
the product itself — not a help desk, and not a second assistant. Questions
about how to do your work belong in the assistant or in this documentation.

The control appears only when an operator has configured a destination for the
whole installation, and only for people who hold the **Report a product issue
from any page** permission.

## What happens when you report

Describe what went wrong in your own words. The reporter then does one of three
things:

- **Answers you.** It searches this documentation first. If the behaviour is
  documented — a setting that changes it, a step that was missed — you get the
  answer and the relevant articles, and nothing is filed.
- **Asks at most two questions.** Only when the answer genuinely decides whether
  this is a defect.
- **Files a product issue.** You get the issue link, plus a list of everything
  that was removed from your words before it was filed.

If you disagree with the answer, **Still a bug** files the report anyway. The
reporter never refuses to file.

## What leaves your organization

A filed issue is a generalized description of a defect. Before anything is sent,
the reporter removes:

- email addresses and phone numbers;
- record identifiers and query strings from the page address;
- your name, your sign-in address, and your organization's name.

What remains is the behaviour: the page, the action, and what happened instead
of what you expected. The removed items are listed back to you on the
confirmation, so you can see exactly what was taken out. Amounts, customer
names typed into the description, and other business details are not
automatically detectable — describe the defect, not the record.

Every filed report is written to the audit log with the issue number, the page,
and the list of removed items. Your report text is not copied there: the filed
issue is the record.

## Choosing the destination (operators)

The destination belongs to the installation, not to an organization. One
product tracker receives reports from every organization on the deployment, and
only a platform super administrator can change it — an organization
administrator cannot redirect it.

Open **Platform → Issue reporting** and supply:

- **Repository owner** and **Repository name** — where issues are created.
- **Access token** — needs Issues: Read and write (fine-grained) or repo
  (classic). The token is encrypted before it is stored and is never shown
  again; leaving the field blank keeps the stored one.
- **Default labels** — labels that already exist on the repository.
- **Search open issues first** — when a matching open issue already exists, the
  reporter points the person to it instead of filing a duplicate.

Saving with reporting enabled verifies the token against the repository before
the setting is stored, so a wrong credential fails in front of you rather than
in front of someone reporting a defect. Removing the token also turns reporting
off: a destination with no credential can only fail.

Changes to the destination are recorded in the audit log with the acting
operator, the before and after values, and whether a credential changed. The
token itself never appears in that evidence.

## Triage quality

The reporter uses the organization's configured AI provider
(**Administration → AI**) to read the documentation and generalize the report.
With no provider configured, reporting still works — the report is filed
without triage, which is worse writing and no lost defects.
`,
  related: ['audit-log', 'assistant-chat', 'company-settings'],
}
