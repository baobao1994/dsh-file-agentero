/**
 * dsh-file-agentero — versions and updates.
 *
 * Works out how this profile installed the package (the plugin manager's
 * `source` spec), asks the registry that install actually came from for the
 * newest release, and — when the user asks — reinstalls it through the DSH
 * plugin manager. A linked or local checkout is never offered an update: it is
 * updated where it lives, not from the registry.
 *
 * The version list merges what the registry has published (version + date)
 * with the notes in this package's CHANGELOG.md, so the card can show a small
 * version history without another network call.
 *
 * No dependency on any @deepseek-ai package: node builtins + global fetch.
 */

import { readFileSync } from 'node:fs'

/** The two files this service reads: its own manifest and its packaged notes. */
const PACKAGE_URL = new URL('./package.json', import.meta.url)
const CHANGELOG_URL = new URL('./CHANGELOG.md', import.meta.url)

/** A release version without its `v` and build metadata. */
const VERSION_RE = /^v?(\d+\.\d+\.\d+(?:-[\w.]+)?)(?:\+[\w.]+)?$/

/** Read package.json afresh; a malformed file falls back to an empty record. */
function readPackage() {
  try {
    const value = JSON.parse(readFileSync(PACKAGE_URL, 'utf8'))
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

/** Boot-time copy, kept only as the fallback for the live readers below. */
const PKG = readPackage()

/** Package name, and the version this checkout carried when the module loaded. */
export const PACKAGE_NAME = typeof PKG.name === 'string' && PKG.name !== '' ? PKG.name : 'dsh-file-agentero'
export const PACKAGE_VERSION = cleanVersion(PKG.version) ?? '0.0.0'

/**
 * The version the checkout carries right now.
 *
 * Read on every request instead of once at import: a linked checkout is edited
 * in place, and a host plugin reload does not necessarily re-import this module.
 * That is exactly how a local 0.1.1 edit kept reporting 0.1.0 on screen.
 */
export function currentVersion() {
  return cleanVersion(readPackage().version) ?? PACKAGE_VERSION
}

/** Registries the DSH plugin manager installs from, in its order. */
const PUBLIC_REGISTRIES = ['https://registry.npmjs.org/', 'https://registry.npmmirror.com/']

/** How long one answer stands before a check asks again. */
const CHECK_TTL_MS = 10 * 60_000
const VERSIONS_TTL_MS = 10 * 60_000

/** One registry request. */
const FETCH_TIMEOUT_MS = 8_000

/** At most this many versions are listed in the card. */
const VERSION_LIMIT = 40

/** A release version without its `v` and build metadata, or null. */
export function cleanVersion(value) {
  return VERSION_RE.exec(String(value ?? '').trim())?.[1] ?? null
}

/** Whether version `a` is newer than `b` (semver order; prerelease before release). */
export function isNewer(a, b) {
  const parse = (value) => {
    const [core, pre] = (cleanVersion(value) ?? '0.0.0').split(/-(.*)/s)
    return { nums: core.split('.').map(Number), pre: pre ?? null }
  }
  const x = parse(a)
  const y = parse(b)
  for (let index = 0; index < 3; index += 1) {
    if (x.nums[index] !== y.nums[index]) return x.nums[index] > y.nums[index]
  }
  if (x.pre === y.pre) return false
  if (x.pre === null) return true
  if (y.pre === null) return false
  return x.pre.localeCompare(y.pre, 'en', { numeric: true }) > 0
}

/** Scoped names keep their `@` readable for the registry. */
const encodeName = (name) => (name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name))

const normalizeRegistry = (url) => `${String(url).trim().replace(/\/+$/, '')}/`

/**
 * How the profile installed this package, from the plugin manager's spec:
 * `registry` (name@range), `git`, `tarball`, `local` (link:/file:/folder) or
 * `unknown`.
 */
export function sourceKind(spec) {
  const text = typeof spec === 'string' ? spec.trim() : ''
  if (text === '') return 'unknown'
  if (/^(link|file):/i.test(text) || /^([a-z]:[\\/]|[\\/]|~|\.)/i.test(text)) return 'local'
  if (/^(git\+|git:|git@|github:|gitlab:|bitbucket:)/i.test(text) || /\.git(#|$)/i.test(text)) return 'git'
  if (/^https?:/i.test(text)) return 'tarball'
  return 'registry'
}

/** Parse `## [1.2.3] - 2026-11-10` sections (and their bullets) from CHANGELOG.md. */
export function readChangelog() {
  const sections = new Map()
  let text
  try {
    text = readFileSync(CHANGELOG_URL, 'utf8')
  } catch {
    return sections
  }
  let current = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const head = /^##\s+\[?v?([0-9][\w.\-+]*)\]?\s*(?:[-–—]\s*(\d{4}-\d{2}-\d{2}))?\s*$/.exec(line)
    if (head !== null) {
      current = { version: head[1], date: head[2] ?? '', notes: [] }
      sections.set(current.version, current)
      continue
    }
    if (current === null) continue
    if (/^##\s/.test(line)) {
      current = null
      continue
    }
    const item = /^[-*]\s+(.+)$/.exec(line)
    if (item !== null) current.notes.push(item[1])
  }
  return sections
}

/** One JSON answer, with the HTTP status kept for 404 handling. */
async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': `${PACKAGE_NAME}/${PACKAGE_VERSION}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    const error = new Error(`${url} answered ${response.status}`)
    error.status = response.status
    throw error
  }
  return response.json()
}

