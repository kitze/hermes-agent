import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import { lookup } from 'node:dns/promises'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const CHROME_EXECUTABLE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const MAX_SESSION_ID_CHARS = 256
const MAX_COMMAND_ID_CHARS = 128
const MAX_ARGUMENT_TEXT_CHARS = 20_000
const MAX_BROWSER_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_SNAPSHOT_CHARS = 50_000
const MAX_PROFILE_FILES = 50_000
const MAX_PROFILE_BYTES = 768 * 1024 * 1024
const COMMAND_TIMEOUT_MS = 24_000

export const DESKTOP_BROWSER_CONTROLLER_CAPABILITIES = Object.freeze([
  'controller.noop',
  'browser_back',
  'browser_click',
  'browser_navigate',
  'browser_press',
  'browser_scroll',
  'browser_snapshot',
  'browser_type'
])

const SQLITE_AUTH_FILES = new Set(['Cookies', 'Login Data', 'Login Data For Account', 'Web Data'])

const AUTH_REFRESH_FILES = [
  'Cookies',
  'Network/Cookies',
  'Login Data',
  'Login Data For Account',
  'Web Data',
  'Preferences'
]

interface IpcMainLike {
  handle: (channel: string, handler: (event: any, payload?: any) => any) => void
}

interface BrowserControllerDeps {
  agentBrowserExecutable?: string
  chromeExecutable?: string
  homeDir: string
  userDataDir: string
  hostname?: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  log?: (line: string) => void
}

interface ActiveChromeProfile {
  browserProfileId: string
  name: string
  root: string
  sourceDir: string
}

interface BrowserSession {
  activeProfile: ActiveChromeProfile
  agentSession: string
  browserProfileId: string
  controllerId: string
  disposed: boolean
  gatewayInstanceId: string
  ownerId: number
  queue: Promise<unknown>
  sessionId: string
  snapshotDir: string
  snapshotReady: boolean
}

interface RunningCommand {
  child: ChildProcess
  commandKey: string
  gatewayInstanceId: string
  ownerId: number
  sessionKey: string
}

interface AgentBrowserResult {
  success: boolean
  data?: Record<string, any>
  error?: string | null
}

export interface BrowserControllerPrepareResult {
  available: boolean
  browserProfileId?: string
  capabilities?: string[]
  controllerId?: string
  error?: string
}

export interface BrowserControllerExecutionResult {
  error?: { code: string; message: string }
  ok: boolean
  result?: Record<string, unknown>
}

function shortDigest(value: string, length = 24): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, length)
}

function hasControlCharacter(value: string): boolean {
  return [...value].some(character => {
    const code = character.charCodeAt(0)

    return code <= 31 || code === 127
  })
}

function normalizeSessionId(value: unknown): string {
  const sessionId = String(value ?? '').trim()

  if (!sessionId || sessionId.length > MAX_SESSION_ID_CHARS || hasControlCharacter(sessionId)) {
    throw new Error('Invalid browser-controller session id')
  }

  return sessionId
}

function normalizeCommandId(value: unknown): string {
  const commandId = String(value ?? '').trim()

  if (!commandId || commandId.length > MAX_COMMAND_ID_CHARS || !/^[a-zA-Z0-9_-]+$/.test(commandId)) {
    throw new Error('Invalid browser-controller command id')
  }

  return commandId
}

function normalizeGatewayInstanceId(value: unknown): string {
  const gatewayInstanceId = String(value ?? '').trim()

  if (
    !gatewayInstanceId ||
    gatewayInstanceId.length > MAX_COMMAND_ID_CHARS ||
    !/^[a-zA-Z0-9_-]+$/.test(gatewayInstanceId)
  ) {
    throw new Error('Invalid browser-controller gateway instance id')
  }

  return gatewayInstanceId
}

function ownerKey(ownerId: number, gatewayInstanceId: string, sessionId: string): string {
  return `${ownerId}\u0000${gatewayInstanceId}\u0000${sessionId}`
}

function commandKey(ownerId: number, gatewayInstanceId: string, sessionId: string, commandId: string): string {
  return `${ownerKey(ownerId, gatewayInstanceId, sessionId)}\u0000${commandId}`
}

