import { parseManifest, validateBundle } from './manifest'

export type AppPackageFile = {
  path: string
  content: string
  isBinary?: boolean
}
export type EditableAppPackage = {
  manifest: unknown
  files: AppPackageFile[]
  grantedPermissions?: string[]
}

export const PACKAGE_PATH_REFUSAL = 'Use relative file paths without traversal.'

export function validPackagePath(path: string): boolean {
  return (
    /^(?!\/)(?!.*\.\.)(?!.*\/\/)[a-z0-9._\-/]+$/i.test(path) &&
    !path.split('/').includes('.') &&
    !path.endsWith('/') &&
    path !== 'manifest.json'
  )
}

/** Zip entry or shared-root prefix: relative, no `..`, no `//`. */
export function validZipEntryLocation(path: string): boolean {
  return !path.startsWith('/') && !path.includes('//') && !path.split('/').includes('..')
}

export function validZipRootPrefix(prefix: string): boolean {
  if (!prefix) return true
  if (prefix.startsWith('/')) return false
  return validZipEntryLocation(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix)
}

export type AppliedDraftInstallState = {
  activeVersionId: string | null
  appliedVersionId: string | null
  activeVersionLabel: string | null
  activeVersionCreatedAt: Date | string | null
  draftManifestVersion: string
  draftAppliedAt: Date | string | null
}

/** Concurrent activate may replay only when the live version row is the one this draft applied. */
export function appliedDraftStillCurrent(state: AppliedDraftInstallState): boolean {
  if (!state.activeVersionId || !state.appliedVersionId) return false
  if (state.activeVersionId !== state.appliedVersionId) return false
  if (!state.activeVersionLabel || state.activeVersionLabel !== state.draftManifestVersion) return false
  if (!state.activeVersionCreatedAt || !state.draftAppliedAt) return false
  const created = new Date(state.activeVersionCreatedAt).getTime()
  const applied = new Date(state.draftAppliedAt).getTime()
  if (!Number.isFinite(created) || !Number.isFinite(applied)) return false
  return created <= applied
}

/** Keep the manifest in the file browser without duplicating its stored representation. */
export function packageSourceFiles(
  bundle: EditableAppPackage,
): AppPackageFile[] {
  return [
    {
      path: 'manifest.json',
      content: JSON.stringify(bundle.manifest, null, 2),
    },
    ...bundle.files,
  ]
}

export function packageFromSourceFiles(
  files: AppPackageFile[],
  grantedPermissions?: string[],
): EditableAppPackage {
  const manifestFile = files.find((file) => file.path === 'manifest.json')
  if (!manifestFile || manifestFile.isBinary)
    throw new Error('The package needs a text manifest.json file.')
  const manifest: unknown = JSON.parse(manifestFile.content)
  const parsed = parseManifest(manifest)
  if (!parsed.ok) throw new Error(parsed.errors.join('; '))
  const references = validateBundle(
    parsed.manifest!,
    files
      .filter((file) => file.path !== 'manifest.json')
      .map((file) => file.path),
  )
  if (!references.ok) throw new Error(references.errors.join('; '))
  if (new Set(files.map((file) => file.path)).size !== files.length)
    throw new Error('Every file needs a unique path.')
  if (
    files.some(
      (file) => file.path !== 'manifest.json' && !validPackagePath(file.path),
    )
  )
    throw new Error(PACKAGE_PATH_REFUSAL)
  return {
    manifest,
    files: files.filter((file) => file.path !== 'manifest.json'),
    ...(grantedPermissions ? { grantedPermissions } : {}),
  }
}

/** Suggest a fresh patch label without mutating an installed version. */
export function nextAppVersion(version: string): string {
  const [major = '1', minor = '0', patch = '0'] = version
    .split('-')[0]!
    .split('.')
  return `${major}.${minor}.${BigInt(patch) + 1n}`
}
