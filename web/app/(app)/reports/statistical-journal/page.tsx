import { ModuleView } from "@/components/viewspec/module-view";
import {
  loadJournalMeasurementReport,
  journalMeasurementReportSpec,
} from "@/lib/reports/journal-measurement-spec";
export const dynamic = "force-dynamic";
export default async function JournalMeasurementReport({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadJournalMeasurementReport("statistical-journal", sp);
  return (
    <ModuleView spec={journalMeasurementReportSpec(data)} data={data} searchParams={sp} trusted />
  );
}
