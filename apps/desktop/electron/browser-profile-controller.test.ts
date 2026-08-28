import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DesktopBrowserProfileController,
  reencryptChromeCookieDatabaseForAgentBrowser,
  resolveActiveChromeProfile
} from './browser-profile-controller'

const temporaryRoots: string[] = []

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-desktop-browser-'))

  temporaryRoots.push(root)

  return root
}

function executable(filePath: string, source = '#!/bin/sh\nexit 0\n'): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, source, { mode: 0o755 })
  fs.chmodSync(filePath, 0o755)

  return filePath
}

function chromeFixture(root: string, activeProfile = 'Profile 7') {
  const homeDir = path.join(root, 'home')
  const chromeRoot = path.join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome')
  const chromeExecutable = executable(path.join(root, 'Google Chrome'))

  fs.mkdirSync(path.join(chromeRoot, 'Default'), { recursive: true })
  fs.mkdirSync(path.join(chromeRoot, activeProfile), { recursive: true })
  fs.writeFileSync(path.join(chromeRoot, 'Local State'), JSON.stringify({ profile: { last_used: activeProfile } }))
  fs.writeFileSync(path.join(chromeRoot, 'Default', 'Preferences'), 'default-preferences')
  fs.writeFileSync(path.join(chromeRoot, 'Default', 'default-only.txt'), 'wrong profile')
  fs.writeFileSync(path.join(chromeRoot, activeProfile, 'Preferences'), 'active-preferences')
  fs.writeFileSync(path.join(chromeRoot, activeProfile, 'active-only.txt'), 'selected profile')

  return { activeProfile, chromeExecutable, chromeRoot, homeDir }
}

