/**
 * A named permission level a profile chooses. `auto` runs with the
 * workspace-write sandbox and has every call that can touch something outside its
 * own result reviewed first, so it adds a check rather than a wider boundary.
 */
export type PermissionPreset = 'read-only' | 'workspace-write' | 'full' | 'auto'

/**
 * How far a command's file effects may reach while it runs. The preset picks the
 * mode; the sandbox enforces it. Nothing else is what decides whether a call may
 * run: a tool that runs commands runs them, confined.
 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** The preset table: name → the mode its commands run under. */
const MODES: Readonly<Record<PermissionPreset, SandboxMode>> = {
  'read-only': 'read-only',
  'workspace-write': 'workspace-write',
  auto: 'workspace-write',
  full: 'danger-full-access',
}

/** The sandbox mode one preset runs commands under. */
export function modeOf(preset: PermissionPreset): SandboxMode {
  return MODES[preset]
}

/**
 * The modes a call running under `mode` may ask for once the sandbox denied it:
 * strictly wider ones only. `read-only` is the floor, so nothing escalates to it,
 * and the widest mode has nothing left to ask for.
 */
const WIDER: Readonly<Record<SandboxMode, ReadonlyArray<SandboxMode>>> = {
  'read-only': ['workspace-write', 'danger-full-access'],
  'workspace-write': ['danger-full-access'],
  'danger-full-access': [],
}

/** The escalation targets of one mode, narrowest first. Empty means none. */
export function widerModes(mode: SandboxMode): ReadonlyArray<SandboxMode> {
  return WIDER[mode]
}
