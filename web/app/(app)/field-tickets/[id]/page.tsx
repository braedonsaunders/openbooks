import { redirect } from 'next/navigation'

/** Deep links to /field-tickets/<id> open the standard list flyout. */
export default async function FieldTicketRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  redirect(`/field-tickets?ticket=${id}`)
}
