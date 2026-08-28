import type { ConnectionState, GatewayEvent } from '@hermes/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  BrowserControllerBridge,
  type DesktopBrowserControllerApi,
  type DesktopBrowserControllerPrepareResult
} from './browser-controller-bridge'

function createHarness(gatewayInstanceId = 'gateway-one') {
  const eventHandlers = new Map<string, (event: GatewayEvent) => void>()
  const rawRequests: Array<{ method: string; params: Record<string, unknown> }> = []
  let stateHandler: ((state: ConnectionState) => void) | null = null

  const prepared: DesktopBrowserControllerPrepareResult = {
    available: true,
    browserProfileId: `profile-${gatewayInstanceId}`,
    capabilities: ['browser_snapshot'],
    controllerId: `controller-${gatewayInstanceId}`
  }

  const native: DesktopBrowserControllerApi = {
    cancel: vi.fn(async () => ({ cancelled: true })),
    dispose: vi.fn(async () => ({ disposed: true })),
    execute: vi.fn(async () => ({ ok: true, result: { success: true } })),
    prepare: vi.fn(async () => prepared)
  }

  async function rawRequest<T>(
    method: string,
    params: Record<string, unknown> = {},
    _timeoutMs?: number,
    _signal?: AbortSignal
  ): Promise<T> {
    rawRequests.push({ method, params })

    return {} as T
  }

  const bridge = new BrowserControllerBridge({
    gatewayInstanceId,
    nativeController: () => native,
    onEvent: (type, handler) => {
      eventHandlers.set(type, handler)

      return () => eventHandlers.delete(type)
    },
    onState: handler => {
      stateHandler = handler
      handler('idle')

      return () => {
        stateHandler = null
      }
    },
    rawRequest
  })

  return {
    bridge,
    emit(type: string, event: Omit<GatewayEvent, 'type'> = {}) {
      eventHandlers.get(type)?.({ ...event, type })
    },
    native,
    prepared,
    rawRequests,
    state(state: ConnectionState) {
      stateHandler?.(state)
    }
  }
}

afterEach(() => {
  vi.clearAllTimers()
})

describe('BrowserControllerBridge', () => {
  it('registers and completes commands through the exact supplied gateway request path', async () => {
    const harness = createHarness()

    harness.state('open')
    await harness.bridge.afterGatewayRequest('session.create', { session_id: 'runtime-one' })

    expect(harness.rawRequests[0]).toEqual({
      method: 'browser.controller.register',
      params: {
        browser_profile_id: harness.prepared.browserProfileId,
        capabilities: harness.prepared.capabilities,
        controller_id: harness.prepared.controllerId,
        protocol_version: 1,
        session_id: 'runtime-one'
      }
    })

    harness.emit('browser.controller.command', {
      session_id: 'runtime-one',
      payload: {
        action: 'browser_snapshot',
        arguments: { full: false },
        browser_profile_id: harness.prepared.browserProfileId,
        command_id: 'command-one',
        controller_id: harness.prepared.controllerId
      }
    })

    await vi.waitFor(() => expect(harness.native.execute).toHaveBeenCalledOnce())
    await vi.waitFor(() =>
      expect(harness.rawRequests.some(request => request.method === 'browser.controller.result')).toBe(true)
    )
    expect(harness.native.execute).toHaveBeenCalledWith({
      action: 'browser_snapshot',
      arguments: { full: false },
      commandId: 'command-one',
      gatewayInstanceId: 'gateway-one',
      sessionId: 'runtime-one'
    })

    const result = harness.rawRequests.find(request => request.method === 'browser.controller.result')

    expect(result?.params).toEqual({
      command_id: 'command-one',
      ok: true,
      result: { success: true },
      session_id: 'runtime-one'
    })
    expect(harness.rawRequests).toHaveLength(2)
    harness.state('closed')
  })

  it('re-registers retained sessions after a socket reconnect', async () => {
    const harness = createHarness()

    harness.state('open')
    await harness.bridge.afterGatewayRequest('session.resume', { session_id: 'runtime-reconnect' })
    harness.state('closed')
    await vi.waitFor(() => expect(harness.native.dispose).toHaveBeenCalledOnce())

    harness.state('open')
    await vi.waitFor(() => expect(harness.native.prepare).toHaveBeenCalledTimes(2))
    await vi.waitFor(() =>
      expect(harness.rawRequests.filter(request => request.method === 'browser.controller.register')).toHaveLength(2)
    )
    harness.state('closed')
  })

  it('keeps colliding runtime ids scoped to their own gateway nonce', async () => {
    const first = createHarness('gateway-first')
    const second = createHarness('gateway-second')

    first.state('open')
    second.state('open')
    await first.bridge.afterGatewayRequest('session.activate', { session_id: 'same-runtime' })
    await second.bridge.afterGatewayRequest('session.activate', { session_id: 'same-runtime' })

    first.emit('browser.controller.command', {
      session_id: 'same-runtime',
      payload: {
        action: 'browser_snapshot',
        browser_profile_id: first.prepared.browserProfileId,
        command_id: 'first-command',
        controller_id: first.prepared.controllerId
      }
    })

    await vi.waitFor(() => expect(first.native.execute).toHaveBeenCalledOnce())
    expect(second.native.execute).not.toHaveBeenCalled()
    expect(first.native.execute).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayInstanceId: 'gateway-first', sessionId: 'same-runtime' })
    )
    first.state('closed')
    second.state('closed')
  })

  it('cleans up a globally broadcast reclaimed session using its payload id', async () => {
    const harness = createHarness()

    harness.state('open')
    await harness.bridge.afterGatewayRequest('session.create', { session_id: 'runtime-reclaimed' })
    harness.emit('session.reclaimed', {
      session_id: '',
      payload: { reason: 'ws_orphan_reap', session_id: 'runtime-reclaimed' }
    })

    await vi.waitFor(() =>
      expect(harness.native.dispose).toHaveBeenCalledWith({
        gatewayInstanceId: 'gateway-one',
        sessionId: 'runtime-reclaimed'
      })
    )
    expect(harness.rawRequests.some(request => request.method === 'browser.controller.detach')).toBe(false)
    harness.state('closed')
  })
})
