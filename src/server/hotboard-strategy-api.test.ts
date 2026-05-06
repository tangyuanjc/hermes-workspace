import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSessionStore, storeSessionToken } from './auth-middleware'
import { handleHotboardStrategyGet } from './hotboard-strategy-api'

const tempDirs: string[] = []
const originalAuthDbPath = process.env.HERMES_AUTH_DB_PATH

afterEach(() => {
  if (originalAuthDbPath === undefined) {
    delete process.env.HERMES_AUTH_DB_PATH
  } else {
    process.env.HERMES_AUTH_DB_PATH = originalAuthDbPath
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

function setupTempAuth() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotboard-strategy-api-'))
  tempDirs.push(tempDir)
  process.env.HERMES_AUTH_DB_PATH = path.join(tempDir, 'auth.sqlite')

  const store = createSessionStore()
  store.upsertUser({
    feishuOpenId: 'ou_40ece573ca861adce640dc9ea5054460',
    feishuUnionId: 'on_owner',
    displayName: 'JC',
    role: 'owner',
  })

  storeSessionToken('session-jc', {
    userId: 'ou_40ece573ca861adce640dc9ea5054460',
    ttlSeconds: 7 * 24 * 60 * 60,
  })
}

function makeRequest(url: string) {
  return new Request(url, {
    headers: {
      cookie: 'hermes-auth=session-jc',
      'x-forwarded-for': '127.0.0.1',
    },
  })
}

describe('hotboard strategy api handler', () => {
  it('returns strategy status item for requested line key', async () => {
    setupTempAuth()

    const response = await handleHotboardStrategyGet(
      makeRequest('http://localhost/api/hotboard/strategy?line=m2-a'),
    )

    expect(response.status).toBe(200)

    const payload = (await response.json()) as {
      ok: boolean
      line: string
      item: {
        lineKey: string
        code: string
        name: string
        owner: string
        priority: string
      }
    }

    expect(payload.ok).toBe(true)
    expect(payload.line).toBe('m2-a')
    expect(payload.item.lineKey).toBe('m2-a')
    expect(payload.item.code).toBe('A线')
    expect(payload.item.name).toBe('抓数稳定化')
    expect(payload.item.owner.length).toBeGreaterThan(0)
    expect(payload.item.priority.length).toBeGreaterThan(0)
  })

  it('accepts short strategy route params from /strategy/$line', async () => {
    setupTempAuth()

    const response = await handleHotboardStrategyGet(
      makeRequest('http://localhost/api/hotboard/strategy?line=c'),
    )

    expect(response.status).toBe(200)
    const payload = (await response.json()) as {
      line: string
      item: { lineKey: string; code: string; name: string }
    }

    expect(payload.line).toBe('m2-c')
    expect(payload.item.lineKey).toBe('m2-c')
    expect(payload.item.code).toBe('C线')
    expect(payload.item.name).toBe('AI短视频→投流ROI')
  })

  it('returns 400 for invalid line key', async () => {
    setupTempAuth()

    const response = await handleHotboardStrategyGet(
      makeRequest('http://localhost/api/hotboard/strategy?line=bad-line'),
    )

    expect(response.status).toBe(400)
    const payload = (await response.json()) as { ok: boolean; error: string }
    expect(payload.ok).toBe(false)
    expect(payload.error).toContain('Invalid line')
  })
})
