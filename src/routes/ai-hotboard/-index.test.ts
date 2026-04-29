import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sourcePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.tsx')
const source = fs.readFileSync(sourcePath, 'utf-8')

describe('ai-hotboard index route', () => {
  it('lands on the all-feed view for a richer first impression', () => {
    expect(source).toContain('page="view-all"')
    expect(source).not.toContain('page="featured"')
  })
})
