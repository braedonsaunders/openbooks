import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

/** Legacy bookmark: counts now share Inventory's single list-page shell. */
export default function StockCountsPage() {
  redirect('/inventory?inventoryView=counts')
}
