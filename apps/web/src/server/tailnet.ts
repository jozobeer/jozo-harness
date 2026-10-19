import { execFile } from 'node:child_process'
import { isIP } from 'node:net'
import { Effect } from 'effect'

/** How long the Tailscale lookup may take before the run settles for loopback. */
const TAILNET_TIMEOUT_MS = 2_000

/**
 * The addresses Tailscale reports for this machine. Each stands on its own: a
 * tailnet can have MagicDNS off, and an address the command did not name is one
 * this run does not use. Nothing here is a pattern: the server admits exactly
 * these spellings, at the port it bound.
 */
export interface TailnetAddresses {
  /** The machine's tailnet IPv4 address, as Tailscale reports it. */
  readonly ip?: string
  /** The MagicDNS name, without the trailing dot. */
  readonly dns?: string
}

/** Runs one command for the detector; a failed run is a tailnet it could not name. */
export type TailnetExec = (
  command: string,
  args: ReadonlyArray<string>,
) => Effect.Effect<string, Error>

/** A plain DNS name: the only shape a MagicDNS name may have here. */
const DNS_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/**
 * The Self block of `tailscale status --json`, or undefined for output that is
 * not the status this detector knows: a missing CLI, a timeout, and a version
 * that answers another shape all read the same way.
 */
const selfOf = (stdout: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(stdout)
    if (!isRecord(parsed)) return undefined
    return isRecord(parsed.Self) ? parsed.Self : undefined
  } catch {
    return undefined
  }
}

/**
 * The first IPv4 address in the list. Tailscale reports the v4 and v6
 * addresses together, and an IPv6 Host would need brackets, so this run takes
 * the v4 one and leaves the v6 spelling alone.
 */
const ipv4Of = (values: unknown): string | undefined => {
  if (!Array.isArray(values)) return undefined
  for (const value of values) {
    if (typeof value === 'string' && isIP(value) === 4) return value
  }
  return undefined
}

/** A MagicDNS name without its root dot, lowercased the way a Host header is. */
const nameOf = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const name = value.replace(/\.+$/, '').toLowerCase()
  return name.length > 0 && name.length <= 253 && DNS_NAME.test(name) ? name : undefined
}

const addressesOf = (stdout: string): TailnetAddresses => {
  const self = selfOf(stdout)
  if (self === undefined) return {}
  const ip = ipv4Of(self.TailscaleIPs)
  const dns = nameOf(self.DNSName)
  return {
    ...(ip === undefined ? {} : { ip }),
    ...(dns === undefined ? {} : { dns }),
  }
}

/**
 * The tailnet addresses this machine has, or none when Tailscale is absent,
 * down, or answers something this run cannot use. Detection never fails the
 * run: an empty answer leaves the server on loopback, as it was before.
 */
export const detectTailnet = (exec: TailnetExec): Effect.Effect<TailnetAddresses> =>
  exec('tailscale', ['status', '--json']).pipe(
    Effect.catchCause(() => Effect.succeed('')),
    Effect.map(addressesOf),
  )

/** The Tailscale CLI, as the detector calls it; a missing or slow binary is no answer. */
export const tailnetExec: TailnetExec = (command, args) =>
  Effect.callback<string, Error>((resume) => {
    execFile(
      command,
      [...args],
      { timeout: TAILNET_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        resume(error === null ? Effect.succeed(stdout) : Effect.fail(error))
      },
    )
  })
