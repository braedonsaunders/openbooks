import { execFileSync } from 'node:child_process';
import { payrollSupportScope } from '../engine/src/payroll/support-scope.ts';

const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0;
console.log(JSON.stringify({ schemaVersion: 1, source: { gitSha, dirty }, packs: payrollSupportScope() }, null, 2));