function controllerIdFor(hostname: string, userDataDir: string, ownerId: number, gatewayInstanceId: string): string {
  return `desktop-chrome:${shortDigest(
    `${hostname}\u0000${userDataDir}\u0000${ownerId}\u0000${gatewayInstanceId}`,
    32
  )}`
}

function safeProfileName(value: unknown, chromeRoot: string): string {
  const requested = typeof value === 'string' && value.trim() ? value.trim() : 'Default'
  const resolved = path.resolve(chromeRoot, requested)

  if (path.dirname(resolved) !== path.resolve(chromeRoot) || !fs.existsSync(resolved)) {
    return 'Default'
  }

  try {
    return fs.statSync(resolved).isDirectory() ? requested : 'Default'
  } catch {
    return 'Default'
  }
}

export function resolveActiveChromeProfile(
  homeDir: string,
  chromeExecutable = CHROME_EXECUTABLE
): ActiveChromeProfile | null {
  const root = path.join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome')

  if (!fs.existsSync(root) || !fs.existsSync(chromeExecutable)) {
    return null
  }

  let lastUsed: unknown = 'Default'

  try {
    const localState = JSON.parse(fs.readFileSync(path.join(root, 'Local State'), 'utf8'))
    lastUsed = localState?.profile?.last_used
  } catch {
    lastUsed = 'Default'
  }

  const name = safeProfileName(lastUsed, root)
  const sourceDir = path.join(root, name)

  if (!fs.existsSync(sourceDir)) {
    return null
  }

  return {
    browserProfileId: `chrome:${shortDigest(`${root}\u0000${name}`, 32)}`,
    name,
    root,
    sourceDir
  }
}

function pathInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))

  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function ignoredProfileEntry(relativePath: string, name: string): boolean {
  const normalized = relativePath.split(path.sep).join('/')

  if (SQLITE_AUTH_FILES.has(name)) {
    return true
  }

  return (
    name.includes('Cache') ||
    name.startsWith('Extension') ||
    name.startsWith('History') ||
    name.startsWith('Favicons') ||
    name.startsWith('Singleton') ||
    name.startsWith('BrowserMetrics') ||
    name.startsWith('OptimizationGuide') ||
    name.endsWith('.tmp') ||
    name.endsWith('-journal') ||
    name.endsWith('-wal') ||
    name.endsWith('-shm') ||
    normalized === 'Extensions' ||
    normalized === 'Local Extension Settings' ||
    normalized === 'Service Worker' ||
    normalized === 'IndexedDB' ||
    normalized === 'Crash Reports' ||
    normalized === 'Crashpad' ||
    normalized === 'Snapshots' ||
    normalized === 'Safe Browsing' ||
    normalized === 'SafetyTips' ||
    normalized === 'OnDeviceHeadSuggestModel' ||
    normalized === 'segmentation_platform' ||
    normalized === 'Sync Data' ||
    normalized === 'Shared Dictionary' ||
    normalized === 'optimization_guide_model_store' ||
    normalized === 'RunningChromeVersion'
  )
}

async function copyProfileTree(sourceRoot: string, destinationRoot: string): Promise<void> {
  let files = 0
  let bytes = 0

  async function copyDirectory(source: string, destination: string, relativeRoot: string): Promise<void> {
    await fs.promises.mkdir(destination, { recursive: true, mode: 0o700 })
    await fs.promises.chmod(destination, 0o700)

    const entries = await fs.promises.readdir(source, { withFileTypes: true })

    for (const entry of entries) {
      const relativePath = relativeRoot ? path.join(relativeRoot, entry.name) : entry.name

      if (ignoredProfileEntry(relativePath, entry.name)) {
        continue
      }

      const sourcePath = path.join(source, entry.name)
      const destinationPath = path.join(destination, entry.name)

      if (entry.isSymbolicLink()) {
        continue
      }

      if (entry.isDirectory()) {
        await copyDirectory(sourcePath, destinationPath, relativePath)

        continue
      }

      if (!entry.isFile()) {
        continue
      }

      const stat = await fs.promises.stat(sourcePath)
      files += 1
      bytes += stat.size

      if (files > MAX_PROFILE_FILES || bytes > MAX_PROFILE_BYTES) {
        throw new Error('The active Chrome profile snapshot exceeded its safety limit')
      }

      await fs.promises.copyFile(sourcePath, destinationPath)
      await fs.promises.chmod(destinationPath, 0o600)
    }
  }

  await copyDirectory(sourceRoot, destinationRoot, '')
}

