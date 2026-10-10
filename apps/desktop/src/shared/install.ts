/**
 * Turns a catalogue entry into something Bridge can actually launch.
 *
 * The registry describes *what* a server is (an npm package, a PyPI package, a
 * container, a hosted URL) but not the command line to start it. That mapping
 * lives here, as a pure function, because getting it wrong is the difference
 * between a server that runs and an opaque "Server disconnected".
 */
import { displayTitle, type CatalogEntry, type RegistryArgument, type RegistryPackage, type RegistryRemote } from './registry'
import type { UpstreamTarget } from './types'

export interface RequiredInput {
  name: string
  description: string
  isSecret: boolean
  /** 'env' values become environment variables; 'header' ones HTTP headers. */
  kind: 'env' | 'header'
  default?: string
}

export interface InstallPlan {
  /** Suggested config key — short, lowercase, unique-ish. */
  suggestedName: string
  target: UpstreamTarget
  /** Values the user must supply before this can run (API keys and the like). */
  required: RequiredInput[]
  /** The runner this depends on being installed, when it needs one. */
  prerequisite: string | null
  notes: string[]
}

export interface PlanError {
  reason: string
}

export type PlanResult = { ok: true; plan: InstallPlan } | { ok: false; error: PlanError }

/**
 * `io.github.delorenj/mcp-server-trello` -> `trello`, best effort.
 *
 * Stripping the boilerplate can leave nothing at all: `com.gitlab/mcp` reduces
 * to an empty string and the config key came out as the literal "mcp". When
 * that happens the vendor's name is the sensible fallback, which is exactly
 * what `displayTitle` already derives from the namespace.
 */
