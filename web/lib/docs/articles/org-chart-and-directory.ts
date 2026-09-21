import type { DocArticle } from '../types'

export const orgChartAndDirectory: DocArticle = {
  slug: 'org-chart-and-directory',
  title: 'Org Chart and Directory',
  category: 'administration',
  order: 15,
  summary:
    'The reporting tree with vacancies as of any date, the searchable people directory, and the cockpit widget — names, titles, departments, and managers only.',
  updated: '2026-09-21',
  keywords: ['org chart', 'directory', 'reporting', 'manager', 'vacancy', 'span of control', 'as-of', 'tree'],
  related: ['positions-and-headcount', 'engagement-surveys'],
  body: `# Org Chart and Directory

The org chart answers one question: who reports to whom, today or on any past date. The tree resolves from live employments with their line-manager edges, open headcount requisitions render as dashed vacancy nodes, and every node carries span of control and layer depth. The directory answers the companion question — who is everyone — as a searchable register over the same read.

Enable the module in Company Settings → Features → HRM → Org chart. Turning it off preserves everything; with the switch off, the tab and the API 404.

## The tree

The tree reads as of a civil date (defaulting to the org business day): employments in service that day with their primary-assignment title and department and their line manager at that day. Nodes collapse, search expands matching branches into view, and clicking a node opens the person drawer with title, department, span, and direct reports. Under 640px the tree yields to a card stack with the same rows in reading order.

Vacancies come from open headcount requisitions attached to the vacant position — a position with no open requisition renders no vacancy node, and one requisition renders exactly one. Cycles in manager edges refuse at read with the loop named; employments without a position still render under their manager with the assignment title.

## Privacy

The tree and the directory carry names, titles, departments, and managers only — never pay or private fields. They render for employment readers and self-service logins alike; the reports snapshot requires the employment read grant.

## Reports and widget

The Org chart also reads as a report: one row per in-service employment at the report as-of date with name, title, department, and manager. The as-of join is bounded one-sided (versions effective on or before the as-of day, currently-known revisions only) with the in-service status predicate excluding the departed. The cockpit widget embeds the same tree on the HR home.
`,
}
