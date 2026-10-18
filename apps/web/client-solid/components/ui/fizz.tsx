import { Index } from 'solid-js'

const BUBBLES = Array.from({ length: 8 }, (_, index) => index)

/** The bubbles rising through a glass that waits on the reader; where and when each rises is the sheet's. */
export const Fizz = () => (
  <span class="fizz" aria-hidden="true">
    <Index each={BUBBLES}>{() => <i />}</Index>
  </span>
)
