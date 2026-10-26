import { getTranslations } from "next-intl/server";
import { ModuleView } from "../../../../components/viewspec/module-view";
import { attendanceExceptionsSpec, loadAttendanceExceptionsReport } from "./view";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("reports.attendanceExceptions");
  return { title: t("title") };
}

/**
 * Attendance exceptions: ended roster shifts whose device attendance shows an
 * absence, a late arrival, an early leave, a long break or a device not yet
 * synchronized, for a period. The loader redirects to the Features remedy
 * while Shift planning or Device attendance is off.
 */
export default async function AttendanceExceptionsReport({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadAttendanceExceptionsReport(sp);
  return <ModuleView spec={attendanceExceptionsSpec(data)} data={data} searchParams={sp} trusted />;
}
