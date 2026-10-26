import { clamp, pickString } from "../../../../lib/list-params";

export const REOPEN_REQUEST_FILTERS = ["requested", "approved", "rejected"] as const;
export const REOPEN_REQUEST_PAGE_SIZE = 25;

export function parseReopenRequestListState(sp: Record<string, string | string[] | undefined>) {
  const rawStatus = pickString(sp.status);
  const status =
    rawStatus &&
    REOPEN_REQUEST_FILTERS.includes(rawStatus as (typeof REOPEN_REQUEST_FILTERS)[number])
      ? rawStatus
      : undefined;
  const page = clamp(Number(pickString(sp.page) ?? 1), 1, 10_000);
  const perPage = clamp(Number(pickString(sp.perPage) ?? REOPEN_REQUEST_PAGE_SIZE), 5, 100);
  return { status, page, perPage, offset: (page - 1) * perPage };
}
