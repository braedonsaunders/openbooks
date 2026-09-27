import type { DocArticle } from '../types'

export const manufacturingOverview: DocArticle = {
  slug: 'manufacturing-overview',
  title: 'Manufacturing Overview',
  category: 'manufacturing',
  order: 1,
  summary:
    'An introduction to manufacturing concepts, production masters, and the movement of costs from raw materials through work in process to finished goods.',
  updated: '2026-09-26',
  keywords: ['manufacturing', 'work center', 'routing', 'bill of materials', 'BOM', 'WIP', 'scrap', 'effectivity'],
  related: ['overhead-costing', 'labor-costing'],
  body: `# Manufacturing Overview

Manufacturing describes how a shop turns components into finished goods while
tracking the resources and costs used along the way.

## Feature availability

Manufacturing is off by default. Enable it in **Company Settings → Features**;
the **Inventory** feature is required because manufacturing depends on item
stock, bills of materials, and inventory costing.

## How manufacturing cost flows

Costs begin in **raw materials** inventory. When materials are used in
production, their cost moves into **work in process (WIP)**. WIP tracks cost by
element: **material**, **labor**, and **overhead**. When production is
completed, the accumulated cost moves from WIP into **finished goods**
inventory.

Each posted manufacturing cost movement is recorded as a ledger entry with
origin **Manufacturing**. These entries are visible in the **Journal**, where
their dates and accounting effects can be reviewed.

## Normal and abnormal scrap

**Normal scrap** is the expected loss in an ordinary production process. Its
cost remains part of the cost of good output. **Abnormal scrap** is unusual or
avoidable loss; its cost is expensed in the period rather than carried in
inventory. This treatment follows IAS 2, paragraph 13.

## Production masters

A **work center** represents a production resource such as a machine group,
cell, or labor pool. Its calendar and capacity describe when and how much it
can produce. Labor and cell centers use their department to resolve
effective-dated labor and overhead rates; machine and cell centers can also
carry effective-dated machine rates.

A **routing** describes the ordered operations needed to make an item and the
work center assigned to each operation. Routing versions identify which set
of operations applies over time; manufacturing activity retains the version
it used so later edits do not reinterpret earlier work.

A **bill of materials (BOM)** lists the components and quantities needed for
an item. BOM effectivity dates define when each component line applies, so a
build uses the component list effective on its production date and later
changes do not alter historical cost evidence.
`,
}