function fakeAgentBrowser(root: string, options: { blockGet?: boolean } = {}) {
  const logPath = path.join(root, 'agent-browser-calls.jsonl')
  const startedPath = path.join(root, 'agent-browser-started')

  const source = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n')
const jsonIndex = args.indexOf('--json')
const command = jsonIndex >= 0 ? args[jsonIndex + 1] : args.at(-1)
if (${options.blockGet === true ? 'true' : 'false'} && command === 'get') {
  fs.writeFileSync(${JSON.stringify(startedPath)}, 'started')
  setInterval(() => {}, 1000)
} else {
  process.stdout.write(JSON.stringify({
    success: true,
    data: { refs: { e1: {} }, snapshot: 'safe snapshot', title: 'Blank', url: 'about:blank' }
  }) + '\\n')
}
`

  return {
    executable: executable(path.join(root, 'agent-browser'), source),
    logPath,
    startedPath
  }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true })
  }
})

describe('DesktopBrowserProfileController', () => {
  it('translates copied Chrome cookies into the keychain used by agent-browser without exposing plaintext', () => {
    const root = temporaryRoot()
    const databasePath = path.join(root, 'Cookies')
    const database = new DatabaseSync(databasePath)
    const host = 'example.com'
    const value = 'authenticated-session-fixture'
    const sourcePassword = Buffer.from('fixture-safe-storage-password')
    const sourceKey = crypto.pbkdf2Sync(sourcePassword, 'saltysalt', 1_003, 16, 'sha1')
    const iv = Buffer.alloc(16, 0x20)
    const sourcePlaintext = Buffer.concat([crypto.createHash('sha256').update(host).digest(), Buffer.from(value)])
    const sourceCipher = crypto.createCipheriv('aes-128-cbc', sourceKey, iv)
    const sourceEncrypted = Buffer.concat([
      Buffer.from('v10'),
      sourceCipher.update(sourcePlaintext),
      sourceCipher.final()
    ])

    database.exec(
      'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);' +
        'CREATE TABLE cookies (host_key TEXT, value TEXT, encrypted_value BLOB);'
    )
    database.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('version', '24')
    database
      .prepare('INSERT INTO cookies (host_key, value, encrypted_value) VALUES (?, ?, ?)')
      .run(host, '', sourceEncrypted)
    database.close()

    expect(reencryptChromeCookieDatabaseForAgentBrowser(databasePath, sourcePassword)).toBe(1)

    const translatedDatabase = new DatabaseSync(databasePath)
    const translated = translatedDatabase
      .prepare('SELECT value, encrypted_value FROM cookies WHERE host_key = ?')
      .get(host) as { value: string; encrypted_value: Uint8Array }

    translatedDatabase.close()
    expect(translated.value).toBe('')

    const mockKey = crypto.pbkdf2Sync('mock_password', 'saltysalt', 1_003, 16, 'sha1')
    const translatedBytes = Buffer.from(translated.encrypted_value)
    const mockDecipher = crypto.createDecipheriv('aes-128-cbc', mockKey, iv)
    const decoded = Buffer.concat([mockDecipher.update(translatedBytes.subarray(3)), mockDecipher.final()])

    expect(decoded.subarray(0, 32)).toEqual(crypto.createHash('sha256').update(host).digest())
    expect(decoded.subarray(32).toString('utf8')).toBe(value)
    expect(translatedBytes.subarray(3)).not.toEqual(sourceEncrypted.subarray(3))
  })

  it('selects only Chrome Local State last_used and launches the explicit Google Chrome binary', async () => {
    const root = temporaryRoot()
    const chrome = chromeFixture(root)
    const agent = fakeAgentBrowser(root)
    const userDataDir = path.join(root, 'desktop-user-data')

    const controller = new DesktopBrowserProfileController({
      agentBrowserExecutable: agent.executable,
      chromeExecutable: chrome.chromeExecutable,
      env: process.env,
      homeDir: chrome.homeDir,
      hostname: 'macbook-fixture',
      platform: 'darwin',
      userDataDir
    })

    expect(resolveActiveChromeProfile(chrome.homeDir, chrome.chromeExecutable)?.name).toBe(chrome.activeProfile)

    const prepared = controller.prepare(17, { gatewayInstanceId: 'gateway-one', sessionId: 'runtime-one' })

    expect(prepared.available).toBe(true)

    const result = await controller.execute(17, {
      action: 'browser_snapshot',
      arguments: {},
      commandId: 'command-one',
      gatewayInstanceId: 'gateway-one',
      sessionId: 'runtime-one'
    })

    expect(result).toEqual({
      ok: true,
      result: {
        browser_client: 'desktop-chrome',
        element_count: 1,
        snapshot: 'safe snapshot',
        success: true,
        used_real_profile: true
      }
    })

    const managedRoot = path.join(userDataDir, 'browser-profile-controller')
    const snapshotNames = fs.readdirSync(managedRoot)

    expect(snapshotNames).toHaveLength(1)
    const snapshot = path.join(managedRoot, snapshotNames[0])

    expect(fs.readFileSync(path.join(snapshot, 'Default', 'Preferences'), 'utf8')).toBe('active-preferences')
    expect(fs.readFileSync(path.join(snapshot, 'Default', 'active-only.txt'), 'utf8')).toBe('selected profile')
    expect(fs.existsSync(path.join(snapshot, 'Default', 'default-only.txt'))).toBe(false)
    expect(fs.statSync(snapshot).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.join(snapshot, 'Default', 'Preferences')).mode & 0o777).toBe(0o600)

    const calls = fs
      .readFileSync(agent.logPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as string[][][number])

    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls.every(args => args.includes('--executable-path') || args.at(-1) === 'close')).toBe(true)
    const browserCall = calls.find(args => args.includes('--executable-path'))

    expect(browserCall?.[browserCall.indexOf('--executable-path') + 1]).toBe(chrome.chromeExecutable)
    expect(browserCall).not.toContain('SwiftCast')

    await controller.dispose(17, { gatewayInstanceId: 'gateway-one', sessionId: 'runtime-one' })
    expect(fs.existsSync(snapshot)).toBe(false)
  })

  it('isolates identical runtime session ids by gateway, window owner, and machine identity', async () => {
    const root = temporaryRoot()
    const chrome = chromeFixture(root)
    const agent = fakeAgentBrowser(root)

    const first = new DesktopBrowserProfileController({
      agentBrowserExecutable: agent.executable,
      chromeExecutable: chrome.chromeExecutable,
      homeDir: chrome.homeDir,
      hostname: 'macbook-fixture',
      platform: 'darwin',
      userDataDir: path.join(root, 'macbook-user-data')
    })

    const secondMachine = new DesktopBrowserProfileController({
      agentBrowserExecutable: agent.executable,
      chromeExecutable: chrome.chromeExecutable,
      homeDir: chrome.homeDir,
      hostname: 'studio-fixture',
      platform: 'darwin',
      userDataDir: path.join(root, 'studio-user-data')
    })

    const firstGateway = first.prepare(4, { gatewayInstanceId: 'gateway-first', sessionId: 'same-runtime' })
    const secondGateway = first.prepare(4, { gatewayInstanceId: 'gateway-second', sessionId: 'same-runtime' })
    const secondWindow = first.prepare(5, { gatewayInstanceId: 'gateway-first', sessionId: 'same-runtime' })
    const studio = secondMachine.prepare(4, { gatewayInstanceId: 'gateway-first', sessionId: 'same-runtime' })

    expect(
      new Set([firstGateway.controllerId, secondGateway.controllerId, secondWindow.controllerId, studio.controllerId])
        .size
    ).toBe(4)

    await first.dispose(4, { gatewayInstanceId: 'gateway-first', sessionId: 'same-runtime' })
    expect(
      await first.execute(4, {
        action: 'controller.noop',
        commandId: 'still-live',
        gatewayInstanceId: 'gateway-second',
        sessionId: 'same-runtime'
      })
    ).toEqual({ ok: true, result: { ok: true, source: 'desktop-chrome' } })
    expect(
      await first.execute(4, {
        action: 'controller.noop',
        commandId: 'disposed',
        gatewayInstanceId: 'gateway-first',
        sessionId: 'same-runtime'
      })
    ).toEqual(expect.objectContaining({ ok: false }))

    first.disposeAllSync()
    secondMachine.disposeAllSync()
  })

  it('cancels an in-flight browser process and removes its managed profile on dispose', async () => {
    const root = temporaryRoot()
    const chrome = chromeFixture(root)
    const agent = fakeAgentBrowser(root, { blockGet: true })
    const userDataDir = path.join(root, 'desktop-user-data')

    const controller = new DesktopBrowserProfileController({
      agentBrowserExecutable: agent.executable,
      chromeExecutable: chrome.chromeExecutable,
      homeDir: chrome.homeDir,
      hostname: 'macbook-fixture',
      platform: 'darwin',
      userDataDir
    })

    controller.prepare(9, { gatewayInstanceId: 'gateway-cancel', sessionId: 'runtime-cancel' })

    const execution = controller.execute(9, {
      action: 'browser_snapshot',
      arguments: {},
      commandId: 'command-cancel',
      gatewayInstanceId: 'gateway-cancel',
      sessionId: 'runtime-cancel'
    })

    await vi.waitFor(() => expect(fs.existsSync(agent.startedPath)).toBe(true))
    expect(
      controller.cancel(9, {
        commandId: 'command-cancel',
        gatewayInstanceId: 'gateway-cancel',
        sessionId: 'runtime-cancel'
      })
    ).toEqual({ cancelled: true })
    expect(await execution).toEqual(expect.objectContaining({ ok: false }))

    const managedRoot = path.join(userDataDir, 'browser-profile-controller')

    expect(fs.readdirSync(managedRoot)).toHaveLength(1)
    await controller.dispose(9, { gatewayInstanceId: 'gateway-cancel', sessionId: 'runtime-cancel' })
    expect(fs.readdirSync(managedRoot)).toHaveLength(0)
  })

  it('closes and deletes owner-only snapshots left behind by a crashed client', () => {
    const root = temporaryRoot()
    const chrome = chromeFixture(root)
    const agent = fakeAgentBrowser(root)
    const userDataDir = path.join(root, 'desktop-user-data')
    const managedRoot = path.join(userDataDir, 'browser-profile-controller')
    const staleId = 'a'.repeat(32)

    fs.mkdirSync(path.join(managedRoot, staleId), { recursive: true })
    fs.writeFileSync(path.join(managedRoot, staleId, 'copied-credential-fixture'), 'fixture')

    const controller = new DesktopBrowserProfileController({
      agentBrowserExecutable: agent.executable,
      chromeExecutable: chrome.chromeExecutable,
      homeDir: chrome.homeDir,
      hostname: 'macbook-fixture',
      platform: 'darwin',
      userDataDir
    })

    controller.cleanupStaleSnapshotsSync()

    expect(fs.existsSync(managedRoot)).toBe(false)

    const calls = fs
      .readFileSync(agent.logPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as string[])

    expect(calls).toContainEqual(['--session', `hermes_desktop_${staleId.slice(0, 24)}`, 'close'])
  })
})
