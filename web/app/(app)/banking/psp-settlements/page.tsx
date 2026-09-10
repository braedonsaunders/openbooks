import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout, PageContainer } from '../../../../components/page-layout'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadPspSettlements, pspSettlementsSpec } from './view'
import { PspSettlementsWorkspace } from './sections'

/**
 * Minimal PSP settlement import UI — paste Stripe/Recurly/Chargebee JSON
 * and post the balanced kernel journal for fees/disputes/FX/net deposit.
 *
 * Converted to a server shell around the shared workspace: the native path
 * renders it with `initialRows={null}` (client fetch, exactly as before),
 * and the spec path passes the loader's rows so first paint needs no fetch.
 */
export default async function PspSettlementsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | undefined>>
} = {}) {
  const sp = (await searchParams) ?? {}
  if (sp.__viewspec === '1') {
    const data = await loadPspSettlements()
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={pspSettlementsSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
  const data = await loadPspSettlements()

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={data.title}
          description={data.description}
        />
      }
    >
      <PageContainer className="space-y-6">
        <PspSettlementsWorkspace strings={data.strings} initialRows={null} />
      </PageContainer>
    </ListPageLayout>
  )
}
