import { readTaxRateProviderConfigView } from '@openbooks/engine/tax'
import { TaxProviderForm } from '../../../../../components/viewspec/native-widgets.client'

export async function TaxProviderPage({ orgId }: { orgId: string }) {
  const config = await readTaxRateProviderConfigView(orgId)
  return (
    <TaxProviderForm
      initial={config ? JSON.parse(JSON.stringify(config)) : null}
    />
  )
}
