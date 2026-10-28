import { For, Show } from 'solid-js'
import type { RunStateView } from '../../src/shared/rpc.ts'
import { useTranslate, type Translate } from '../i18n.ts'
import type { SessionStore } from '../store.ts'

type UsageView = NonNullable<RunStateView['usage']>
type ContextView = NonNullable<UsageView['context']>

/** The dial's top: a faster turn fills the ring, and the reading says by how much. */
const TOP = 500
/** The dial spans 240 degrees, open at its foot, where the reading's unit sits. */
const SWEEP = 240
const START = 90 + SWEEP / 2
/** The face is cut flat below the scale, so the dial is no taller than it reads. */
const FOOT = 74
const HALF = Math.sqrt(48 ** 2 - (FOOT - 50) ** 2)
const FACE = `M${50 - HALF} ${FOOT}A48 48 0 1 1 ${50 + HALF} ${FOOT}Z`
const TICKS = Array.from({ length: TOP / 10 + 1 }, (_, index) => index * 10)
/** Within this share of the window before compaction runs, the context turns gold. */
const NEAR = 0.1

/** A point on the dial at a speed, `r` from its centre. */
const at = (value: number, r: number): readonly [number, number] => {
  const turn = ((START - (SWEEP * Math.min(Math.max(value, 0), TOP)) / TOP) * Math.PI) / 180
  return [50 + r * Math.cos(turn), 50 - r * Math.sin(turn)]
}

/** The ring from 0 to a speed. */
const arcTo = (value: number): string => {
  const [x1, y1] = at(0, 46.5)
  const [x2, y2] = at(value, 46.5)
  const large = (SWEEP * Math.min(value, TOP)) / TOP > 180 ? 1 : 0
  return `M${x1} ${y1}A46.5 46.5 0 ${large} 1 ${x2} ${y2}`
}

/** The ring's whole arc, so a new reading changes only how much of it is drawn. */
const ARC = arcTo(TOP)

/** The share of the fixed arc a speed fills, as a dash at its start. */
const fillOf = (value: number): string => String(Math.min(Math.max(value, 0), TOP) / TOP) + ' 1'

/** Every 10 a fine tick, every 50 a longer one, every 100 the longest. */
const tickOf = (value: number) => {
  const major = value % 100 === 0
  const mid = !major && value % 50 === 0
  const [x1, y1] = at(value, major ? 37 : mid ? 39 : 41)
  const [x2, y2] = at(value, 44)
  return { x1, y1, x2, y2, kind: major ? ' major' : mid ? ' mid' : '' }
}

/** A longer reading draws smaller, so it keeps clear of the ticks on either side. */
const sizeOf = (text: string): string => {
  if (text.length >= 4) return ' long'
  return text.length === 3 ? ' mid' : ''
}

/**
 * The newest turn's speed as a car's dial: the ring fills in blue up to it, and
 * the reading sits large in the middle. A provider that gave no timings leaves
 * the ring empty and the reading a dash.
 */
export const SpeedDial = (props: { speed: UsageView['speed'] }) => {
  const t = useTranslate()
  const value = (): number => props.speed?.value ?? 0
  const text = (): string => props.speed?.text ?? '—'
  return (
    <svg
      class="dial"
      viewBox={'0 0 100 ' + String(FOOT + 1)}
      role="img"
      aria-label={t('usage.speed') + text() + t('usage.perSecond')}
    >
      <path class="dial-face" d={FACE} />
      <path class="dial-track" d={ARC} />
      <Show when={value() > 0}>
        <path class="dial-fill" d={ARC} pathLength="1" stroke-dasharray={fillOf(value())} />
      </Show>
      <For each={TICKS}>
        {(tick) => {
          const line = tickOf(tick)
          return (
            <line
              class={'dial-tick' + line.kind}
              x1={line.x1}
              y1={line.y1}
              x2={line.x2}
              y2={line.y2}
            />
          )
        }}
      </For>
      <text class={'dial-value' + sizeOf(text())} x="50" y="54" text-anchor="middle">
        {text()}
      </text>
      <text class="dial-unit" x="50" y="65" text-anchor="middle">
        tok/s
      </text>
    </svg>
  )
}