function sqliteBackup(source: string, destination: string): boolean {
  if (!fs.existsSync(source)) {
    return true
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })

  try {
    fs.rmSync(destination, { force: true })
  } catch {
    return false
  }

  const escapedDestination = destination.replaceAll("'", "''")

  const result = spawnSync('/usr/bin/sqlite3', [source, `.timeout 5000`, `.backup '${escapedDestination}'`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 8_000
  })

  if (result.status === 0 && fs.existsSync(destination)) {
    fs.chmodSync(destination, 0o600)

    return true
  }

  try {
    fs.copyFileSync(source, destination)
    fs.chmodSync(destination, 0o600)

    return true
  } catch {
    return false
  }
}

async function refreshProfileAuth(active: ActiveChromeProfile, snapshotDir: string): Promise<void> {
  const destinationProfile = path.join(snapshotDir, 'Default')

  for (const relativePath of AUTH_REFRESH_FILES) {
    const source = path.join(active.sourceDir, relativePath)

    if (!fs.existsSync(source)) {
      continue
    }

    const destination = path.join(destinationProfile, relativePath)

    if (SQLITE_AUTH_FILES.has(path.basename(relativePath))) {
      if (!sqliteBackup(source, destination)) {
        throw new Error('Chrome login data could not be copied safely')
      }

      continue
    }

    await fs.promises.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
    await fs.promises.copyFile(source, destination)
    await fs.promises.chmod(destination, 0o600)
  }
}

function executableOnPath(command: string, env: NodeJS.ProcessEnv): string | null {
  const candidates = [
    '/opt/homebrew/bin/agent-browser',
    '/usr/local/bin/agent-browser',
    ...String(env.PATH || '')
      .split(path.delimiter)
      .filter(Boolean)
      .map(directory => path.join(directory, command))
  ]

  for (const candidate of [...new Set(candidates)]) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)

      return candidate
    } catch {
      // Try the next fixed or PATH candidate.
    }
  }

  return null
}

function isBlockedIpv4(address: string): boolean {
  const octets = address.split('.').map(Number)

  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
    return true
  }

  const [a, b, c] = octets

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 169 && b === 254 && c === 169)
  )
}

function isBlockedIp(address: string): boolean {
  const family = net.isIP(address)

  if (family === 4) {
    return isBlockedIpv4(address)
  }

  if (family !== 6) {
    return true
  }

  const normalized = address.toLowerCase().split('%')[0]

  if (normalized.startsWith('::ffff:')) {
    return isBlockedIpv4(normalized.slice('::ffff:'.length))
  }

  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('ff')
  )
}

export async function assertPublicBrowserUrl(value: unknown): Promise<string> {
  const raw = String(value ?? '').trim()

  if (!raw || raw.length > 8_192) {
    throw new Error('A valid public browser URL is required')
  }

  let parsed: URL

  try {
    parsed = new URL(raw.includes('://') ? raw : `https://${raw}`)
  } catch {
    throw new Error('A valid public browser URL is required')
  }

  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Only public http/https browser URLs are allowed')
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '')

  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('Private or local browser addresses are blocked')
  }

  const addresses = net.isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true, verbatim: true })

  if (addresses.length === 0 || addresses.some(item => isBlockedIp(item.address))) {
    throw new Error('Private or local browser addresses are blocked')
  }

  return parsed.toString()
}

function boundedText(value: unknown, max = MAX_ARGUMENT_TEXT_CHARS): string {
  const text = String(value ?? '')

  if (text.length > max || text.includes(String.fromCharCode(0))) {
    throw new Error('Browser command text exceeded its safety limit')
  }

  return text
}

function normalizeRef(value: unknown): string {
  const ref = boundedText(value, 128).trim()
  const normalized = ref.startsWith('@') ? ref : `@${ref}`

  if (!/^@e[0-9]+$/i.test(normalized)) {
    throw new Error('A valid browser element reference is required')
  }

  return normalized
}

