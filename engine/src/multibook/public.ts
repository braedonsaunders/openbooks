/** Multi-book accounting: the application contract for book configuration and replication. */
export {
  closeBookAccountMap,
  closeBookCurrencyVersion,
  createBookAccountMap,
  createBookCurrencyVersion,
  listBookAccountMaps,
  listBookCurrencies,
  type BookAccountMapRow,
  type BookCurrencyRow,
} from "./settings.ts";
export {
  BOOK_REPLICATION_CHANGE_KINDS,
  changeBookReplication,
  listBookReplicationRuns,
  type BookReplicationChangeKind,
  type BookReplicationRunRow,
} from "./replication-runs.ts";
export { bookReplicationStatus, type BookReplicationStatus } from "./status.ts";
export { MULTI_BOOK_DISABLED, MultiBookError } from "./errors.ts";
