import { ModuleView } from '../../../../components/viewspec/module-view';
import { loadPayrollSupport, payrollSupportSpec } from './view';

export const dynamic = 'force-dynamic';

export default async function PayrollSupport({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const data = await loadPayrollSupport(sp);
  return <ModuleView spec={payrollSupportSpec(data)} data={data} searchParams={sp} trusted />;
}
