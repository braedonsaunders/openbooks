import { LIST_DRAWER_ROUTES, type ListDrawerSource } from "./list/drawer-routes";

function href(path: string, param: string, id: string): string {
  return `${path}?${new URLSearchParams([[param, id]])}`;
}

export function listRecordDrawerHref(source: ListDrawerSource, id: string): string {
  const route = LIST_DRAWER_ROUTES[source];
  return href(route.path, route.param, id);
}

export function paymentDrawerHref(id: string): string {
  return href("/payments", "payment", id);
}

export function journalEntryDrawerHref(id: string): string {
  return href("/journal", "journalEntry", id);
}
