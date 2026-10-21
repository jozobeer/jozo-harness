import { Schema } from 'effect'

/**
 * One run of changed lines in one file. A call that changes several places
 * records one entry for each, so a hunk never has to stand for two gaps.
 */
export interface FileDiff {
  readonly path: string
  /** The first line of the old side; 1 when the change adds to an empty file. */
  readonly oldStart: number
  /** The first line of the new side. */
  readonly newStart: number
  /** The lines the call took away, in order. */
  readonly removed: ReadonlyArray<string>
  /** The lines the call put in their place, in order. */
  readonly added: ReadonlyArray<string>
}

/** The runtime shape of a logged diff; old logs without one still decode. */
export const FileDiffSchema: Schema.Schema<FileDiff> = Schema.Struct({
  path: Schema.String,
  oldStart: Schema.Int,
  newStart: Schema.Int,
  removed: Schema.Array(Schema.String),
  added: Schema.Array(Schema.String),
}) as Schema.Schema<FileDiff>

/** Where a tool records the file changes one call made while it runs. */
export interface DiffRecorder {
  record(diff: FileDiff): void
}
