import * as path from "node:path";

export interface SftpWatchFolderRef {
  id: string;
  folder: string;
  accountLabel: string;
}

export interface SftpWatchFolderOverlap {
  schedule: SftpWatchFolderRef;
}

/** Stable transaction-lock identity shared by schedule writes and scan claims. */
export function sftpScheduleFolderLockKey(orgId: string, sftpServerId: string): string {
  return `sftp-schedule-folders:${orgId}:${sftpServerId}`;
}

/** Canonical root-relative POSIX folder used by both configuration and scans. */
export function normalizeSftpWatchFolder(folder: string): string {
  const canonical = path.posix.normalize(`/${String(folder ?? "").trim()}`).replace(/^\/+|\/+$/g, "");
  if (!canonical || canonical === ".") {
    throw new Error("an SFTP import schedule must name a folder below the server root");
  }
  return canonical;
}

/** Return the first configured route whose tree intersects the candidate. */
export function findSftpWatchFolderOverlap(
  candidate: string,
  schedules: readonly SftpWatchFolderRef[],
): SftpWatchFolderOverlap | null {
  const wanted = normalizeSftpWatchFolder(candidate);
  for (const schedule of schedules) {
    const existing = normalizeSftpWatchFolder(schedule.folder);
    if (wanted !== existing && !wanted.startsWith(`${existing}/`) && !existing.startsWith(`${wanted}/`)) continue;
    return { schedule };
  }
  return null;
}

/** A named refusal with a concrete, operable remedy. */
export function sftpWatchFolderOverlapRefusal(
  candidate: string,
  overlap: SftpWatchFolderOverlap,
): string {
  const existing = normalizeSftpWatchFolder(overlap.schedule.folder);
  return `SFTP import folder '${normalizeSftpWatchFolder(candidate)}' overlaps schedule '${overlap.schedule.id}' ` +
    `for account '${overlap.schedule.accountLabel}' (folder '${existing}'); choose a separate non-overlapping folder or deactivate the other schedule`;
}
