import {
} from '@openbooks/ui'
import { ModuleView } from '../../../../../components/viewspec/module-view'
import { loadSetupEntity, setupEntitySpec } from './view'

export const dynamic = 'force-dynamic'


/** Distinct ref sources declared anywhere in this entity's columns or fields. */

/** Postable accounts for the org, matching the company-settings pickers. */

/** Options for a setup-entity ref source (id + code/name label). */



/** Render one table cell for a column, given the raw (snake-keyed) row. */

export default async function SetupEntityPage({
  params,
  searchParams,
}: {
  params: Promise<{ entity: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const { entity: entityKey } = await params
  const data = await loadSetupEntity(entityKey, sp)
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={setupEntitySpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}
