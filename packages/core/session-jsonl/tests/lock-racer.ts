import { appendFileSync, writeSync } from 'node:fs'
import { Effect } from 'effect'
import { acquireLock } from '../src/lock.ts'

// Tries once to take the lock on argv[2] and records this pid in argv[3] when it does.
const logPath = process.argv[2]
const marker = process.argv[3]
if (logPath === undefined || marker === undefined) throw new Error('missing log path')

const won = await Effect.runPromise(
  acquireLock(logPath, 'racer').pipe(
    Effect.match({
      onFailure: () => false,
      onSuccess: () => true,
    }),
  ),
)
if (won) appendFileSync(marker, String(process.pid) + '\n')
// A pipe buffers process.stdout, so the parent would wait forever on a winner
// that is still holding the lock. The raw write is visible immediately.
writeSync(1, won ? 'won\n' : 'lost\n')
// Stay until the parent has seen both results. Exiting here would release the
// lock and let the other process take it after the race was already decided.
if (won) await new Promise((resolve) => process.stdin.once('data', () => resolve(undefined)))
