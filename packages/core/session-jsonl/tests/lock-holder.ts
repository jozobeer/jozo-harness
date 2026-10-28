import { Effect } from 'effect'
import { acquireLock } from '../src/lock.ts'

// Holds a write lock on the log path given as argv[2] until the parent says so.
const logPath = process.argv[2]
if (logPath === undefined) throw new Error('missing log path')
await Effect.runPromise(acquireLock(logPath, 'child'))
process.stdout.write('held\n')
process.stdin.once('data', () => process.exit(0))