export function suggestName(registryName: string): string {
  const last = registryName.split('/').pop() ?? registryName
  const cleaned = last
    .replace(/^(mcp[-_]?server[-_]?|server[-_]?mcp[-_]?|mcp[-_]?)/i, '')
    .replace(/([-_]?mcp([-_]?server)?)$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
  if (cleaned) return cleaned
  return displayTitle(registryName)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function argsFrom(list: RegistryArgument[] | undefined): string[] {
  if (!list) return []
  const out: string[] = []
  for (const arg of list) {
    // Only arguments with a concrete value can be filled in unattended; the
    // rest are placeholders the user edits after install.
    if (arg.type === 'named' && arg.name) {
      out.push(arg.name)
      if (arg.value) out.push(arg.value)
    } else if (arg.value) {
      out.push(arg.value)
    }
  }
  return out
}

/**
 * Runner flags a publisher may ask for. The registry is public input, and a
 * runtime argument changes what the runner does, not what the server does:
 * `npx -c "<shell>"` runs a shell command instead of the package the trust
 * signals were computed for, and `docker --privileged -v /:/host` removes the
 * container boundary. npx and uvx get a short allowlist; docker gets a
 * denylist of the flags that widen access to the host.
 */
const RUNNER_ALLOWED: Record<string, RegExp> = {
  npm: /^(-y|--yes|-q|--quiet|--prefer-offline|--no-install)$/,
  pypi: /^(--python|-p|--refresh|--offline|--native-tls|--quiet|-q)(=.*)?$/
}
const DOCKER_DENIED =
  /^(--privileged|-v|--volume|--mount|--cap-add|--device|--security-opt|--network|--net|--pid|--ipc|--uts|--userns|--cgroupns|--volumes-from|--group-add|-u|--user)(=.*)?$/

/** The first runtime argument Bridge will not pass to this runner, if any. */
export function unsafeRuntimeArg(registryType: string, args: string[]): string | null {
  const flags = args.filter((a) => a.startsWith('-'))
  if (registryType === 'oci') return flags.find((a) => DOCKER_DENIED.test(a)) ?? null
  const allowed = RUNNER_ALLOWED[registryType]
  if (!allowed) return flags[0] ?? null
  return flags.find((a) => !allowed.test(a)) ?? null
}

/** The command line exactly as it will run, for showing before it does. */
export function commandLine(target: UpstreamTarget): string {
  if (target.kind === 'http') return target.url
  const show = (a: string): string => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)
  return [target.command, ...target.args].map(show).join(' ')
}

function inputsFrom(pkg: RegistryPackage): RequiredInput[] {
  return (pkg.environmentVariables ?? [])
    .filter((v) => v.isRequired)
    .map((v) => ({
      name: v.name,
      description: v.description ?? '',
      isSecret: !!v.isSecret,
      kind: 'env' as const,
      ...(v.default ? { default: v.default } : {})
    }))
}

function planPackage(entry: CatalogEntry, pkg: RegistryPackage): PlanResult {
  const version = pkg.version ? `@${pkg.version}` : ''
  const runtimeArgs = argsFrom(pkg.runtimeArguments)
  const pkgArgs = argsFrom(pkg.packageArguments)
  const unsafe = unsafeRuntimeArg(pkg.registryType, runtimeArgs)
  if (unsafe) {
    return {
      ok: false,
      error: {
        reason: `The publisher asks to run ${pkg.registryType === 'oci' ? 'docker' : 'the runner'} with "${unsafe}", which could run something other than this server or widen its access to your machine. Bridge will not install it automatically; add it yourself with Add server if you trust it.`
      }
    }
  }
  const required = inputsFrom(pkg)
  const notes: string[] = []
  let target: UpstreamTarget
  let prerequisite: string | null = null

  switch (pkg.registryType) {
    case 'npm': {
      target = {
        kind: 'stdio',
        command: 'npx',
        args: ['-y', ...runtimeArgs, `${pkg.identifier}${version}`, ...pkgArgs]
      }
      prerequisite = 'Node.js (provides npx)'
      break
    }
    case 'pypi': {
      target = {
        kind: 'stdio',
        command: 'uvx',
        args: [...runtimeArgs, `${pkg.identifier}${version}`, ...pkgArgs]
      }
      prerequisite = 'uv (provides uvx)'
      notes.push('If uvx is unavailable, pipx run works the same way.')
      break
    }
    case 'oci': {
      target = {
        kind: 'stdio',
        command: 'docker',
        args: ['run', '--rm', '-i', ...runtimeArgs, pkg.identifier, ...pkgArgs]
      }
      prerequisite = 'Docker'
      notes.push('Required values are passed with -e when the container starts.')
      break
    }
    case 'nuget': {
      target = {
        kind: 'stdio',
        command: 'dnx',
        args: [`${pkg.identifier}${version}`, '--yes', ...pkgArgs]
      }
      prerequisite = '.NET SDK'
      break
    }
    case 'mcpb':
      return {
        ok: false,
        error: {
          reason:
            'This is an MCP bundle (.mcpb), which is installed by the AI client itself rather than launched as a command. Install it from the client, then Bridge will see it on the Servers page.'
        }
      }
    default:
      return {
        ok: false,
        error: { reason: `Unsupported package type "${pkg.registryType}".` }
      }
  }

  if (pkg.transport?.type && pkg.transport.type !== 'stdio') {
    notes.push(`Publisher declares a "${pkg.transport.type}" transport for this package.`)
  }

  return {
    ok: true,
    plan: { suggestedName: suggestName(entry.name), target, required, prerequisite, notes }
  }
}

function planRemote(entry: CatalogEntry, remote: RegistryRemote): PlanResult {
  const required: RequiredInput[] = (remote.headers ?? [])
    .filter((h) => h.isRequired)
    .map((h) => ({
      name: h.name,
      description: h.description ?? '',
      isSecret: !!h.isSecret,
      kind: 'header' as const,
      ...(h.default ? { default: h.default } : {})
    }))

  const notes = ['Hosted by the publisher — your requests leave your machine.']
  if (remote.type === 'sse') {
    notes.push('Uses the older SSE transport; Bridge proxies it the same way.')
  }
  if (required.length === 0) {
    notes.push(
      'The publisher declares no credentials. Many hosted servers still need one — add a header below if the test returns 401.'
    )
  }

  return {
    ok: true,
    plan: {
      suggestedName: suggestName(entry.name),
      target: { kind: 'http', url: remote.url },
      required,
      prerequisite: null,
      notes
    }
  }
}

/**
 * Builds the install plan. `prefer` decides which way to go when a server
 * offers both a local package and a hosted endpoint — local by default, since
 * it keeps data on the machine.
 */
export function planInstall(entry: CatalogEntry, prefer: 'local' | 'remote' = 'local'): PlanResult {
  const pkg = entry.packages[0]
  const remote = entry.remotes[0]

  if (prefer === 'remote' && remote) return planRemote(entry, remote)
  if (pkg) return planPackage(entry, pkg)
  if (remote) return planRemote(entry, remote)

  return {
    ok: false,
    error: { reason: 'This entry lists neither a package nor a hosted endpoint, so there is nothing to launch.' }
  }
}

/** Applies user-supplied values to a plan, producing the final target. */
export function applyInputs(plan: InstallPlan, values: Record<string, string>): UpstreamTarget {
  const env: Record<string, string> = {}
  const headers: Record<string, string> = {}

  for (const input of plan.required) {
    const value = values[input.name]
    if (value === undefined || value === '') continue
    if (input.kind === 'header') headers[input.name] = value
    else env[input.name] = value
  }

  if (plan.target.kind === 'http') {
    return {
      ...plan.target,
      ...(Object.keys(headers).length > 0 ? { headers } : {})
    }
  }

  // Containers take environment through flags rather than a child env.
  if (plan.target.command === 'docker') {
    const flags = Object.keys(env).flatMap((name) => ['-e', name])
    const args = [...plan.target.args]
    const runIdx = args.indexOf('-i')
    args.splice(runIdx + 1, 0, ...flags)
    return { ...plan.target, args, ...(Object.keys(env).length > 0 ? { env } : {}) }
  }

  return {
    ...plan.target,
    ...(Object.keys(env).length > 0 ? { env } : {})
  }
}


/**
 * A custom entry becomes a target directly: the operator has already told us
 * exactly how to run it, so there is nothing to infer.
 *
 * Git entries are the exception — a repository is not a runnable thing, and
 * cloning and building someone's repo on the user's behalf is a much larger
 * decision than "install this". They are recorded, and the operator supplies
 * the command that runs the checkout.
 */
export function planCustom(entry: {
  source: 'custom-local' | 'custom-remote' | 'custom-git'
  title: string
  command: string | null
  args: string[]
  env: Record<string, string>
  url: string | null
  cwd: string | null
}): PlanResult {
  if (entry.source === 'custom-remote') {
    if (!entry.url) return { ok: false, error: { reason: 'This entry has no URL.' } }
    return {
      ok: true,
      plan: {
        suggestedName: suggestName(entry.title),
        target: { kind: 'http', url: entry.url },
        required: [],
        prerequisite: null,
        notes: ['Self-hosted by you, so Bridge proxies it but the traffic goes to your own endpoint.']
      }
    }
  }

  if (!entry.command) {
    return {
      ok: false,
      error: {
        reason:
          entry.source === 'custom-git'
            ? 'A git entry needs the command that runs the checked-out server (for example `node dist/index.js`), plus the directory to run it in.'
            : 'This entry has no command to run.'
      }
    }
  }

  return {
    ok: true,
    plan: {
      suggestedName: suggestName(entry.title),
      target: {
        kind: 'stdio',
        command: entry.command,
        args: entry.args,
        ...(Object.keys(entry.env).length > 0 ? { env: entry.env } : {}),
        ...(entry.cwd ? { cwd: entry.cwd } : {})
      },
      required: [],
      prerequisite: null,
      notes:
        entry.source === 'custom-git'
          ? ['Bridge runs the command you gave; it does not clone or build the repository for you.']
          : []
    }
  }
}
