import { describe, expect, it } from 'vitest'
import {
  extractStrategyStatus,
  normalizeStrategyLineKey,
  type StrategyLineKey,
} from './hotboard-strategy-status'

describe('hotboard strategy status reader', () => {
  it('normalizes short route params to M2 strategy line keys', () => {
    expect(normalizeStrategyLineKey('a')).toBe('m2-a')
    expect(normalizeStrategyLineKey('c')).toBe('m2-c')
    expect(normalizeStrategyLineKey('m2-e')).toBe('m2-e')
    expect(normalizeStrategyLineKey('bad-line')).toBeNull()
  })

  it('extracts owner and priority by strategy line from glossary markdown', () => {
    const markdown = `
## M2战略主线（2026-04-05起）

| 线 | 名称 | 负责人 | 优先级 |
|----|------|--------|--------|
| C线 | AI短视频→投流ROI | JC+爱马仕+Opus | 最高 |
| A线 | 抓数稳定化 | Codex+高斯 | HIGH |
| B线 | 财务报表自动化 | Codex+爱马仕 | HIGH |
| D线 | 自动化有效率 | Opus+爱马仕 | HIGH |
| E线 | 全员Agent协作 | 小J+爱马仕 | HIGH |
`

    const lines: StrategyLineKey[] = ['m2-a', 'm2-b', 'm2-c', 'm2-d', 'm2-e']

    expect(extractStrategyStatus(markdown, lines)).toEqual([
      {
        lineKey: 'm2-a',
        code: 'A线',
        name: '抓数稳定化',
        owner: 'Codex+高斯',
        priority: 'HIGH',
      },
      {
        lineKey: 'm2-b',
        code: 'B线',
        name: '财务报表自动化',
        owner: 'Codex+爱马仕',
        priority: 'HIGH',
      },
      {
        lineKey: 'm2-c',
        code: 'C线',
        name: 'AI短视频→投流ROI',
        owner: 'JC+爱马仕+Opus',
        priority: '最高',
      },
      {
        lineKey: 'm2-d',
        code: 'D线',
        name: '自动化有效率',
        owner: 'Opus+爱马仕',
        priority: 'HIGH',
      },
      {
        lineKey: 'm2-e',
        code: 'E线',
        name: '全员Agent协作',
        owner: '小J+爱马仕',
        priority: 'HIGH',
      },
    ])
  })

  it('returns unknown placeholders when glossary rows are missing', () => {
    const result = extractStrategyStatus('# empty', ['m2-a'])
    expect(result).toEqual([
      {
        lineKey: 'm2-a',
        code: 'A线',
        name: '抓数稳定化',
        owner: '待补充',
        priority: '待补充',
      },
    ])
  })
})
