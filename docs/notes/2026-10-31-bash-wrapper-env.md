# bash の env が sandbox helper を差し替えていた

`bash` の `env` は `childEnvironment` に混ぜて、sandbox が包んだ argv の `spawn` にそのまま渡していた。helper（`bwrap`、`landlock-run`、`sandbox-exec`）は閉じ込めの前に exec されるので、呼び出しが渡した `PATH` で別の helper を起動でき、`LD_PRELOAD` / `DYLD_INSERT_LIBRARIES` で helper 本体にライブラリを読ませることができた。

閉じ込めがある呼び出しでは、その名前を helper の環境から外してプロセスの値に戻し、同じ代入をシェルのスクリプト（セッションは既存の代入）で helper の内側に置く。`sandbox: none` と `danger-full-access` は helper が無いので、これまでどおり環境を直接渡す。

確認:

```sh
vp test packages/core/tools-tier0/tests/bash.test.ts packages/core/tools-tier0/tests/managed-env.test.ts packages/core/tools-tier0/tests/bash-session.test.ts
```
