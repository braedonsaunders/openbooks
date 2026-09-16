import { PostingPeriodsView } from './PostingPeriodsView'

export const dynamic = 'force-dynamic'

export default async function PostingPeriodsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const book = sp.book
  const run = sp.run
  const bookId = Array.isArray(book) ? book[0] : book
  const runId = Array.isArray(run) ? run[0] : run
  if (!bookId) throw new Error('book is required')
  return <PostingPeriodsView bookId={bookId} runId={runId ?? null} />
}
