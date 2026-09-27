import type { DocArticle } from '../types'

export const distributionLabels: DocArticle = {
  slug: 'distribution-labels',
  title: 'Carton and Shipping Labels',
  category: 'transactions',
  order: 10,
  summary:
    'Print a 4×6 carton label for each packed carton and a shipping label with the carrier tracking barcode from a shipment.',
  updated: '2026-09-27',
  keywords: ['carton label', 'shipping label', 'barcode', 'Code 128', 'shipment', 'tracking'],
  related: ['distribution-pick-ship', 'distribution-warehouses'],
  body: `# Carton and Shipping Labels

Print shipment labels from the shipment drawer after Fulfillment is enabled in
Company Settings → Features. Both labels use the **4×6 in** paper size and the
shipment's saved ship-to address.

## Carton labels

Assign packed shipment lines to cartons, then choose **Carton labels** in the
shipment drawer. OpenBooks prints one page for each distinct carton assigned
to a shipment line. Each label shows the shipment number, the carton number,
the ship-to name and address, and a Code 128 barcode identifying that shipment
and carton. The action is unavailable when no line has a carton assignment.

## Shipping label

Choose **Shipping label** to print one page for the shipment. It shows the
ship-from warehouse and its configured address, the saved ship-to address,
carrier and service, and the tracking number as readable text and a Code 128
barcode. The action is available after a tracking number has been recorded.

## Customize the labels

Open Admin → PDF Templates and choose **Carton Label** or **Shipping Label**.
Each has its own starter design and can be duplicated before editing. Keep the
paper size at **4×6 in** for label stock. In a template, use
**{{barcode tracking_number}}** (or another merge-field path) to draw a Code
128 barcode; the human-readable value is printed beneath the bars. These are
general-purpose labels and do not create carrier-certified or GS1-128 labels.
`,
}
