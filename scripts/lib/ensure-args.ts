/**
 * ensure-args.ts — pure argument/task-shim logic for ensure-chrome.ts, split
 * out so unit tests can exercise it without running the keeper itself.
 */

export interface EnsureArgs {
  targets: string[] | 'all'
  quiet: boolean
  installTask: boolean
  removeTask: boolean
  list: boolean
  timeoutSec: number
}

/** Platforms ensured when no --target/--all flag is given. */
export const DEFAULT_ENSURE = ['x', 'instagram']

/** Pure arg parser. Unknown flags land in a warning list. */
export function parseEnsureArgs(argv: string[]): { args: EnsureArgs; unknown: string[] } {
  const args: EnsureArgs = {
    targets: [],
    quiet: false,
    installTask: false,
    removeTask: false,
    list: false,
    timeoutSec: 20,
  }
  const unknown: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    switch (a) {
      case '--target': {
        const v = argv[++i]
        if (v && !v.startsWith('--')) args.targets.push(v)
        break
      }
      case '--all': args.targets = 'all'; break
      case '--quiet': args.quiet = true; break
      case '--install-task': args.installTask = true; break
      case '--remove-task': args.removeTask = true; break
      case '--list': args.list = true; break
      case '--timeout':
      case '--timeout-sec': {
        const v = Number(argv[++i])
        if (Number.isFinite(v) && v > 0) args.timeoutSec = v
        break
      }
      default: unknown.push(a)
    }
  }
  if (args.targets !== 'all' && args.targets.length === 0) {
    args.targets = [...DEFAULT_ENSURE]
  }
  return { args, unknown }
}

/** Paths + content for the logon keep-alive task shim (pure). */
export function taskPaths(bunBin: string, scriptPath: string, startupFolder: string): {
  shim: string
  line: string
} {
  const shim = joinShim(startupFolder, 'LocoAgentEnsureChrome.cmd')
  const q = (s: string) => `"${s}"`
  const line = `@echo off\r\nstart "" /min ${q(bunBin)} ${q(scriptPath)} --all --quiet\r\n`
  return { shim, line }
}

function joinShim(dir: string, file: string): string {
  return (dir.endsWith('\\') ? dir : dir + '\\') + file
}
