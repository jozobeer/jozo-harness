import { For, Show } from 'solid-js'
import { isLongPlan, planOf, type PlanVerdict } from '../../src/ui/plan.ts'
import type { TraceTool } from '../../src/ui/trace.ts'
import { useTranslate } from '../i18n.ts'
import type { MessageKey } from '../locale.ts'
import type { SessionStore } from '../store.ts'
import { Markdown } from './markdown.tsx'
import { Button } from './ui/button.tsx'
import { Icon } from './ui/icon.tsx'

/** What the card calls each way a plan can stand. */
export const PLAN_VERDICTS: Readonly<Record<PlanVerdict, MessageKey>> = {
  proposed: 'plan.proposed',
  approved: 'plan.approved',
  kept: 'plan.kept',
}

/**
 * The plan a model proposed, as a card that stays in the conversation: the
 * verdict, the plan itself, and the same question's choices as the composer
 * offers. The answer travels the ask path, so the log keeps it and the model
 * reads the reason the human kept planning.
 */
export const PlanCard = (props: { tool: TraceTool; store: SessionStore }) => {
  const t = useTranslate()
  const plan = () => planOf(props.tool)
  return (
    <Show when={plan()}>
      {(shown) => (
        <article class={'plan-card ' + shown().verdict} data-plan={props.tool.callId}>
          <header class="plan-head">
            <Icon name="plan" class="plan-icon" />
            <strong class="plan-title">{t('plan.title')}</strong>
            <span class="plan-verdict">{t(PLAN_VERDICTS[shown().verdict])}</span>
            <button
              class="plan-open"
              type="button"
              onClick={() => props.store.showPane({ kind: 'plan', callId: props.tool.callId })}
            >
              {t('plan.open')}
            </button>
          </header>
          <details class="plan-body" open={!isLongPlan(shown().text)}>
            <summary class="plan-fold">{t('plan.fold')}</summary>
            <Markdown text={shown().text} class="body" />
          </details>
          <Show when={shown().verdict === 'kept' && shown().reason !== ''}>
            <p class="plan-reason">
              <span class="plan-reason-label">{t('plan.reason')}</span>
              {shown().reason}
            </p>
          </Show>
          <Show when={shown().verdict === 'proposed' && shown().options.length > 0}>
            <div class="plan-actions">
              <For each={shown().options}>
                {(option, index) => (
                  <Button
                    variant={index() === 0 ? 'foam' : 'rim'}
                    type="button"
                    data-plan-answer={option}
                    onClick={() =>
                      props.store.send({
                        kind: 'answer',
                        id: props.tool.callId,
                        answer: option,
                      })
                    }
                  >
                    {option}
                  </Button>
                )}
              </For>
            </div>
          </Show>
        </article>
      )}
    </Show>
  )
}
