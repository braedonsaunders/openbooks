import { redirect } from 'next/navigation'

// Pooled tax depreciation now lives as a tab of the Fixed Assets cockpit.
export default function TaxPoolsRedirect() {
  redirect('/assets?tab=tax-depreciation')
}
