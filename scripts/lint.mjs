import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

// Match repository ownership, including new work but excluding ignored local
// maintenance scripts and generated output. Arguments never pass through a shell.
//
// Arguments that name files or directories on disk scope the run to them
// (`npm run lint -- web/lib/a.ts`); everything else passes to eslint as an
// option. Without a path argument the whole repository is linted.
const args = process.argv.slice(2)
const paths = args.filter((arg) => !arg.startsWith('-') && existsSync(arg))
const options = args.filter((arg) => !paths.includes(arg))
const files = paths.length > 0
  ? paths
  : execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' })
    .split('\0').filter((file) => /\.(?:[cm]?js|tsx?)$/.test(file) && existsSync(file))
const result = spawnSync(process.execPath, [
  '--import', './scripts/eslint-typescript-api.mjs', './node_modules/eslint/bin/eslint.js',
  '--no-warn-ignored', ...options, ...new Set(files),
], { stdio: 'inherit' })
if (result.error) console.error(result.error)
process.exitCode = result.status ?? 1