/**
 * Build the version/update service for one host plugin context.
 * @param {object} options
 * @param {object} options.ctx - host plugin context (for `pluginManager`).
 * @param {(message: string) => void} [options.warn] - diagnostics sink.
 */
export function createUpdater({ ctx, warn } = {}) {
  let changelog = readChangelog()
  let changelogSignature = ''
  let versionsCache = { at: 0, value: null }
  /** Re-read the packaged notes, so an edited CHANGELOG shows up on the next check. */
  const reloadChangelog = () => {
    changelog = readChangelog()
    const signature = [...changelog.values()]
      .map((entry) => `${entry.version}:${entry.date}:${entry.notes.join('\u0001')}`)
      .join('\u0002')
    if (signature !== changelogSignature) {
      changelogSignature = signature
      versionsCache = { at: 0, value: null }
    }
    return changelog
  }

  const status = {
    current: currentVersion(),
    latest: null,
    source: 'unknown',
    mode: 'unknown',
    published: null,
    checkedAt: 0,
    phase: 'idle',
    installed: null,
    error: null,
    registryError: null,
  }

  /** Where the newest release was found, and the spec that installs it. */
  let target = null
  let checking = null

  const manager = () => ctx.get?.('pluginManager')
  const note = (message, error) => {
    try {
      warn?.(`${PACKAGE_NAME}: ${message}: ${error?.message ?? error}`)
    } catch {
      // A broken logger must not break an update check.
    }
  }

  /** The plugin manager's `source` for this package, else the profile's dependency. */
  async function installSpec() {
    const service = manager()
    const bundles = await Promise.resolve(service?.listBundles?.()).catch(() => null)
    const own = Array.isArray(bundles) ? bundles.find((bundle) => bundle?.name === PACKAGE_NAME) : undefined
    if (typeof own?.source === 'string') return own.source
    const dir = ctx.get?.('profileContext')?.dir
    if (typeof dir !== 'string') return undefined
    try {
      return JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'))?.dependencies?.[PACKAGE_NAME]
    } catch {
      return undefined
    }
  }

  /** The registries to ask, in the plugin manager's order. */
  async function registryPlan() {
    const configured = await Promise.resolve(manager()?.registries?.()).catch(() => null)
    if (configured === null || configured === undefined) return PUBLIC_REGISTRIES
    const fallbacks = (configured.fallbackRegistries ?? []).map(normalizeRegistry)
    const own = configured.resolved ? normalizeRegistry(configured.resolved) : null
    const first = configured.registry ? normalizeRegistry(configured.registry) : own ?? PUBLIC_REGISTRIES[0]
    const isPublic = first === PUBLIC_REGISTRIES[0] || fallbacks.includes(first)
    return isPublic ? [...new Set([first, ...fallbacks, ...PUBLIC_REGISTRIES])] : [first]
  }

  const notesOf = (version) => changelog.get(version)?.notes ?? []

  /** The public repository, for release notes written outside the changelog. */
  function repoSlug() {
    const meta = readPackage()
    const match = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/i.exec(
      String(meta.repository?.url ?? meta.repository ?? ''),
    )
    return match === null ? null : match[1]
  }
  const repoUrl = () => {
    const slug = repoSlug()
    return slug === null ? null : `https://github.com/${slug}`
  }
  const notesUrlOf = (version) => {
    const repo = repoUrl()
    return repo === null || version === null ? null : `${repo}/releases/tag/v${version}`
  }

  /** Ask the registry for its newest release; null when it has none yet. */
  async function newestFromRegistry() {
    for (const registry of await registryPlan()) {
      try {
        const reply = await fetchJson(`${registry}${encodeName(PACKAGE_NAME)}/latest`)
        const version = cleanVersion(reply?.version)
        if (version !== null) {
          status.published = true
          status.registryError = null
          return { version, spec: `${PACKAGE_NAME}@${version}`, registry }
        }
      } catch (error) {
        // A package that is not published yet answers 404: that is an answer.
        if (error?.status === 404) {
          status.published = false
          return null
        }
        status.registryError = String(error?.message ?? error).slice(0, 300)
        note('registry unreachable', error)
      }
    }
    return null
  }

  async function runCheck() {
    status.current = currentVersion()
    reloadChangelog()
    const spec = await installSpec()
    status.source = spec ?? 'unknown'
    status.mode = sourceKind(spec)
    status.registryError = null
    let found = null
    if (status.mode === 'registry') {
      try {
        found = await newestFromRegistry()
      } catch (error) {
        note('update check failed', error)
      }
    }
    status.checkedAt = Date.now()
    if (found === null) {
      status.latest = null
      target = null
      return
    }
    status.latest = found.version
    target = isNewer(found.version, status.current) ? found : null
  }

  /** Current status; a fresh call ignores the last answer. */
  async function check({ fresh = false } = {}) {
    if (checking !== null) return checking
    if (!fresh && Date.now() - status.checkedAt < CHECK_TTL_MS && status.checkedAt > 0) return view()
    checking = runCheck().finally(() => {
      checking = null
    })
    await checking
    return view()
  }

  /** Published versions, newest first, each with the notes from CHANGELOG.md. */
  async function versions({ fresh = false } = {}) {
    status.current = currentVersion()
    reloadChangelog()
    if (!fresh && versionsCache.value !== null && Date.now() - versionsCache.at < VERSIONS_TTL_MS) {
      return versionsCache.value
    }
    for (const registry of await registryPlan()) {
      try {
        const doc = await fetchJson(`${registry}${encodeName(PACKAGE_NAME)}`)
        const time = doc?.time ?? {}
        const sizes = doc?.versions ?? {}
        const list = Object.keys(sizes)
          .map((version) => ({
            version,
            date: typeof time[version] === 'string' ? time[version] : '',
            deprecated: typeof sizes[version]?.deprecated === 'string' ? sizes[version].deprecated : null,
            notes: notesOf(version),
          }))
          .sort((a, b) => (isNewer(a.version, b.version) ? -1 : isNewer(b.version, a.version) ? 1 : 0))
        const value = {
          registry,
          current: status.current,
          latest: typeof doc?.['dist-tags']?.latest === 'string' ? doc['dist-tags'].latest : null,
          versions: list.slice(0, VERSION_LIMIT),
        }
        versionsCache = { at: Date.now(), value }
        return value
      } catch (error) {
        note('version list failed', error)
        // Not published yet (or gone): the other registry would answer the same.
        if (error?.status === 404) break
      }
    }
    // Offline or not published yet: the packaged changelog still knows the history.
    const fromNotes = [...changelog.values()]
      .map((entry) => ({ version: entry.version, date: entry.date, deprecated: null, notes: entry.notes }))
      .sort((a, b) => (isNewer(a.version, b.version) ? -1 : isNewer(b.version, a.version) ? 1 : 0))
    const value = { registry: null, current: status.current, latest: null, versions: fromNotes.slice(0, VERSION_LIMIT) }
    versionsCache = { at: Date.now(), value }
    return value
  }

  /** Start reinstalling the newest release; the answer comes back through `check`. */
  function start() {
    if (status.phase === 'installing') return view()
    if (target === null) throw new Error('no update available')
    const service = manager()
    if (typeof service?.installBundle !== 'function') throw new Error('the DSH plugin manager is not available in this profile')
    const chosen = target
    status.phase = 'installing'
    status.error = null
    void Promise.resolve(service.installBundle(chosen.spec, chosen.registry ? { registry: chosen.registry } : {}))
      .then((result) => {
        if (result?.error || !['applied', 'restart-required'].includes(result?.application)) {
          throw new Error(result?.error?.diagnostic ?? result?.error?.code ?? `install ${result?.application ?? 'failed'}`)
        }
        status.installed = cleanVersion(result.version) ?? chosen.version
        status.current = status.installed
        status.latest = status.installed
        status.phase = 'installed'
        status.checkedAt = Date.now()
        target = null
        versionsCache = { at: 0, value: null }
      })
      .catch((error) => {
        note('update failed', error)
        status.phase = 'failed'
        status.error = String(error?.message ?? error).slice(0, 400)
      })
    return view()
  }

  /** What the browser half renders. */
  function view() {
    return {
      success: true,
      name: PACKAGE_NAME,
      current: status.current,
      latest: status.latest,
      available: target !== null && status.latest !== null && isNewer(status.latest, status.current),
      mode: status.mode,
      source: status.source,
      published: status.published,
      phase: status.phase,
      installed: status.installed,
      error: status.error,
      registryError: status.registryError,
      checkedAt: status.checkedAt,
      repoUrl: repoUrl(),
      notesUrl: notesUrlOf(status.latest),
    }
  }

  return { check, versions, start, view }
}
