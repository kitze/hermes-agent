import type { ConnectionState, GatewayEvent } from '@hermes/shared'

const BROWSER_CONTROL_PROTOCOL_VERSION = 1
const CONTROLLER_REQUEST_TIMEOUT_MS = 10_000
const CONTROLLER_HEARTBEAT_INTERVAL_MS = 20_000

export interface DesktopBrowserControllerPrepareResult {
  available: boolean
  browserProfileId?: string
  capabilities?: string[]
  controllerId?: string
  error?: string
}

export interface DesktopBrowserControllerExecutionResult {
  error?: { code: string; message: string }
  ok: boolean
  result?: Record<string, unknown>
}

export interface DesktopBrowserControllerApi {
  cancel: (payload: {
    commandId: string
    gatewayInstanceId: string
    sessionId: string
  }) => Promise<{ cancelled: boolean }>
  dispose: (payload: { gatewayInstanceId: string; sessionId: string }) => Promise<{ disposed: boolean }>
  execute: (payload: {
    action: string
    arguments: Record<string, unknown>
    commandId: string
    gatewayInstanceId: string
    sessionId: string
  }) => Promise<DesktopBrowserControllerExecutionResult>
  prepare: (payload: { gatewayInstanceId: string; sessionId: string }) => Promise<DesktopBrowserControllerPrepareResult>
}

interface BrowserControllerBridgeDeps {
  gatewayInstanceId: string
  nativeController: () => DesktopBrowserControllerApi | undefined
  onEvent: (type: string, handler: (event: GatewayEvent) => void) => () => void
  onState: (handler: (state: ConnectionState) => void) => () => void
  rawRequest: <T>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal
  ) => Promise<T>
}

interface ControllerSession {
  prepared: DesktopBrowserControllerPrepareResult | null
  registered: boolean
  registering: Promise<void> | null
  version: number
}

function cleanId(value: unknown, max = 256): string {
  const result = String(value ?? '').trim()

  if (!result || result.length > max || hasControlCharacter(result)) {
    return ''
  }

  return result
}

function hasControlCharacter(value: string): boolean {
  return [...value].some(character => {
    const code = character.charCodeAt(0)

    return code <= 31 || code === 127
  })
}

function runtimeSessionId(result: unknown): string {
  if (!result || typeof result !== 'object') {
    return ''
  }

  return cleanId((result as { session_id?: unknown }).session_id)
}

function commandError(code: string, message: string): { code: string; message: string } {
  return { code, message }
}

/**
 * Binds one renderer-side Gateway socket to the narrow native Chrome
 * controller. Registration and every completion use the exact same
 * JsonRpcGatewayClient instance; Electron receives a separate local gateway
 * nonce so two sockets that happen to reuse a short runtime session id can
 * never share browser state.
 */
export class BrowserControllerBridge {
  private connectionState: ConnectionState = 'idle'
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private readonly sessions = new Map<string, ControllerSession>()

  constructor(private readonly deps: BrowserControllerBridgeDeps) {
    deps.onEvent('browser.controller.command', event => {
      void this.handleCommand(event)
    })
    deps.onEvent('browser.controller.cancel', event => {
      this.handleCancel(event)
    })
    deps.onEvent('session.reclaimed', event => {
      const payload =
        event.payload && typeof event.payload === 'object' ? (event.payload as Record<string, unknown>) : {}

      const sessionId = cleanId(payload.session_id) || cleanId(event.session_id)

      if (sessionId) {
        void this.releaseSession(sessionId, false)
      }
    })
    deps.onState(state => this.handleState(state))
  }

  async beforeGatewayRequest(method: string, params: Record<string, unknown>): Promise<void> {
    if (method !== 'session.close') {
      return
    }

    const sessionId = cleanId(params.session_id)

    if (sessionId) {
      await this.releaseSession(sessionId, true)
    }
  }

  async afterGatewayRequest(method: string, result: unknown): Promise<void> {
    if (!['session.activate', 'session.create', 'session.resume'].includes(method)) {
      return
    }

    const sessionId = runtimeSessionId(result)

    if (sessionId) {
      await this.ensureRegistered(sessionId)
    }
  }

