import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadPnl, pnlSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function PnL({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const data = await loadPnl(sp)
  return (
    <>
      {/* Proof-of-path marker for the conformance harness; React hoists it to
          <head>, outside the compared <main>. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={pnlSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}
