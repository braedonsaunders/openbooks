import type { DocArticle } from '../types'

// Customization admin tools — the "customize" surfaces under Settings. These sit
// beside the existing "Record Forms and Views" article (record-customization) in
// the administration → Customization section.

export const customRecords: DocArticle = {
  slug: 'custom-records',
  title: 'Custom Records',
  category: 'administration',
  order: 2,
  summary:
    'Define organization-specific master-data record types, including fields, sublists, formulas, and navigation, without a schema change.',
  updated: '2026-07-21',
  keywords: [
    'custom records',
    'record type',
    'master data',
    'field type',
    'sublist',
    'formula',
    'rollup',
    'record builder',
  ],
  related: ['record-customization', 'custom-fields', 'app-builder', 'roles-and-permissions'],
  body: `# Custom Records

**Settings → Custom Records** (route **/records/types**, permission **Manage
record types**) supports organization-defined master data such as equipment
registers, certifications, and inspections. A custom record type requires no
schema change or application code.

## Types versus records

A **record type** is the definition; a **record** is one instance of it. Records
are operational master data, not point-in-time submissions. Editing a published type
takes effect immediately for existing records.

## Build a type

The type builder opens as a draft and **autosaves** as you work. A type has:

- a **key** — a stable slug (editable only while the type is a draft) that drives
  its URL and record numbering;
- a **name**, **plural name**, and **icon**;
- one or more **sections**; and
- an **audience** (roles allowed to see it) and a **Show in navigation** toggle.

Sections are either **header groups** (non-repeating fields) or **line lists**
(repeating sublists with optional minimum and maximum rows) — the same section
model used across the platform's forms.

### Field types

Fields can be **text**, **long text**, **number**, **currency**, **percentage**,
**select**, **multi-select**, **radio**, **date**, **datetime**, **rating**,
**formula**, **GL account**, or **party** (optionally narrowed to customer,
vendor, or employee). A **formula** field is authored with a builder over the
other fields — arithmetic, min/max, concatenation, and **rollups over a line
list** (sum, count, average, min, max). Formula values recompute on every save.

A type may have up to 50 sections and 200 fields. It can be published only with
at least one field and a clean validation.

## Draft, publish, archive

A type moves **draft → published → archived**. Publishing makes it usable; a
published type set to **Show in navigation** gets its own sidebar entry under a
**Records** group, visible to users who hold record read access and any role you
listed in the audience.

## Record presentation

A published type automatically gets a full list view — search, per-choice filter
chips, sortable columns, and a status filter (**draft → active → inactive**) —
and a record drawer. Records are numbered from a sequence keyed to the type (for
example **EQU-00001**). Creating records requires the create permission;
managing the type definitions requires **Manage record types**.

To add fields to an existing built-in record without defining a separate record
type, use **Custom Fields**. For a custom screen with application logic, use the
**App Builder**.
`,
}

export const customFields: DocArticle = {
  slug: 'custom-fields',
  title: 'Custom Fields',
  category: 'administration',
  order: 3,
  summary:
    'Add organization-specific fields to built-in records and transactions, rendered inline with native fields.',
  updated: '2026-07-21',
  keywords: [
    'custom fields',
    'custom field',
    'extension',
    'documents',
    'parties',
    'projects',
    'items',
    'field type',
    'inline',
  ],
  related: ['record-customization', 'custom-records', 'navigation-customization'],
  body: `# Custom Fields

**Settings → Custom Fields** (route **/admin/custom-fields**, permission **Manage
custom fields**) adds your own fields to built-in records without a schema change.
A field's **definition** is stored centrally; its **value** lives in each record,
and a value is accepted only when it matches a definition.

## What can carry a custom field

- **Transaction headers** (documents), optionally narrowed to one kind such as
  vendor bill, customer invoice, payment, expense report, or journal;
- **Transaction lines**, optionally narrowed by kind;
- **Parties**, **Projects**, **Accounts**, and **Items**; and
- CRM **accounts**, **activities**, and **opportunities**.

The target table and kind are locked after creation, because existing values
depend on them.

## Field types and options

Choose from **text**, **long text**, **number**, **currency**, **date**,
**boolean**, **select**, and **multi-select**. Each field can set help text, a
placeholder, a default, numeric bounds, whether it shows as a list column, its
display mode (editable, read-only, or hidden), and which roles may see it.

## Native form integration

A custom field is exposed to the form layout as **cf_<key>** and rendered inline
in the standard field grid. **Forms & Views** controls its position, column span,
and display label. Fields without an explicit position appear in a trailing
group; positioned fields retain their configured placement. On transaction
lines, custom columns appear before the amount column.

Custom fields also flow through to list columns, the API schema, and validation,
so an unknown or malformed value is rejected rather than silently stored.

Use **Custom Fields** to extend an existing record type. Use **Custom Records**
to define a separate record type.
`,
}

