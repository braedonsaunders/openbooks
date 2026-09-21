import type { DocArticle } from '../types'

export const engagementSurveys: DocArticle = {
  slug: 'engagement-surveys',
  title: 'Engagement and Pulse Surveys',
  category: 'administration',
  order: 14,
  summary:
    'How HR authors engagement surveys, invites respondents with single-use tokens, and reads aggregate results with minimum-group suppression — plus the recurring pulse cadence and the org-chart directory.',
  updated: '2026-09-21',
  keywords: ['survey', 'engagement', 'pulse', 'enps', 'anonymity', 'heatmap', 'invitation', 'driver', 'onboarding', 'exit'],
  related: ['positions-and-headcount', 'documents-signatures-and-retention'],
  body: `# Engagement and Pulse Surveys

Surveys answer one question: how does the workforce feel, in groups large enough to protect. Authoring declares kinds, anonymity grades, and question cards; invitations carry single-use tokens; results read aggregate only, with minimum-group suppression and anonymity handling that differs per grade. A recycled token refuses by name — one response per invitation, never silent overwrites.

Enable the module in Company Settings → Features → HRM → Surveys. One subordinate switch rides beneath it: Pulse surveys (the recurring cadence with trends). Turning any switch off preserves its data and history; with the switch off, the tab and the API 404.

## Kinds and anonymity

Surveys come in five kinds (engagement, pulse, onboarding, exit, custom) and three anonymity grades. Anonymous surveys store no respondent link anywhere — asserted null, not merely unused. Confidential surveys store the link encrypted with the org data key and never expose it below the minimum group size. Named surveys store it plain. The grade is set at authoring and never changes: you cannot de-anonymize a survey after collecting.

## Questions

Question cards come in five kinds: scale (1–5), eNPS (0–10), free text, single choice, and multiple choice. Choice kinds declare their options; scale and eNPS derive theirs. A driver key on a question names the org-declared driver vocabulary the heatmaps group by. Fifteen-question cards fit comfortably; a hundred is the cap.

## Invitations and responding

Opening a draft creates one tokened invitation per respondent (60-day expiry) and returns delivery intents for route-side sending — email where the transport resolves, in-app notification where the respondent holds a login. Responding consumes the token and answers every question in one transaction: a partial submit writes nothing. Closed surveys take no responses; answered invitations refuse replays with the one-response rule named.

Respondents without the email link answer from Me → Open surveys: the page re-mints the open invitation's token in-session (the old link dies with the refusal intact) and navigates to the public response page.

## Results

Results aggregate only: participation, eNPS with promoters/passives/detractors, driver means, the driver × segment heatmap with suppression marks (suppressed cells carry no number, never a traceable figure), free-text comments, and the pulse trend across the survey's lineage. The minimum group size defaults to five and refuses anything lower — a group below it suppresses rather than reveals.

## Reports

Survey results also read as a report: one row per survey with kind, anonymity grade, status, and invitation/response counts. eNPS and participation stay viewer derivations over those counts. Respondent links have no column at all.

## Pulse recurrence

Pulse surveys carry a recurrence rule (weekly, monthly, quarterly) with an anchor date. Closing a pulse survey schedules its successor, linked by lineage, so trends read across generations. The trend panel shows each generation's eNPS in order.
`,
}
