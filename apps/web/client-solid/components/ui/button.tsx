import { splitProps, type JSX } from 'solid-js'

export interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  /** The three weights the page needs; primary is the human's move, so it wears amber. */
  readonly variant?: 'default' | 'primary' | 'quiet'
  /** How much room it takes: a word's width, or one square for an icon alone. */
  readonly size?: 'default' | 'icon'
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
        'inline-flex cursor-pointer items-center gap-2 rounded-[6px] border px-[14px] py-[7px] text-[13px] leading-none font-medium transition-colors',
        local.variant === 'primary'
          ? 'border-accent bg-accent text-accent-ink hover:border-accent hover:brightness-110'
          : local.variant === 'quiet'
            ? 'border-transparent bg-transparent text-dim hover:border-transparent hover:bg-bg-hover hover:text-text'
            : 'border-line bg-bg-hover text-text hover:border-dim',
        local.size === 'icon' ? 'btn-icon' : '',
        local.class ?? '',
      ].join(' ')}
    />
  )
}