function safeErrorMessage(value: unknown): string {
  const message = (value instanceof Error ? value.message : String(value ?? 'Browser command failed'))
    .replaceAll(os.homedir(), '<home>')
    .replace(/[A-Za-z0-9_-]{32,}/g, '<redacted>')
    .slice(0, 2_048)

  return message || 'Browser command failed'
}

function browserEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}

  for (const key of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SHELL']) {
    if (source[key]) {
      env[key] = source[key]
    }
  }

  env.PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', String(source.PATH || '')]
    .filter(Boolean)
    .join(path.delimiter)
  env.AGENT_BROWSER_MAX_OUTPUT = String(MAX_SNAPSHOT_CHARS)
  env.AGENT_BROWSER_IDLE_TIMEOUT_MS = '900000'

  return env
}

function parseAgentBrowserOutput(stdout: string): AgentBrowserResult {
  if (Buffer.byteLength(stdout, 'utf8') > MAX_BROWSER_OUTPUT_BYTES) {
    throw new Error('Browser command returned too much data')
  }

  const lines = stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index])

      if (parsed && typeof parsed === 'object' && typeof parsed.success === 'boolean') {
        return parsed
      }
    } catch {
      // Keep looking for the final JSON payload.
    }
  }

  throw new Error('Browser command returned an invalid response')
}

export class DesktopBrowserProfileController {
  private readonly agentBrowserExecutable: string | null
  private readonly chromeExecutable: string
  private readonly deps: Required<Omit<BrowserControllerDeps, 'agentBrowserExecutable' | 'chromeExecutable'>>
  private readonly managedRoot: string
  private readonly sessions = new Map<string, BrowserSession>()
  private readonly running = new Map<string, RunningCommand>()

  constructor(deps: BrowserControllerDeps) {
    this.deps = {
      hostname: deps.hostname || os.hostname(),
      platform: deps.platform || process.platform,
      env: deps.env || process.env,
      log: deps.log || (() => undefined),
      homeDir: deps.homeDir,
      userDataDir: deps.userDataDir
    }
    this.agentBrowserExecutable = deps.agentBrowserExecutable || null
    this.chromeExecutable = deps.chromeExecutable || CHROME_EXECUTABLE
    this.managedRoot = path.join(this.deps.userDataDir, 'browser-profile-controller')
  }

  prepare(ownerId: number, payload: any): BrowserControllerPrepareResult {
    try {
      if (this.deps.platform !== 'darwin') {
        return { available: false, error: 'Desktop Chrome profile control is currently available on macOS only' }
      }

      const gatewayInstanceId = normalizeGatewayInstanceId(payload?.gatewayInstanceId)
      const sessionId = normalizeSessionId(payload?.sessionId)
      const activeProfile = resolveActiveChromeProfile(this.deps.homeDir, this.chromeExecutable)
      const agentBrowser = this.resolveAgentBrowserExecutable()

      if (!activeProfile) {
        return { available: false, error: 'Google Chrome or its active profile was not found on this Mac' }
      }

      if (!agentBrowser) {
        return { available: false, error: 'agent-browser 0.26 is not installed on this Mac' }
      }

      const key = ownerKey(ownerId, gatewayInstanceId, sessionId)
      const existing = this.sessions.get(key)

      if (existing && !existing.disposed) {
        return {
          available: true,
          browserProfileId: existing.browserProfileId,
          capabilities: [...DESKTOP_BROWSER_CONTROLLER_CAPABILITIES],
          controllerId: existing.controllerId
        }
      }

      const controllerId = controllerIdFor(this.deps.hostname, this.deps.userDataDir, ownerId, gatewayInstanceId)
      const stableId = shortDigest(`${controllerId}\u0000${sessionId}`, 32)
      const snapshotDir = path.join(this.managedRoot, stableId)

      const session: BrowserSession = {
        activeProfile,
        agentSession: `hermes_desktop_${stableId.slice(0, 24)}`,
        browserProfileId: activeProfile.browserProfileId,
        controllerId,
        disposed: false,
        gatewayInstanceId,
        ownerId,
        queue: Promise.resolve(),
        sessionId,
        snapshotDir,
        snapshotReady: false
      }

      this.sessions.set(key, session)

      return {
        available: true,
        browserProfileId: session.browserProfileId,
        capabilities: [...DESKTOP_BROWSER_CONTROLLER_CAPABILITIES],
        controllerId: session.controllerId
      }
    } catch (error) {
      return { available: false, error: safeErrorMessage(error) }
    }
  }