  private handleState(state: ConnectionState): void {
    this.connectionState = state

    if (state === 'open') {
      this.ensureHeartbeat()

      for (const sessionId of this.sessions.keys()) {
        void this.ensureRegistered(sessionId).catch(() => undefined)
      }

      return
    }

    this.stopHeartbeat()

    if (state !== 'closed' && state !== 'error') {
      return
    }

    const native = this.deps.nativeController()

    for (const [sessionId, session] of this.sessions) {
      session.version += 1
      session.registered = false
      session.prepared = null
      session.registering = null
      void native?.dispose({ gatewayInstanceId: this.deps.gatewayInstanceId, sessionId }).catch(() => undefined)
    }
  }

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer !== null || this.connectionState !== 'open') {
      return
    }

    if (![...this.sessions.values()].some(session => session.registered)) {
      return
    }

    this.heartbeatTimer = setInterval(() => {
      if (this.connectionState !== 'open') {
        return
      }

      for (const [sessionId, session] of this.sessions) {
        if (!session.registered) {
          continue
        }

        void this.deps
          .rawRequest('browser.controller.heartbeat', { session_id: sessionId }, CONTROLLER_REQUEST_TIMEOUT_MS)
          .catch(() => undefined)
      }
    }, CONTROLLER_HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private async ensureRegistered(sessionId: string): Promise<void> {
    if (this.connectionState !== 'open') {
      return
    }

    let session = this.sessions.get(sessionId)

    if (!session) {
      session = { prepared: null, registered: false, registering: null, version: 0 }
      this.sessions.set(sessionId, session)
    }

    if (session.registered) {
      return
    }

    if (session.registering) {
      return session.registering
    }

    const native = this.deps.nativeController()

    if (!native) {
      return
    }

    const version = session.version

    const work = (async () => {
      let prepared: DesktopBrowserControllerPrepareResult

      try {
        prepared = await native.prepare({
          gatewayInstanceId: this.deps.gatewayInstanceId,
          sessionId
        })
      } catch {
        return
      }

      if (
        !prepared.available ||
        !cleanId(prepared.controllerId) ||
        !cleanId(prepared.browserProfileId) ||
        !Array.isArray(prepared.capabilities) ||
        prepared.capabilities.length === 0
      ) {
        return
      }

      if (this.sessions.get(sessionId) !== session || session.version !== version) {
        await native.dispose({ gatewayInstanceId: this.deps.gatewayInstanceId, sessionId }).catch(() => undefined)

        return
      }

      session.prepared = prepared

      try {
        await this.deps.rawRequest(
          'browser.controller.register',
          {
            browser_profile_id: prepared.browserProfileId,
            capabilities: prepared.capabilities,
            controller_id: prepared.controllerId,
            protocol_version: BROWSER_CONTROL_PROTOCOL_VERSION,
            session_id: sessionId
          },
          CONTROLLER_REQUEST_TIMEOUT_MS
        )
      } catch {
        session.prepared = null
        await native.dispose({ gatewayInstanceId: this.deps.gatewayInstanceId, sessionId }).catch(() => undefined)

        return
      }

      if (this.connectionState !== 'open' || this.sessions.get(sessionId) !== session || session.version !== version) {
        session.prepared = null
        await native.dispose({ gatewayInstanceId: this.deps.gatewayInstanceId, sessionId }).catch(() => undefined)

        return
      }

      session.registered = true
      this.ensureHeartbeat()
    })()

    const registering = work.finally(() => {
      if (this.sessions.get(sessionId) === session && session.registering === registering) {
        session.registering = null
      }
    })

    session.registering = registering

    return registering
  }

  private async releaseSession(sessionId: string, detachRemote: boolean): Promise<void> {
    const session = this.sessions.get(sessionId)

    if (!session) {
      return
    }

    session.version += 1
    this.sessions.delete(sessionId)

    if (detachRemote && session.registered && this.connectionState === 'open') {
      await this.deps
        .rawRequest('browser.controller.detach', { session_id: sessionId }, CONTROLLER_REQUEST_TIMEOUT_MS)
        .catch(() => undefined)
    }

    const native = this.deps.nativeController()

    await native?.dispose({ gatewayInstanceId: this.deps.gatewayInstanceId, sessionId }).catch(() => undefined)

    if (![...this.sessions.values()].some(candidate => candidate.registered)) {
      this.stopHeartbeat()
    }
  }

  private async handleCommand(event: GatewayEvent): Promise<void> {
    const sessionId = cleanId(event.session_id)
    const payload = event.payload && typeof event.payload === 'object' ? (event.payload as Record<string, unknown>) : {}
    const commandId = cleanId(payload.command_id, 128)
    const action = cleanId(payload.action, 128)

    if (!sessionId || !commandId) {
      return
    }

    const session = this.sessions.get(sessionId)
    const prepared = session?.prepared
    let outcome: DesktopBrowserControllerExecutionResult

    if (
      !session?.registered ||
      !prepared ||
      cleanId(payload.controller_id) !== prepared.controllerId ||
      cleanId(payload.browser_profile_id) !== prepared.browserProfileId
    ) {
      outcome = {
        ok: false,
        error: commandError('controller_scope_mismatch', 'Desktop browser controller scope did not match')
      }
    } else if (!action) {
      outcome = {
        ok: false,
        error: commandError('invalid_action', 'Desktop browser command did not include an action')
      }
    } else {
      const native = this.deps.nativeController()

      if (!native) {
        outcome = {
          ok: false,
          error: commandError('desktop_controller_unavailable', 'Desktop browser controller is unavailable')
        }
      } else {
        try {
          outcome = await native.execute({
            action,
            arguments:
              payload.arguments && typeof payload.arguments === 'object'
                ? (payload.arguments as Record<string, unknown>)
                : {},
            commandId,
            gatewayInstanceId: this.deps.gatewayInstanceId,
            sessionId
          })
        } catch {
          outcome = {
            ok: false,
            error: commandError('desktop_controller_error', 'Desktop browser controller failed')
          }
        }
      }
    }

    const ok = outcome.ok === true

    await this.deps
      .rawRequest(
        'browser.controller.result',
        {
          command_id: commandId,
          ...(ok ? { result: outcome.result ?? {} } : { error: outcome.error ?? commandError('failed', 'Failed') }),
          ok,
          session_id: sessionId
        },
        CONTROLLER_REQUEST_TIMEOUT_MS
      )
      .catch(() => undefined)
  }

  private handleCancel(event: GatewayEvent): void {
    const sessionId = cleanId(event.session_id)
    const payload = event.payload && typeof event.payload === 'object' ? (event.payload as Record<string, unknown>) : {}
    const commandId = cleanId(payload.command_id, 128)

    if (!sessionId || !commandId || !this.sessions.get(sessionId)?.registered) {
      return
    }

    void this.deps
      .nativeController()
      ?.cancel({
        commandId,
        gatewayInstanceId: this.deps.gatewayInstanceId,
        sessionId
      })
      .catch(() => undefined)
  }
}
