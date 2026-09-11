import { requirePermission } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import {
} from '@openbooks/engine/src/payroll-readiness.ts'
import {
} from '@openbooks/engine/src/payroll-payment-method.ts'
import { ModuleView } from '../../../../../components/viewspec/module-view'
import { loadPayRunWizard, payRunWizardSpec } from './view'

export const dynamic = 'force-dynamic'


/**
 * One pay run — the processing wizard. Five freely-navigable steps (scope →
 * readiness → review stubs → GL preview & commit → post & finish); completion
 * derives from run_status + the document's posted state, never from a forced
 * linear march. Wage data — the whole page sits behind payroll.read.
 */
export default async function PayRunPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const authz = await requirePermission('payroll.read')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'payroll')
  const { id } = await params
  const sp = await searchParams
  const data = await loadPayRunWizard(id, sp)
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={payRunWizardSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}
