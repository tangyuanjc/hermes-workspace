import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

function makeTempDir(prefix: string) {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

function writeExecutable(filePath: string, body: string) {
  writeFileSync(filePath, body)
  execFileSync('chmod', ['755', filePath])
}

describe('monitor-x-signal-sync.sh', () => {
  it('alerts when latest payload is smaller than the minimum byte threshold', () => {
    const tempDir = makeTempDir('x-signal-monitor-small-')
    const binDir = path.join(tempDir, 'bin')
    execFileSync('mkdir', ['-p', binDir])

    const latestPath = path.join(tempDir, 'x_signal_sync_latest.json')
    writeFileSync(latestPath, '{}')

    const sentText = path.join(tempDir, 'sent.txt')
    writeExecutable(path.join(binDir, 'lark-cli'), `#!/usr/bin/env bash\nprintf '%s\n---\n' "$*" >> ${sentText}\nexit 0\n`)
    writeExecutable(path.join(binDir, 'launchctl'), `#!/usr/bin/env bash\necho 'arguments = {'\necho '  python3'\necho '  /expected/x_signal_sync.py'\necho '}'\nexit 0\n`)

    execFileSync('bash', [path.join(repoRoot, 'scripts/monitor-x-signal-sync.sh')], {
      env: {
        ...process.env,
        HERMES_LOG_DIR: path.join(tempDir, 'logs'),
        LARK_CLI: path.join(binDir, 'lark-cli'),
        PATH: `${binDir}:${process.env.PATH}`,
        X_SIGNAL_MONITOR_STATE_FILE: path.join(tempDir, 'state.csv'),
        X_SIGNAL_LATEST_PATH: latestPath,
        X_SIGNAL_MIN_BYTES: '300000',
        X_SIGNAL_SCRIPT_PATH: '/expected/x_signal_sync.py',
      },
    })

    expect(readFileSync(sentText, 'utf8')).toContain('latest.json too small')
    expect(readFileSync(sentText, 'utf8')).toContain('size=2')
  })

  it('alerts when launchd falls back to the tmp sync script', () => {
    const tempDir = makeTempDir('x-signal-monitor-path-')
    const binDir = path.join(tempDir, 'bin')
    execFileSync('mkdir', ['-p', binDir])

    const latestPath = path.join(tempDir, 'x_signal_sync_latest.json')
    writeFileSync(latestPath, 'x'.repeat(400000))

    const sentText = path.join(tempDir, 'sent.txt')
    writeExecutable(path.join(binDir, 'lark-cli'), `#!/usr/bin/env bash\nprintf '%s\n---\n' "$*" >> ${sentText}\nexit 0\n`)
    writeExecutable(path.join(binDir, 'launchctl'), `#!/usr/bin/env bash\necho 'arguments = {'\necho '  python3'\necho '  /Users/tangyuanjc/.hermes/tmp/x_signal_sync.py'\necho '}'\nexit 0\n`)

    execFileSync('bash', [path.join(repoRoot, 'scripts/monitor-x-signal-sync.sh')], {
      env: {
        ...process.env,
        HERMES_LOG_DIR: path.join(tempDir, 'logs'),
        LARK_CLI: path.join(binDir, 'lark-cli'),
        PATH: `${binDir}:${process.env.PATH}`,
        X_SIGNAL_MONITOR_STATE_FILE: path.join(tempDir, 'state.csv'),
        X_SIGNAL_LATEST_PATH: latestPath,
        X_SIGNAL_MIN_BYTES: '300000',
        X_SIGNAL_SCRIPT_PATH: '/Users/tangyuanjc/.hermes/hermes-agent/scripts/x_signal_sync.py',
      },
    })

    expect(readFileSync(sentText, 'utf8')).toContain('launchd script mismatch')
    expect(readFileSync(sentText, 'utf8')).toContain('/Users/tangyuanjc/.hermes/tmp/x_signal_sync.py')
  })
})
