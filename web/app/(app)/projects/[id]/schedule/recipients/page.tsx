import { ResourceRecipients } from '../../../../scheduling/recipients/view'
import { isUuid } from '@openbooks/engine/src/platform/uuid.ts'
import { notFound } from 'next/navigation'
export const dynamic = 'force-dynamic'
export default async function ProjectRecipients({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { id } = await params
  if (!isUuid(id)) notFound()
  return <ResourceRecipients searchParams={searchParams} projectId={id} />
}