  async execute(ownerId: number, payload: any): Promise<BrowserControllerExecutionResult> {
    let session: BrowserSession
    let commandId: string

    try {
      const sessionId = normalizeSessionId(payload?.sessionId)
      const gatewayInstanceId = normalizeGatewayInstanceId(payload?.gatewayInstanceId)
      commandId = normalizeCommandId(payload?.commandId)
      session = this.sessions.get(ownerKey(ownerId, gatewayInstanceId, sessionId))

      if (
        !session ||
        session.disposed ||
        session.ownerId !== ownerId ||
        session.gatewayInstanceId !== gatewayInstanceId
      ) {
        throw new Error('This Desktop browser session is not prepared for the requesting window')
      }
    } catch (error) {
      return { ok: false, error: { code: 'invalid_request', message: safeErrorMessage(error) } }
    }

    const work = session.queue.then(() => this.executeSerial(session, commandId, payload?.action, payload?.arguments))
    session.queue = work.catch(() => undefined)

    try {
      return await work
    } catch (error) {
      return { ok: false, error: { code: 'browser_command_failed', message: safeErrorMessage(error) } }
    }
  }

  cancel(ownerId: number, payload: any): { cancelled: boolean } {
    try {
      const gatewayInstanceId = normalizeGatewayInstanceId(payload?.gatewayInstanceId)
      const sessionId = normalizeSessionId(payload?.sessionId)
      const commandId = normalizeCommandId(payload?.commandId)
      const key = commandKey(ownerId, gatewayInstanceId, sessionId, commandId)
      const running = this.running.get(key)

      if (
        !running ||
        running.ownerId !== ownerId ||
        running.gatewayInstanceId !== gatewayInstanceId ||
        running.commandKey !== key
      ) {
        return { cancelled: false }
      }

      running.child.kill('SIGKILL')
      this.running.delete(key)
      const session = this.sessions.get(running.sessionKey)

      if (session) {
        void this.closeSession(session)
      }

      return { cancelled: true }
    } catch {
      return { cancelled: false }
    }
  }

  async dispose(ownerId: number, payload: any): Promise<{ disposed: boolean }> {
    let sessionId: string
    let gatewayInstanceId: string

    try {
      gatewayInstanceId = normalizeGatewayInstanceId(payload?.gatewayInstanceId)
      sessionId = normalizeSessionId(payload?.sessionId)
    } catch {
      return { disposed: false }
    }

    const key = ownerKey(ownerId, gatewayInstanceId, sessionId)
    const session = this.sessions.get(key)

    if (!session) {
      return { disposed: false }
    }

    session.disposed = true
    this.sessions.delete(key)

    for (const [runningKey, running] of this.running) {
      if (running.sessionKey === key) {
        running.child.kill('SIGKILL')
        this.running.delete(runningKey)
      }
    }

    await this.closeSession(session)
    this.removeSnapshot(session.snapshotDir)

    return { disposed: true }
  }

  async disposeOwner(ownerId: number): Promise<void> {
    const sessions = [...this.sessions.values()].filter(session => session.ownerId === ownerId)

    await Promise.allSettled(
      sessions.map(session =>
        this.dispose(ownerId, {
          gatewayInstanceId: session.gatewayInstanceId,
          sessionId: session.sessionId
        })
      )
    )
  }

  disposeAllSync(): void {
    for (const running of this.running.values()) {
      try {
        running.child.kill('SIGKILL')
      } catch {
        // Best-effort shutdown.
      }
    }

    this.running.clear()

    for (const session of this.sessions.values()) {
      session.disposed = true
      this.closeSessionSync(session)
      this.removeSnapshot(session.snapshotDir)
    }

    this.sessions.clear()
  }

