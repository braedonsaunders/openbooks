import type { DocArticle } from '../types'

export const selfService: DocArticle = {
  slug: 'self-service',
  title: 'Your Employment Record',
  category: 'administration',
  order: 12,
  summary:
    'The Me workspace shows your employment summary, contact profile, leave, checklist steps, reviews, benefits, and — for managers — the direct-report team. Profile edits file a request HR approves before anything updates.',
  updated: '2026-09-20',
  keywords: ['self-service', 'me', 'profile', 'team', 'reviews', 'benefits', 'goals', 'enrollment', 'emergency contact', 'my employment', 'manager'],
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

Managers see the Team tab only while they hold direct reports as of today: team visibility follows the current line reporting relationship, one level, never dotted lines and never a report's report. The roster links each report to the employee drawer on the Employment tab. Open steps assigned to you, pending leave requests, and pending change requests list beside the roster; approve and decline ride the native Approvals worklist, so rows deep-link there and the team builds no second decision path. For each report the team also names the manager review owed in the open cycle with its draft or submitted state, linked to the performance drawer — answering rides the drawer, the team builds no second write surface.

## Reviews

The Reviews tab lists the person's own review cycles: the self-assessment owed in each cycle with its due date, the manager review once shared with them, and the acknowledge action on a shared review. Answering a self-assessment rides the performance drawer through the row link. A person never sees calibration or an unshared manager review — the read scope admits subjects only once shared, and calibration fields never leave HR. Goals list beside the cycles with progress; recording progress posts with a note through the same governed goal service HR uses, so every refusal the service raises surfaces on the page with its remedy.

The tab hides when the organization holds no review cycles at all — hidden is a fact, never a refusal.

## Benefits

The Benefits tab shows the person's current elections with the monthly amounts payroll deducts — the stored per-period figures, never a recomputed number — the open enrollment window when one covers their employer subsidiary, dependents on file, and the elect and change dialogs. Electing and changing ride the existing enrollment service inside an open window covering the employment; outside one the workspace refuses by name instead of recording a windowless change.

The tab hides when the organization holds no benefit plans at all — hidden is a fact, never a refusal.

Payroll, wages, and compliance never appear in the manager's drawer unless the manager independently holds those grants — the team read selects no pay data at all, so there is nothing to leak through the tab.

## Reporting and assistance

Workforce reports stay in the Reports module with every other report; the Me workspace adds none. The assistant read tool answers questions about your own employment summary, review cycles, and benefits from the same canonical read services as the workspace, so the numbers always agree.
`,
}
