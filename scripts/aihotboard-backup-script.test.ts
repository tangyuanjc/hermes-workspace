import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

describe('backup-aihotboard-sqlite.sh', () => {
  it('backs up only business DBs and excludes auth.sqlite from the tarball', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'aihotboard-backup-test-'))
    const dataDir = path.join(tempDir, 'data')
    const binDir = path.join(tempDir, 'bin')
    execFileSync('mkdir', ['-p', dataDir, binDir])
    ;['auth.sqlite', 'hotboard.sqlite', 'hotboard-zara.sqlite'].forEach((db) => {
      execFileSync('sqlite3', [path.join(dataDir, db), 'CREATE TABLE t (id TEXT);'])
    })
    const larkCli = path.join(binDir, 'lark-cli')
    writeFileSync(larkCli, '#!/usr/bin/env bash\nexit 0\n')
    execFileSync('chmod', ['755', larkCli])

    execFileSync('bash', [path.join(repoRoot, 'scripts/backup-aihotboard-sqlite.sh')], {
      env: { ...process.env, HERMES_DATA_DIR: dataDir, HERMES_LOG_DIR: path.join(tempDir, 'logs'), LARK_CLI: larkCli },
    })

    const backupDir = path.join(dataDir, 'backups')
    const tarballName = readdirSync(backupDir).find((name) => /^aihotboard-\d{4}-\d{2}-\d{2}\.tar\.gz$/.test(name))
    expect(tarballName).toBeTruthy()
    const listing = execFileSync('tar', ['tzf', path.join(backupDir, tarballName || '')], { encoding: 'utf8' })
    expect(listing).toContain('hotboard.sqlite')
    expect(listing).toContain('hotboard-zara.sqlite')
    expect(listing).not.toContain('auth.sqlite')
  })
})