  cleanupStaleSnapshotsSync(): void {
    if (this.sessions.size > 0 || !fs.existsSync(this.managedRoot)) {
      return
    }

    const executable = this.resolveAgentBrowserExecutable()

    if (executable) {
      try {
        for (const entry of fs.readdirSync(this.managedRoot, { withFileTypes: true })) {
          if (!entry.isDirectory() || !/^[a-f0-9]{32}$/.test(entry.name)) {
            continue
          }

          spawnSync(executable, ['--session', `hermes_desktop_${entry.name.slice(0, 24)}`, 'close'], {
            env: browserEnv(this.deps.env),
            stdio: 'ignore',
            timeout: 5_000
          })
        }
      } catch {
        // Removing the copied credential store below still fails closed.
      }
    }

    try {
      fs.rmSync(this.managedRoot, { force: true, recursive: true })
    } catch {
      // The next snapshot creation retries owner-only cleanup.
    }
  }

  private async ensureSnapshot(session: BrowserSession): Promise<void> {
    if (session.snapshotReady) {
      return
    }

    if (!pathInside(this.managedRoot, session.snapshotDir)) {
      throw new Error('Refusing an unsafe browser snapshot path')
    }

    await this.closeSession(session)
    this.removeSnapshot(session.snapshotDir)
    await fs.promises.mkdir(this.managedRoot, { recursive: true, mode: 0o700 })
    await fs.promises.chmod(this.managedRoot, 0o700)
    await fs.promises.mkdir(session.snapshotDir, { recursive: true, mode: 0o700 })
    await fs.promises.chmod(session.snapshotDir, 0o700)

    const localStateSource = path.join(session.activeProfile.root, 'Local State')

    if (fs.existsSync(localStateSource)) {
      const localStateDestination = path.join(session.snapshotDir, 'Local State')
      await fs.promises.copyFile(localStateSource, localStateDestination)
      await fs.promises.chmod(localStateDestination, 0o600)
    }

    await copyProfileTree(session.activeProfile.sourceDir, path.join(session.snapshotDir, 'Default'))
    await refreshProfileAuth(session.activeProfile, session.snapshotDir)
    await fs.promises.writeFile(path.join(session.snapshotDir, '.hermes-snapshot-complete'), 'active-profile\n', {
      mode: 0o600
    })

    session.snapshotReady = true
    this.deps.log(
      `[browser-controller] prepared owner=${session.ownerId} session=${shortDigest(session.sessionId, 12)}`
    )
  }

  private async executeSerial(
    session: BrowserSession,
    commandId: string,
    rawAction: unknown,
    rawArguments: unknown
  ): Promise<BrowserControllerExecutionResult> {
    if (session.disposed) {
      throw new Error('Desktop browser session was closed')
    }

    const action = String(rawAction ?? '')
    const arguments_ = rawArguments && typeof rawArguments === 'object' ? (rawArguments as Record<string, unknown>) : {}

    if (!DESKTOP_BROWSER_CONTROLLER_CAPABILITIES.includes(action)) {
      return { ok: false, error: { code: 'unsupported_action', message: 'Browser action is not permitted' } }
    }

    if (action === 'controller.noop') {
      return { ok: true, result: { ok: true, source: 'desktop-chrome' } }
    }

    await this.ensureSnapshot(session)

    switch (action) {
      case 'browser_navigate':
        return { ok: true, result: await this.navigate(session, commandId, arguments_.url) }

      case 'browser_snapshot':
        await this.assertCurrentPageSafe(session, commandId)

        return { ok: true, result: await this.snapshot(session, commandId, arguments_.full === true) }
      case 'browser_click': {
        await this.assertCurrentPageSafe(session, commandId)
        const ref = normalizeRef(arguments_.ref)
        await this.runAgentBrowser(session, commandId, 'click', [ref])
        await this.assertCurrentPageSafe(session, commandId)

        return { ok: true, result: { success: true, clicked: ref, used_real_profile: true } }
      }

      case 'browser_type': {
        await this.assertCurrentPageSafe(session, commandId)
        const ref = normalizeRef(arguments_.ref)
        const text = boundedText(arguments_.text)
        await this.runAgentBrowser(session, commandId, 'fill', [ref, text])

        return {
          ok: true,
          result: { success: true, element: ref, typed: '[redacted]', used_real_profile: true }
        }
      }

      case 'browser_scroll': {
        await this.assertCurrentPageSafe(session, commandId)
        const direction = String(arguments_.direction || 'down')

        if (!['up', 'down'].includes(direction)) {
          throw new Error('Browser scroll direction must be up or down')
        }

        await this.runAgentBrowser(session, commandId, 'scroll', [direction, '500'])

        return { ok: true, result: { success: true, scrolled: direction, used_real_profile: true } }
      }

      case 'browser_back': {
        await this.runAgentBrowser(session, commandId, 'back', [])
        const url = await this.assertCurrentPageSafe(session, commandId)

        return { ok: true, result: { success: true, url, used_real_profile: true } }
      }

      case 'browser_press': {
        await this.assertCurrentPageSafe(session, commandId)
        const key = boundedText(arguments_.key, 64).trim()

        if (!key || !/^[A-Za-z0-9+_-]+$/.test(key)) {
          throw new Error('Invalid browser key')
        }

        await this.runAgentBrowser(session, commandId, 'press', [key])
        await this.assertCurrentPageSafe(session, commandId)

        return { ok: true, result: { success: true, pressed: key, used_real_profile: true } }
      }

      default:
        return { ok: false, error: { code: 'unsupported_action', message: 'Browser action is not permitted' } }
    }
  }

