/**
 * How far a rising level has come: the time the work has run, as the negative
 * delay its animation starts from, so a reload picks the level up where it was.
 */
export const pourFrom = (startedAt: number, now: number): string =>
  String(-Math.max(0, now - startedAt) / 1000) + 's'
