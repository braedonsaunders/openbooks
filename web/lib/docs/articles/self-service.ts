import type { DocArticle } from '../types'

export const selfService: DocArticle = {
  slug: 'self-service',
  title: 'Your Employment Record',
  category: 'administration',
  order: 12,
  summary:
    'The Me workspace shows your employment summary, contact profile, leave, checklist steps, and — for managers — the direct-report team. Profile edits file a request HR approves before anything updates.',
  updated: '2026-09-20',
  keywords: ['self-service', 'me', 'profile', 'team', 'emergency contact', 'my employment', 'manager'],
  related: ['payroll', 'hrm-processes'],
  body: `# Your Employment Record

The Me workspace is your own view of your employment: the summary HR holds about you, your contact profile, your leave requests and balances, the checklist steps assigned to you, and — when you manage people — your direct-report team. Every row is scoped to the person behind your login. A colleague's rows can never appear here, and a missing person link refuses with the remedy instead of showing an empty page.

Enable the module in Company Settings → Features → HRM. The workspace exists only while HRM is on, and every built-in role carries the self-service grants: seeing your own record is part of every login, not an extra permission to request.

## Overview

The landing page shows your employment summary — status, title, department, employer, manager name, and service start — beside your open checklist steps, your pending requests, your leave balances, and links to everything below. Later HR sections plug into the More rail; the page never promises a section that does not exist yet.

## Profile

Your contact record: phone, personal email, postal address, and emergency contact. Edit opens a form whose submit files a profile change request — nothing updates until HR approves it through the same governed approval as every other employment change. A pending proposal shows as a banner with its status. Fields you leave untouched stay untouched; an explicit clear empties a phone, email, or emergency contact; the address saves as a whole.

If no person is linked to your login, every Me page names the remedy: ask an administrator to link your person in Admin → Users → Link person.

## Leave and checklists

Leave reuses the My leave inbox as its tab: your requests and balances, filing included. Checklists lists the process steps assigned to you with completion in the row — the same endpoint HR uses, with the same evidence rules, so an attachment step still needs its file and the refusal says so.

## Team

Managers see the Team tab only while they hold direct reports as of today: team visibility follows the current line reporting relationship, one level, never dotted lines and never a report's report. The roster links each report to the employee drawer on the Employment tab. Open steps assigned to you, pending leave requests, and pending change requests list beside the roster; approve and decline ride the native Approvals worklist, so rows deep-link there and the team builds no second decision path.

Payroll, wages, and compliance never appear in the manager's drawer unless the manager independently holds those grants — the team read selects no pay data at all, so there is nothing to leak through the tab.

## Reporting and assistance

Workforce reports stay in the Reports module with every other report; the Me workspace adds none. The assistant read tool answers questions about your own employment summary from the same canonical read service as the workspace, so the numbers always agree.
`,
}
