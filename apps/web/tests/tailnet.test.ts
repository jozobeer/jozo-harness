import { describe, expect, test } from 'vitest'
import { Effect, Exit } from 'effect'
import { detectTailnet, tailnetExec, type TailnetExec } from '../src/server/tailnet.ts'

/** A detector whose one command answers this stdout. */
const execAnswering =
  (stdout: string): TailnetExec =>
  () =>
    Effect.succeed(stdout)

/** The shape `tailscale status --json` answers, cut down to the fields read here. */
const statusOf = (self: Record<string, unknown>): string => JSON.stringify({ Self: self })

describe('detecting the tailnet this machine is on', () => {
  test('reads the IPv4 address and the MagicDNS name without its root dot', async () => {
    const asked: Array<ReadonlyArray<string>> = []
    const exec: TailnetExec = (command, args) => {
      asked.push([command, ...args])
      return Effect.succeed(
        statusOf({
          TailscaleIPs: ['fd7a:115c:a1e0::1', '100.88.96.60'],
          DNSName: 'MyHost.Tailnet.TS.NET.',
        }),
      )
    }

    expect(await Effect.runPromise(detectTailnet(exec))).toEqual({
      ip: '100.88.96.60',
      dns: 'myhost.tailnet.ts.net',
    })
    expect(asked).toEqual([['tailscale', 'status', '--json']])
  })

  test('keeps whichever address the status named and leaves the other out', async () => {
    const ipOnly = execAnswering(statusOf({ TailscaleIPs: ['100.88.96.60'] }))
    expect(await Effect.runPromise(detectTailnet(ipOnly))).toEqual({ ip: '100.88.96.60' })

    const nameOnly = execAnswering(statusOf({ DNSName: 'myhost.tailnet.ts.net.' }))
    expect(await Effect.runPromise(detectTailnet(nameOnly))).toEqual({
      dns: 'myhost.tailnet.ts.net',
    })

    // An IPv6-only tailnet has no address this run listens on, and no name to
    // fall back to; it reads as no tailnet at all.
    const v6Only = execAnswering(statusOf({ TailscaleIPs: ['fd7a:115c:a1e0::1'] }))
    expect(await Effect.runPromise(detectTailnet(v6Only))).toEqual({})
  })

  test('reads a failed command as no tailnet, so the run stays on loopback', async () => {
    const exec: TailnetExec = () => Effect.fail(new Error('tailscale: command not found'))
    expect(await Effect.runPromise(detectTailnet(exec))).toEqual({})
  })

  test('reads empty or foreign output as no tailnet', async () => {
    expect(await Effect.runPromise(detectTailnet(execAnswering('')))).toEqual({})
    expect(await Effect.runPromise(detectTailnet(execAnswering('not json')))).toEqual({})
    expect(await Effect.runPromise(detectTailnet(execAnswering('{}')))).toEqual({})
  })

  test('refuses a MagicDNS name that is not a plain hostname', async () => {
    const odd = execAnswering(statusOf({ DNSName: 'myhost/../evil' }))
    expect(await Effect.runPromise(detectTailnet(odd))).toEqual({})
  })

  test('runs the command it is given, and a missing one fails instead of throwing', async () => {
    const stdout = await Effect.runPromise(
      tailnetExec(process.execPath, ['-e', "process.stdout.write('hello')"]),
    )
    expect(stdout).toBe('hello')

    const missing = await Effect.runPromise(
      Effect.exit(tailnetExec('/nonexistent/jzh-tailscale', ['status'])),
    )
    expect(Exit.isFailure(missing)).toBe(true)
  })
})
