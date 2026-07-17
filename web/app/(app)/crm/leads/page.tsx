import { AccountList } from '../AccountList'
export const dynamic = 'force-dynamic'
export default function Leads({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) { return <AccountList stage="lead" searchParams={searchParams} /> }
