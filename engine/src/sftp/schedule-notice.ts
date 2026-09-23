/**
 * Notice identity for an SFTP import schedule that cannot accept identified
 * statements (no expected external account bound).
 *
 * Single source of truth for the house notice both the SFTP scheduler and
 * the Bank Feeds API write and resolve: the schedule id rides in the href
 * query, so one unread notice exists per (user, schedule) and the link
 * lands the operator on the exact setting (Company Settings → Bank Feeds).
 * Deliberately dependency-free: the web schedule-route tests mock
 * `import-job.ts`, so anything the route needs from the engine must live
 * somewhere the mock does not shadow.
 */
export const SFTP_UNBOUND_SCHEDULE_NOTICE_KIND = "sftp.schedule.unbound";

export function sftpUnboundScheduleNoticeHref(scheduleId: string): string {
  return `/admin/setup/bank-feeds?schedule=${scheduleId}`;
}
