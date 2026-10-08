import { writeFileSync } from 'node:fs'
import { pool, longPool } from '../platform/db.ts'
import { refreshNetSuiteEmployees } from './netsuite-employees.ts'

const args = process.argv.slice(2)
const read = (key: string) => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1] }
try {
  const orgId = read('--org'), connectionId = read('--connection'), actorId = read('--actor')
  const employeeRefs = args.flatMap((value, index) => value === '--employee' ? [args[index + 1] ?? ''] : [])
  if (!orgId || !connectionId || !actorId) throw new Error('--org, --connection and --actor UUIDs are required')
  const result = await refreshNetSuiteEmployees({ orgId, connectionId, actorId, employeeRefs, execute: args.includes('--execute') })
  const report = read('--report')
  if (report) writeFileSync(report, JSON.stringify(result,null,2)+'\n',{ mode: 0o600 })
  console.log(JSON.stringify({ runId: result.runId, sourceEmployees: result.source.length, destinationEmployees: 'after' in result ? result.after.length : result.before.length, executed: args.includes('--execute') }))
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Employee source refresh failed')
  process.exitCode = 1
} finally { await Promise.allSettled([pool.end(),longPool.end()]) }
