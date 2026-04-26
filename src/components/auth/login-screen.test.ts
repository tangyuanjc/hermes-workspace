import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sourcePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'login-screen.tsx')
const source = fs.readFileSync(sourcePath, 'utf-8')

describe('LoginScreen accessibility source contract', () => {
  it('labels all login inputs and submit actions for screen readers', () => {
    expect(source).toContain('aria-label="用户名"')
    expect(source).toContain('aria-label="密码"')
    expect(source).toContain('aria-label="邮箱"')
    expect(source).toContain('aria-label="使用用户名和密码登录"')
    expect(source).toContain('aria-label="发送邮箱登录链接"')
  })

  it('announces auth and request toasts with polite alert semantics', () => {
    expect(source.match(/role="alert"/g)).toHaveLength(3)
    expect(source.match(/aria-live="polite"/g)).toHaveLength(3)
  })
})
