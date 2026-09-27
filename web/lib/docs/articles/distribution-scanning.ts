import type { DocArticle } from '../types'

export const distributionScanning: DocArticle = {
  slug: 'distribution-scanning',
  title: 'Customer part numbers and scanning',
  category: 'transactions',
  order: 8,
  summary: 'Map customer product codes to catalog items and resolve exact barcode or scanner values in warehouse pickers.',
  updated: '2026-09-27',
  keywords: ['customer part number', 'customer SKU', 'barcode', 'GTIN', 'UPC', 'EAN', 'scanner', 'keyboard wedge'],
  related: ['distribution-pick-ship', 'distribution-warehouses'],
  body: `# Customer part numbers and scanning

Customers may order an item using their own product code. Add a customer part
number in Setup and map it to one item. Each customer code is unique for that
customer, and each item can have one customer code per customer. The sales
order item picker shows that code after you select the customer.

## Set up scan identifiers

Add an exact GTIN, UPC, EAN or internal identifier to an item in Setup. An
identifier may specify the item's base unit or a unit listed in the item's
inventory conversions. Codes are matched exactly; the scanner never guesses
from a partial value.

## Scan a picker

Use a keyboard-wedge scanner while the picker is focused, or choose the camera
control in a browser that supports BarcodeDetector. A successful scan selects
the same item or location that typing its exact code would select. If a value
matches multiple records, the picker lists each candidate and asks you to
choose a more specific code or select the intended record.

Barcode scanning and customer part numbers are independent switches under
Company Settings → Features. Turning either switch off hides its controls and
keeps the configured identifiers and customer mappings intact.
`,
}