const nearOf = (context: ContextView): boolean => context.fire - context.share <= NEAR

/** How full the window is, as a bar with the line compaction runs at. */
const ContextBar = (props: { context: ContextView }) => {
  const t = useTranslate()
  return (
    <div class={'usage-context' + (nearOf(props.context) ? ' near' : '')}>
      <div class="usage-context-head">
        <span>{t('usage.context')}</span>
        <span class="usage-context-of">{props.context.used + ' / ' + props.context.window}</span>
      </div>
      <div class="usage-bar">
        <i style={{ width: String(props.context.share * 100) + '%' }} />
        <span class="usage-fire" style={{ left: String(props.context.fire * 100) + '%' }} />
      </div>
      <span class="usage-left">{t('usage.compacts') + props.context.left}</span>
    </div>
  )
}

const turnsOf = (turns: number, t: Translate): string =>
  String(turns) + ' ' + (turns === 1 ? t('usage.turn') : t('usage.turnMany'))

/**
 * The session's usage in the Run pane: the context on top, then what went in,
 * how fast the newest turn wrote, and what came out.
 */
export const Usage = (props: { usage: UsageView | undefined }) => {
  const t = useTranslate()
  return (
    <Show when={props.usage}>
      {(usage) => (
        <section id="run-usage" class="run-usage">
          <div class="run-section">
            <span class="run-section-title">{t('usage.title')}</span>
            <span class="usage-total">{usage().total + t('usage.tokens')}</span>
          </div>
          <Show when={usage().context}>{(context) => <ContextBar context={context()} />}</Show>
          <div class="usage-trio">
            <div class="usage-side">
              <span class="usage-key">{t('usage.in')}</span>
              <span class="usage-value">{usage().input}</span>
              <Show when={usage().cache}>
                {(cache) => <span class="usage-note">{t('usage.cache') + cache()}</span>}
              </Show>
            </div>
            <SpeedDial speed={usage().speed} />
            <div class="usage-side out">
              <span class="usage-key">{t('usage.out')}</span>
              <span class="usage-value">{usage().output}</span>
              <span class="usage-note">{turnsOf(usage().turns, t)}</span>
            </div>
          </div>
        </section>
      )}
    </Show>
  )
}

const RING = 2 * Math.PI * 6

/** The window's share as a ring, with the compaction line marked in gold. */
const Ring = (props: { context: ContextView }) => (
  <svg class="context-ring-mark" viewBox="0 0 16 16" aria-hidden="true">
    <circle class="ring-track" cx="8" cy="8" r="6" />
    <circle
      class="ring-used"
      cx="8"
      cy="8"
      r="6"
      stroke-dasharray={String(RING * props.context.share) + ' ' + String(RING)}
    />
    <circle
      class="ring-fire"
      cx="8"
      cy="8"
      r="6"
      stroke-dasharray={'0.9 ' + String(RING)}
      stroke-dashoffset={String(-RING * props.context.fire)}
    />
  </svg>
)

/** Opens the Run pane at its usage, which the ring stands for. */
const openUsage = (store: SessionStore): void => {
  store.showPane({ kind: 'run' })
  requestAnimationFrame(() => {
    document.getElementById('run-usage')?.scrollIntoView({ block: 'nearest' })
  })
}

/**
 * The context beside the composer: the number to glance at before sending more.
 * It stays in the row when the seat folds behind +.
 */
export const ContextRing = (props: { store: SessionStore }) => {
  const t = useTranslate()
  return (
    <Show when={props.store.state().run?.usage?.context}>
      {(context) => (
        <button
          id="context-ring"
          class={'context-ring' + (nearOf(context()) ? ' near' : '')}
          type="button"
          title={
            t('usage.context') +
            ' ' +
            context().used +
            ' / ' +
            context().window +
            ' · ' +
            t('usage.compacts') +
            context().left
          }
          onClick={() => openUsage(props.store)}
        >
          <Ring context={context()} />
          <span>{String(Math.floor(context().share * 100)) + '%'}</span>
        </button>
      )}
    </Show>
  )
}