  private async navigate(
    session: BrowserSession,
    commandId: string,
    rawUrl: unknown
  ): Promise<Record<string, unknown>> {
    const url = await assertPublicBrowserUrl(rawUrl)
    const opened = await this.runAgentBrowser(session, commandId, 'open', [url])
    const finalUrl = String(opened.data?.url || url)

    try {
      await assertPublicBrowserUrl(finalUrl)
    } catch (error) {
      await this.runAgentBrowser(session, commandId, 'open', ['about:blank'], true).catch(() => undefined)
      throw error
    }

    const snapshot = await this.snapshot(session, commandId, false)

    return {
      success: true,
      url: finalUrl,
      title: boundedText(opened.data?.title, 2_000),
      snapshot: snapshot.snapshot,
      element_count: snapshot.element_count,
      used_real_profile: true,
      browser_client: 'desktop-chrome'
    }
  }

  private async snapshot(session: BrowserSession, commandId: string, full: boolean): Promise<Record<string, unknown>> {
    const result = await this.runAgentBrowser(session, commandId, 'snapshot', full ? [] : ['-c'])
    const snapshot = boundedText(result.data?.snapshot, MAX_SNAPSHOT_CHARS)
    const refs = result.data?.refs
    const elementCount = refs && typeof refs === 'object' ? Object.keys(refs).length : 0

    return {
      success: true,
      snapshot,
      element_count: elementCount,
      used_real_profile: true,
      browser_client: 'desktop-chrome'
    }
  }

  private async assertCurrentPageSafe(session: BrowserSession, commandId: string): Promise<string> {
    const result = await this.runAgentBrowser(session, commandId, 'get', ['url'])
    const current = String(result.data?.url || '')

    if (current === 'about:blank') {
      return current
    }

    try {
      return await assertPublicBrowserUrl(current)
    } catch (error) {
      await this.runAgentBrowser(session, commandId, 'open', ['about:blank'], true).catch(() => undefined)
      throw error
    }
  }

  private async runAgentBrowser(
    session: BrowserSession,
    commandId: string,
    command: string,
    args: string[],
    allowInternalUrl = false
  ): Promise<AgentBrowserResult> {
    if (!allowInternalUrl && args.some(value => value.startsWith('about:'))) {
      throw new Error('Internal browser URLs are not permitted')
    }

    const executable = this.resolveAgentBrowserExecutable()

    if (!executable) {
      throw new Error('agent-browser 0.26 is not installed on this Mac')
    }

    const argv = [
      '--session',
      session.agentSession,
      '--profile',
      session.snapshotDir,
      '--executable-path',
      this.chromeExecutable,
      '--json',
      command,
      ...args
    ]

    return new Promise<AgentBrowserResult>((resolve, reject) => {
      const child = spawn(executable, argv, {
        env: browserEnv(this.deps.env),
        stdio: ['ignore', 'pipe', 'pipe']
      })

      const sessionKey = ownerKey(session.ownerId, session.gatewayInstanceId, session.sessionId)
      const runningKey = commandKey(session.ownerId, session.gatewayInstanceId, session.sessionId, commandId)
      this.running.set(runningKey, {
        child,
        commandKey: runningKey,
        gatewayInstanceId: session.gatewayInstanceId,
        ownerId: session.ownerId,
        sessionKey
      })

      let stdout = ''
      let stderr = ''
      let outputTooLarge = false

      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error('Desktop Chrome command timed out'))
      }, COMMAND_TIMEOUT_MS)

