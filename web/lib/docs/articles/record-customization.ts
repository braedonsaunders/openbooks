import type { DocArticle } from '../types'

export const recordCustomization: DocArticle = {
  slug: 'record-customization',
  title: 'Record Forms and Views',
  category: 'administration',
  order: 4,
  summary: 'Customize tenant-wide record forms and searchable list views for transactions, customers, vendors, employees, projects, and operational records.',
  updated: '2026-07-21',
  keywords: ['custom form', 'customer form', 'vendor form', 'employee form', 'saved view', 'field layout', 'record customization'],
  related: ['company-settings', 'parties-items-and-projects', 'labor-pricing'],
  body: `# Record Forms and Views

**Administration → Forms & Views** controls the forms and lists used throughout
the organization. Configuration is tenant-scoped. Select a record type before
creating or changing a form or view.

## Record forms

Forms are available for transactions and record-shaped configuration, including
**Customer**, **Vendor**, **Employee**, **Project**, and **Labor rate card**.
The standard form is a real editable baseline. Administrators may create
additional forms, choose an organization default, and select another active
form from a record drawer's **Actions** menu.

For each form, administrators can:

- move built-in and custom fields between groups;
- change field order and width;
- rename, show, hide, require, or lock fields; and
- choose which permitted record actions are visible.

Customer forms include identity and accounting fields, invoicing preferences,
and the related **Labor Pricing** assignment list. Vendor forms include identity
and purchasing/payment defaults. Vendor bank accounts remain a governed related
section because approval and masked account handling are separate from ordinary
header fields. Employee forms include workforce dimensions; confidential wage
rates remain permission-gated on their own tab.

## Shared record drawer

Customer, vendor, and employee records use the standard record drawer. The
header has one **Edit** control, one **Actions** menu, and **Fullscreen**. The
shared **Attachments** and **Audit** tabs preserve evidence consistently. Form
changes affect presentation and allowed interactions; they do not bypass record
permissions, approval rules, or audit logging.

## Views

Saved views control searchable, filtered, sorted, paginated lists. Organization
views can be shared and marked as defaults; personal defaults override the
organization choice for that user. A view never grants access to records or
fields that the user cannot otherwise read.
`,
}
