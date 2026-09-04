import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

// Match repository ownership, including new work but excluding ignored local
// maintenance scripts and generated output. Arguments never pass through a shell.
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' })
  .split('\0').filter((file) => /\.(?:[cm]?js|tsx?)$/.test(file) && existsSync(file))
const result = spawnSync(process.execPath, [
  '--import', './scripts/eslint-typescript-api.mjs', './node_modules/eslint/bin/eslint.js',
  '--no-warn-ignored', ...process.argv.slice(2), ...new Set(files),
], { stdio: 'inherit' })
if (result.error) console.error(result.error)
process.exitCode = result.status ?? 1
