import { readTaxRateProviderConfigView } from '@openbooks/engine/src/tax/rate-providers.ts'
import { TaxProviderForm } from './TaxProviderForm'

export async function TaxProviderPage({ orgId }: { orgId: string }) {
  const config = await readTaxRateProviderConfigView(orgId)
  return (
    <TaxProviderForm
      initial={config ? JSON.parse(JSON.stringify(config)) : null}
    />
  )
}
