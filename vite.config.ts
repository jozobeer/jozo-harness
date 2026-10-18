import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vite-plus'

// What .oxlintrc.json and .oxfmtrc.json said, in the place Vite+ reads it. The
// fmt settings are not defaults: every file in this repository is written
// without semicolons and with single quotes.
export default defineConfig({
  fmt: {
    semi: false,
    singleQuote: true,
    ignorePatterns: ['*.md'],
  },
  lint: {
    ignorePatterns: ['apps/web/dist/**'],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  test: {
    // The command reads the settings file of whoever runs it, and tests that
    // assert the default state would otherwise pass on CI and fail on a machine
    // with a config. Point the config home at one no test writes.
    env: { XDG_CONFIG_HOME: join(tmpdir(), 'jzh-test-config') },
    // The workspace's own tests, wherever a package keeps them. The built
    // browser app and scratch trees hold none.
    include: [
      'apps/*/tests/**/*.test.ts',
      'packages/*/*/tests/**/*.test.ts',
      'scripts/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      // The browser page is not this suite's to measure: it is exercised by the
      // client project's own tests and by the acceptance run in a real browser.
      exclude: ['apps/web/client-solid/**'],
    },
  },
  run: {
    tasks: {
      // cargo owns crates/; pnpm is told to leave the directory alone by
      // pnpm-workspace.yaml. Cargo has its own cache, so Vite Task keeps out.
      'rust:check': { command: 'cargo check --workspace', cache: false },
    },
  },
})
