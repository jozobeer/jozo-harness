import { Match, Switch } from 'solid-js'
import { Icon } from './icon.tsx'
import { Mug } from './mug.tsx'

/**
 * How a goal stands, drawn the way the rest of the page draws work: a mug while
 * it is worked on, the same mug empty while it is paused, a red dot once the
 * round limit stopped it, and a green dot once it was achieved.
 */
export const GoalMark = (props: { phase: string }) => (
  <Switch fallback={<Mug state="filling" />}>
    <Match when={props.phase === 'paused'}>
      <Mug state="empty" />
    </Match>
    <Match when={props.phase === 'blocked'}>
      <Icon name="failed" class="goal-mark blocked" />
    </Match>
    <Match when={props.phase === 'complete'}>
      <Icon name="done" class="goal-mark complete" />
    </Match>
  </Switch>
)

/** The rounds as words: how many ran, of how many the goal allows. */
export const roundsOf = (rounds: number, maxRounds: number): string =>
  'round ' + String(rounds) + ' / ' + String(maxRounds)
