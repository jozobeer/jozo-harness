# 推論の翻訳（#401）

## 受け入れ条件（issue 本文から）

- 展開した推論に、訳文を並べられる。
- ログに残る推論の原文は、翻訳の前後で変わらない。
- 翻訳できないときは原文だけが出て、失敗が原文を消さない。

## 対象

表示中の処理（`Worked` の折りたたみ）を開いたときの、1 つの推論を対象にする。セッション全体をまとめて訳すと、読まない推論までモデルに送ることになり、待ち時間と費用が読む量に比例しなくなる。ページは assistant message の seq だけを送り、サーバがログの本文を読む。

## 実装

- `packages/core/session/src/reasoning-translation.ts` が `reasoning/translation` イベントを定義する。原文の `assistant/message` は書き換えず、訳文を別の行として追記する。このイベントは log-only に登録し、次のリクエストの履歴には入らない。
- 訳はセッションの route への 1 往復（`LlmAdapter.stream` を 1 回）。tools は空、params は空で送る。同じ target の訳が既にログにあれば、モデルを呼ばずに返す。
- Web の `translateReasoning` RPC は、成功を `{kind:'translated'}`、失敗を `{kind:'failed', reason}` で返す。失敗は原文を消さず、カードの中に理由を出す。
- `apps/web/src/ui/trace.ts` は `reasoning/translation` を target の step に畳む。原文の `reasoning` はそのまま。
- 表示は原文の下に `translation` を並べ、訳があるときは翻訳ボタンを出さない。処理を開いたときに読めるよう、推論の行は折り返す。

## 検証

- `vp test packages/core/session/tests/reasoning-translation.test.ts` — 7 tests
- `vp test apps/web/tests/trace.test.ts` — 14 tests
- `vp test apps/web/tests/server.test.ts` — 54 tests
- `vp -C apps/web/client-solid test` — 243 tests
- `pnpm run build:web` — built
- `pnpm run check` — pass（fmt / lint / typecheck / doc gate / duplication / complexity / cargo check / client tests / coverage の床）