      child.stdout?.on('data', chunk => {
        if (outputTooLarge) {
          return
        }

        stdout += String(chunk)

        if (Buffer.byteLength(stdout, 'utf8') > MAX_BROWSER_OUTPUT_BYTES) {
          outputTooLarge = true
          child.kill('SIGKILL')
        }
      })
      child.stderr?.on('data', chunk => {
        if (stderr.length < 8_192) {
          stderr += String(chunk)
        }
      })
      child.once('error', error => {
        clearTimeout(timer)
        this.running.delete(runningKey)
        reject(error)
      })
      child.once('close', code => {
        clearTimeout(timer)
        this.running.delete(runningKey)

        if (outputTooLarge) {
          reject(new Error('Browser command returned too much data'))

          return
        }

        if (code !== 0) {
          reject(new Error(safeErrorMessage(stderr || `agent-browser exited with code ${code}`)))

          return
        }

        try {
          const parsed = parseAgentBrowserOutput(stdout)

          if (!parsed.success) {
            reject(new Error(safeErrorMessage(parsed.error || 'Browser command failed')))

            return
          }

          resolve(parsed)
        } catch (error) {
          reject(error)
        }
      })
    })
  }

  private async closeSession(session: BrowserSession): Promise<void> {
    const executable = this.resolveAgentBrowserExecutable()

    if (!executable) {
      return
    }

    await new Promise<void>(resolve => {
      const child = spawn(executable, ['--session', session.agentSession, 'close'], {
        env: browserEnv(this.deps.env),
        stdio: 'ignore'
      })

      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000)
      child.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      child.once('error', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private closeSessionSync(session: BrowserSession): void {
    const executable = this.resolveAgentBrowserExecutable()

    if (!executable) {
      return
    }

    spawnSync(executable, ['--session', session.agentSession, 'close'], {
      env: browserEnv(this.deps.env),
      stdio: 'ignore',
      timeout: 5_000
    })
  }

  private removeSnapshot(snapshotDir: string): void {
    if (!pathInside(this.managedRoot, snapshotDir)) {
      return
    }

    try {
      fs.rmSync(snapshotDir, { force: true, recursive: true })
    } catch {
      // Best-effort credential-copy cleanup; the next prepare retries it.
    }
  }

  private resolveAgentBrowserExecutable(): string | null {
    if (!this.agentBrowserExecutable) {
      return executableOnPath('agent-browser', this.deps.env)
    }

    try {
      fs.accessSync(this.agentBrowserExecutable, fs.constants.X_OK)

      return this.agentBrowserExecutable
    } catch {
      return null
    }
  }
}

export function registerDesktopBrowserControllerIpc(
  ipc: IpcMainLike,
  controller: DesktopBrowserProfileController
): void {
  const observedOwners = new Set<number>()

  const observeOwner = (event: any): number => {
    const ownerId = Number(event?.sender?.id)

    if (!Number.isInteger(ownerId) || ownerId <= 0) {
      throw new Error('Invalid browser-controller window owner')
    }

    if (!observedOwners.has(ownerId)) {
      observedOwners.add(ownerId)
      event.sender.once?.('destroyed', () => {
        observedOwners.delete(ownerId)
        void controller.disposeOwner(ownerId)
      })
    }

    return ownerId
  }

  ipc.handle('hermes:browser-controller:prepare', (event, payload) => controller.prepare(observeOwner(event), payload))
  ipc.handle('hermes:browser-controller:execute', (event, payload) => controller.execute(observeOwner(event), payload))
  ipc.handle('hermes:browser-controller:cancel', (event, payload) => controller.cancel(observeOwner(event), payload))
  ipc.handle('hermes:browser-controller:dispose', (event, payload) => controller.dispose(observeOwner(event), payload))
}
