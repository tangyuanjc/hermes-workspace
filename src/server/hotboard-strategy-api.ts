import os from 'node:os'
import path from 'node:path'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from './auth-middleware'
import {
  normalizeStrategyLineKey,
  readStrategyStatusFromGlossary,
} from './hotboard-strategy-status'

function resolveGlossaryPath() {
  const explicit = process.env.HOTBOARD_BUSINESS_GLOSSARY_PATH?.trim()
  if (explicit) return explicit
  return path.join(os.homedir(), '.org', 'shared-memory', 'business-glossary.md')
}

export async function handleHotboardStrategyGet(request: Request): Promise<Response> {
  if (!isAuthenticated(request)) {
    return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(request.url)
  const lineParam = url.searchParams.get('line') ?? 'm2-a'
  const line = normalizeStrategyLineKey(lineParam)

  if (!line) {
    return json({ ok: false, error: 'Invalid line query parameter' }, { status: 400 })
  }

  try {
    const items = readStrategyStatusFromGlossary({
      glossaryPath: resolveGlossaryPath(),
      lines: [line],
    })

    return json({
      ok: true,
      line,
      item: items[0],
    })
  } catch (error) {
    return json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
