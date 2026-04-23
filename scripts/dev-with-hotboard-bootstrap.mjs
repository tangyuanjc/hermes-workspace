import { spawn } from 'node:child_process'

const VITE_COMMAND = process.platform === 'win32' ? 'vite.cmd' : 'vite'
const READY_URL_PATTERN = /Local:\s+(https?:\/\/[^\s]+)/
const NODE_OPTIONS = '--max-old-space-size=2048'

let bootstrapTriggered = false
let outputBuffer = ''

const child = spawn(VITE_COMMAND, ['dev', '--port', '3000'], {
  stdio: ['inherit', 'pipe', 'pipe'],
  env: {
    ...process.env,
    NODE_OPTIONS,
  },
})

async function bootstrapHotboardScheduler(localUrl) {
  try {
    const url = new URL(localUrl)
    if (url.hostname === 'localhost') {
      url.hostname = '127.0.0.1'
    }
    url.pathname = '/'
    url.search = ''
    url.hash = ''

    await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(5_000),
    })

    process.stdout.write(
      `[hotboard-dev-bootstrap] triggered scheduler bootstrap via ${url.toString()}\n`,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(
      `[hotboard-dev-bootstrap] failed to trigger scheduler bootstrap: ${message}\n`,
    )
  }
}

function scanForReadyUrl(text) {
  if (bootstrapTriggered) return

  outputBuffer += text
  if (outputBuffer.length > 8_192) {
    outputBuffer = outputBuffer.slice(-8_192)
  }

  const match = outputBuffer.match(READY_URL_PATTERN)
  if (!match) return

  bootstrapTriggered = true
  void bootstrapHotboardScheduler(match[1])
}

function forwardOutput(target) {
  return (chunk) => {
    const text = chunk.toString()
    target.write(text)
    scanForReadyUrl(text)
  }
}

child.stdout?.on('data', forwardOutput(process.stdout))
child.stderr?.on('data', forwardOutput(process.stderr))

const forwardSignal = (signal) => {
  if (!child.killed) {
    child.kill(signal)
  }
}

process.on('SIGINT', () => forwardSignal('SIGINT'))
process.on('SIGTERM', () => forwardSignal('SIGTERM'))

child.on('exit', (code, signal) => {
  if (signal) {
    process.exit(0)
  }
  process.exit(code ?? 0)
})
