import { splitProps, type JSX } from 'solid-js'

export interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * The weights the page needs; primary is the human's move, so it wears gold. On
   * a glass that waits on the reader the gold is all around, so its buttons are
   * foam (the move), a rim (the way out), or a scoop of foam (one choice of many).
   */
  readonly variant?: 'default' | 'primary' | 'quiet' | 'foam' | 'rim' | 'scoop'
  /** How much room it takes: a word's width, or one square for an icon alone. */
  readonly size?: 'default' | 'icon'
}

const VARIANTS: Readonly<Record<NonNullable<ButtonProps['variant']>, string>> = {
  default: 'border-line bg-bg-hover text-text hover:border-dim',
  primary:
    'border-accent-fill bg-accent-fill text-accent-ink hover:border-accent-fill hover:brightness-110',
  quiet:
    'border-transparent bg-transparent text-dim hover:border-transparent hover:bg-bg-hover hover:text-text',
  foam: 'border-foam bg-foam text-beer-ink shadow-[0_1px_2px_rgb(42_29_2/25%)] hover:brightness-105',
  rim: 'border-beer-ink/45 bg-transparent text-beer-ink hover:border-beer-ink',
  scoop: 'border-beer-ink/18 bg-foam/80 text-beer-ink hover:bg-foam',
}

/**
 * The button shadcn-solid ships, wearing this page's palette. A copy rather
 * than a package: the component is ours to change, which is the point of the
 * copy-in the port decided on.
 */
export const Button = (props: ButtonProps) => {
  const [local, rest] = splitProps(props, ['variant', 'size', 'class'])
  return (
    <button
      {...rest}
      class={[
        'inline-flex cursor-pointer items-center gap-2 rounded-[6px] border text-[13px] leading-none font-medium transition-colors',
        VARIANTS[local.variant ?? 'default'],
        // The sheet gives an icon square its padding; a padding utility would win
        // over that rule and leave no room for the glyph.
        local.size === 'icon' ? 'btn-icon' : 'px-[14px] py-[7px]',
        local.class ?? '',
      ].join(' ')}
    />
  )
}