export const pdfTemplates: DocArticle = {
  slug: 'pdf-templates',
  title: 'PDF Templates',
  category: 'administration',
  order: 4,
  summary:
    'Design your own printable invoices, orders, and other record PDFs in a visual editor, bound to record data.',
  updated: '2026-07-21',
  keywords: [
    'PDF template',
    'invoice PDF',
    'document template',
    'merge field',
    'print',
    'letterhead',
    'GrapesJS',
    'branding',
  ],
  related: ['record-customization', 'custom-fields', 'sales-workflow'],
  body: `# PDF Templates

**Settings → PDF Templates** (route **/admin/pdf-templates**, permission **Manage
customization**) is where you design the printable version of a record — the
invoice, quote, purchase order, payment, or other document your customers and
vendors receive.

## What you can template

Templates are per record type. Supported types include **customer invoice**,
**customer credit**, **quote**, **sales order**, **purchase order**, **vendor
bill**, **vendor credit**, **vendor payment**, **customer payment**, **expense
report**, **check**, **journal**, and **field ticket**. Each type has one org
**default** template; you can keep several and choose per print.

## Design in the visual editor

The editor is a drag-and-drop visual builder. The canvas represents a page
using the selected **paper size** (Letter, A4, or Legal), **orientation**, and
**margins**, with a running **header** and **footer** that can show page numbers.
Drop in headings, text, images, dividers, spacers, page breaks, and columns, plus
two data-aware blocks:

- **Merge fields** — single values such as **document number**, **date**,
  **total**, party name, and your organization name and logo.
- **Collection tables** — repeating rows bound to the record's **lines** (item,
  quantity, unit price, amount, and related fields).

Your organization's **custom fields** appear in the merge-field palette
automatically, so a field you added to invoices can be printed on the invoice.

Every template starts from a built-in starter design you can **duplicate** and
adapt. Authored HTML is sanitized on save, and merge values are the record's own
data, escaped when inserted — a template cannot run scripts or reach outside the
record.

## How users print

Every record flyout has a **PDF** button. If the record type has more than one
template, the button offers a picker; otherwise it prints the org default. The
button respects the record's read permission, merges the live record into the
selected template, and returns the PDF. A companion action can email it.

Preview your template against sample data while editing, then print a real record
to confirm the layout before making it the default.
`,
}

export const navigationCustomization: DocArticle = {
  slug: 'navigation-customization',
  title: 'Navigation',
  category: 'administration',
  order: 5,
  summary: 'Reorder, rename, hide, and regroup the menu for your organization, and pin items to mobile.',
  updated: '2026-07-21',
  keywords: ['navigation', 'menu', 'sidebar', 'reorder', 'rename', 'hide', 'mobile', 'nav config'],
  related: ['navigation-and-records', 'roles-and-permissions', 'custom-records'],
  body: `# Navigation

**Settings → Navigation** (route **/admin/navigation**, permission **Manage
navigation**) defines the menu for the organization. Without any changes,
the menu is the platform default; your saved layout overrides it.

## What you can change

- **Reorder** groups and the items within them.
- **Rename** any group or item; a name you set displays verbatim, and an item
  left at its default name still follows the app's translations.
- **Move** an item into a different group.
- **Hide or show** items. Hiding is a convenience, not a security control — the
  server still checks permissions on every action, so hiding a menu item does not
  grant or protect access.
- **Pin to mobile** — mark up to four items to appear in the mobile bottom bar.
- **Add custom groups and links** — group headings you name, and links to any URL.
- **Reset to defaults** at any time.

## Per-user resolution

Your layout is the starting point, then each user sees a filtered view:

- modules the user lacks permission for are omitted;
- modules for disabled organization features are omitted;
- hidden items and any group left empty are removed; and
- published custom record types set to show in navigation are appended under a
  **Records** group.

Modules shipped after you saved your layout are added automatically into their
default group, so customizing the menu never hides new features. Module
identifiers are stable, so saved layouts remain valid across upgrades.
`,
}

export const customizationArticles: DocArticle[] = [
  customRecords,
  customFields,
  pdfTemplates,
  navigationCustomization,
]
