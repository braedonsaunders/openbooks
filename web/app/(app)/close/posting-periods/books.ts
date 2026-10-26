export type PostingPeriodBook = {
  id: string;
  name: string;
  is_primary: boolean;
};

/** Keep a valid requested book; otherwise use the active primary book. */
export function resolvePostingPeriodsBookId(
  books: PostingPeriodBook[],
  requestedBookId: string | undefined,
): string {
  return (
    books.find((book) => book.id === requestedBookId)?.id ??
    books.find((book) => book.is_primary)?.id ??
    books[0]?.id ??
    ""
  );
}
