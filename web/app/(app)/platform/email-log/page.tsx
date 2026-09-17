import { platformEmails } from '../../../../lib/platform-admin'
import { PlatformEmailLogClient } from '../_components/PlatformEmailLogClient'

export const dynamic = 'force-dynamic'

export default async function PlatformEmailLogPage() {
  const result = await platformEmails({
    page: 1,
    perPage: 200,
    dir: 'desc',
    sort: 'created',
  })
  return <PlatformEmailLogClient rows={result.rows} />
}
