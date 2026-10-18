# PTC（run_code）の最小縦切り（2026-10-18）

## 決めたこと

- tier1 に `run_code` を足す。引数は `code`（async 関数の本体）だけで、子プロセス（`@jozo-harness/process`）で走らせる。
- プログラムは `await tools.name(args)` で可視の tool を呼べる。呼び出しは JSON 行で親に戻り、親は同じ tool registry の `call` に渡すので、policy・承認・hook は直接呼んだときと同じ経路を通る。
- 子の stdout は 1 行 1 メッセージ（先頭 `\u001e`）。接頭辞の無い行はプログラムの標準出力としてそのまま会話に返す。戻り値は `return: <JSON>` として末尾に足す。
- 上限は宣言で持つ。`timeoutMs` は `RUN_CODE_TIMEOUT_MS`（30 秒）、出力量は `RUN_CODE_OUTPUT_LIMIT`（16,000 文字）で、切ったときは `[output truncated after N characters]` を付ける。timeout は pipeline の `Effect.timeout` が効き、finalizer が子プロセスを kill する。
- 子は run の sandbox で wrap する（`RunCodeHost.sandbox`）。sandbox が無い構成では wrap しない。

## 今回やらないこと

- persistent-in-memory（dsh #5035）。呼び出しごとに新しいプロセスを起こす per-call のみ。
- Python、型宣言（SDK）の system prompt への描画、run_code の中の呼び出しを 1 枚に畳む UI、外側 1 回の承認への集約。
- TypeScript の型注釈はまだ実行できない。子は `new AsyncFunction` で JavaScript として評価する。

## 既存の決定との関係

workflow の「JS のオーケストレーション engine を持たない」決定（S6 の決定 4）は変えない。run_code は tool 呼び出しの束ねであって、子 agent をスクリプトで回すものではない。モデルが書いたコードを harness が実行する点だけが新しいので、設計文書に日付つきで追記した。

## 確かめたこと

```sh
XDG_CONFIG_HOME=$(mktemp -d) pnpm exec vp test packages/core/tools-tier1 packages/core/tools
pnpm run typecheck
pnpm run complexity
XDG_CONFIG_HOME=$(mktemp -d) pnpm exec vp test apps/cli/tests/snapshot.test.ts
```

いずれも通った。snapshot は tool 一覧に `run_code` が増えた分を再生成した。

## 次

- system prompt に可視 tool の型宣言を描く（`output.schema` から）。
- 中の呼び出しの承認を、外側の run_code 1 回にまとめるか、呼び出しごとに出すかを決める。
- 子プロセスの停止を #158（子孫まで止める）に合わせる。Linux の sandbox は #159。
