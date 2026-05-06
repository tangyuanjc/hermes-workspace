import fs from 'node:fs'

export const STRATEGY_LINE_KEYS = ['m2-a', 'm2-b', 'm2-c', 'm2-d', 'm2-e'] as const

export type StrategyLineKey = (typeof STRATEGY_LINE_KEYS)[number]

const STRATEGY_LINE_ALIASES: Record<string, StrategyLineKey> = {
  a: 'm2-a',
  b: 'm2-b',
  c: 'm2-c',
  d: 'm2-d',
  e: 'm2-e',
  'm2-a': 'm2-a',
  'm2-b': 'm2-b',
  'm2-c': 'm2-c',
  'm2-d': 'm2-d',
  'm2-e': 'm2-e',
}

export function normalizeStrategyLineKey(input?: string | null): StrategyLineKey | null {
  const value = (input || 'm2-a').trim().toLowerCase()
  return STRATEGY_LINE_ALIASES[value] ?? null
}

export type StrategyStatusItem = {
  lineKey: StrategyLineKey
  code: string
  name: string
  owner: string
  priority: string
}

const STRATEGY_META: Record<StrategyLineKey, { code: string; name: string }> = {
  'm2-a': { code: 'A线', name: '抓数稳定化' },
  'm2-b': { code: 'B线', name: '财务报表自动化' },
  'm2-c': { code: 'C线', name: 'AI短视频→投流ROI' },
  'm2-d': { code: 'D线', name: '自动化有效率' },
  'm2-e': { code: 'E线', name: '全员Agent协作' },
}

function normalizeCell(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function parseTableLine(line: string) {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null

  const cells = trimmed
    .split('|')
    .slice(1, -1)
    .map((cell) => normalizeCell(cell))

  if (cells.length < 4) return null
  if (cells.every((cell) => /^-+$/.test(cell))) return null

  return {
    code: cells[0],
    name: cells[1],
    owner: cells[2],
    priority: cells[3],
  }
}

export function extractStrategyStatus(markdown: string, lines: StrategyLineKey[]): StrategyStatusItem[] {
  const parsedByCode = new Map<string, { name: string; owner: string; priority: string }>()
  const markdownLines = markdown.split(/\r?\n/)

  for (const line of markdownLines) {
    const row = parseTableLine(line)
    if (!row) continue
    if (!/^[A-E]线$/.test(row.code)) continue

    parsedByCode.set(row.code, {
      name: row.name,
      owner: row.owner,
      priority: row.priority,
    })
  }

  return lines.map((lineKey) => {
    const meta = STRATEGY_META[lineKey]
    const parsed = parsedByCode.get(meta.code)

    return {
      lineKey,
      code: meta.code,
      name: parsed?.name || meta.name,
      owner: parsed?.owner || '待补充',
      priority: parsed?.priority || '待补充',
    }
  })
}

export function readStrategyStatusFromGlossary(options: {
  glossaryPath: string
  lines: StrategyLineKey[]
}) {
  const markdown = fs.readFileSync(options.glossaryPath, 'utf-8')
  return extractStrategyStatus(markdown, options.lines)
}
