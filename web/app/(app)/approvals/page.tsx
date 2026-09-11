import {
} from '@openbooks/ui'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadApprovals, approvalsSpec } from './view'

export const dynamic = 'force-dynamic'

/**
 * Approval hub — three searchParam-driven tabs over the Flows engine
 * (flow gates):
 *
 *   • mine      — everything I can act on (direct, role, delegated-to-me),
 *                 with counts-by-kind chips, aging, and bulk approve/reject.
 *   • submitted — where MY documents are: who they're pending with, since when.
 *   • all       — org-wide pending items (flows.manage / admin only).
 */





export default async function Approvals({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadApprovals(sp)
  if (!data) return null
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={approvalsSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}
