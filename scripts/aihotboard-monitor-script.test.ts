import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

function makeTempDir(prefix: string) {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

describe('monitor-aihotboard.sh', () => {
  it('does not throttle future alerts when lark send fails', () => {
    const tempDir = makeTempDir('aihotboard-monitor-fail-')
    const binDir = path.join(tempDir, 'bin')
    execFileSync('mkdir', ['-p', binDir])

    const sendLog = path.join(tempDir, 'send.log')
    const larkCli = path.join(binDir, 'lark-cli')
    writeFileSync(larkCli, `#!/usr/bin/env bash\necho send >> ${sendLog}\nexit 1\n`)
    execFileSync('chmod', ['755', larkCli])

    const stateFile = path.join(tempDir, 'state.csv')
    for (let index = 0; index < 2; index += 1) {
      execFileSync('bash', [path.join(repoRoot, 'scripts/monitor-aihotboard.sh')], {
        env: {
          ...process.env,
          AIHOTBOARD_MONITOR_STATE_FILE: stateFile,
          HERMES_LOG_DIR: path.join(tempDir, 'logs'),
          LARK_CLI: larkCli,
          AIHOTBOARD_HEALTH_URL: 'http://127.0.0.1:1/always-fail',
          PATH: `${binDir}:${process.env.PATH}`,
        },
      })
    }

    expect(readFileSync(sendLog, 'utf8').trim().split('\n')).toHaveLength(2)
    expect(readFileSync(stateFile, 'utf8').trim()).toMatch(/^ok,2,\d+$/)
  })

  it('records flapping count and includes it after repeated failures in a one-hour window', () => {
    const tempDir = makeTempDir('aihotboard-monitor-flap-')
    const binDir = path.join(tempDir, 'bin')
    execFileSync('mkdir', ['-p', binDir])

    const sentText = path.join(tempDir, 'sent.txt')
    const larkCli = path.join(binDir, 'lark-cli')
    writeFileSync(larkCli, `#!/usr/bin/env bash\nprintf '%s\\n---\\n' "$*" >> ${sentText}\nexit 0\n`)
    execFileSync('chmod', ['755', larkCli])

    const stateFile = path.join(tempDir, 'state.csv')
    const env = {
      ...process.env,
      AIHOTBOARD_MONITOR_STATE_FILE: stateFile,
      AIHOTBOARD_ALERT_THROTTLE_SECONDS: '0',
      HERMES_LOG_DIR: path.join(tempDir, 'logs'),
      LARK_CLI: larkCli,
      AIHOTBOARD_HEALTH_URL: 'http://127.0.0.1:1/always-fail',
      PATH: `${binDir}:${process.env.PATH}`,
    }

    for (let index = 0; index < 4; index += 1) {
      execFileSync('bash', [path.join(repoRoot, 'scripts/monitor-aihotboard.sh')], { env })
    }

    expect(readFileSync(sentText, 'utf8')).toContain('🔴 持续抖动 4x in 1h')
    expect(readFileSync(stateFile, 'utf8').trim()).toMatch(/^alert,4,\d+$/)
  })
})
