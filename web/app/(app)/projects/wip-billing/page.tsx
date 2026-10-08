import { redirect } from 'next/navigation'

export default async function LegacyPreBillingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value]) params.append(key, entry)
  }
  const query = params.toString()
  redirect(`/projects/pre-billing${query ? `?${query}` : ''}`)
}
