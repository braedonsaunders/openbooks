import { ResourceRecipients } from "./view";
export const dynamic = "force-dynamic";
export default function SchedulingRecipientsPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <ResourceRecipients {...props} />;
}
