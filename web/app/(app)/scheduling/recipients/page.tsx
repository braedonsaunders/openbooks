import { ResourceRecipients } from './view'
export const dynamic = 'force-dynamic'
export default function SchedulingRecipientsPage(props: Parameters<typeof ResourceRecipients>[0]) {
  return <ResourceRecipients {...props} />
}
