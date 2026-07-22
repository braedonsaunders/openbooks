import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * SFTP moved into Company Settings → Bank Feeds. This route now redirects to the
 * matching Bank Feeds tab so old links (and the previous nav entry) keep working.
 */
export default async function SetupSftpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const raw = typeof sp.view === "string" ? sp.view : "endpoint";
  const map: Record<string, string> = {
    endpoint: "sftp-endpoint",
    servers: "sftp-servers",
    schedules: "sftp-schedules",
  };
  redirect(`/admin/setup/bank-feeds?view=${map[raw] ?? "sftp-endpoint"}`);
}
