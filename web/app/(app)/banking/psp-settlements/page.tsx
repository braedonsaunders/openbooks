import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadPspSettlements, pspSettlementsSpec } from './view'

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
  const data = await loadPspSettlements()
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={pspSettlementsSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}
