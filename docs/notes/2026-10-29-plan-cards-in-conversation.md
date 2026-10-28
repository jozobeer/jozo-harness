# 提出された計画を会話のカードにする（#391）

plan mode の `exit_plan_mode` は計画を ask として人間に出していたが、会話には 1 行の tool call しか残らなかった。回答が済むと question の takeover も消えるので、何を承認したのか、なぜ差し戻したのかを後から読めなかった。この記録は、どこから計画と verdict を読むことにしたかと、受け入れをどう確かめたかを残す。

## 決めたこと

計画は `tool/call` の `arguments.plan`、回答は `interaction/ask/answered` から読む。ask の `id` は tool の `callId` と同じ値で書かれるため、両者はログの上で結び付く。どちらもセッションログにあるので、カードは再読み込みでも `--resume` でも同じ内容で折り直せる。別の保存先は持たない。

承認かどうかは、tool が ask に渡した `options` の先頭と回答を比べて決める。`approve` という語を UI 側に複製すると、tool の選択肢を変えたときにカードだけが古い語を見ることになる。

カードは process の折り畳みの外に置く。計画は turn の答えであり、作業を畳んだ読み方でも隠れないほうがよい。24 行を超える計画だけカードで畳み、全文は右ペインの `計画` タブで読む。

## 受け入れの照合

- 計画が会話にカードとして残り、再開しても読める: `apps/web/tests/plan.test.ts` がログから計画と verdict を折り直す。`apps/web/client-solid/tests/app.test.tsx` の「the plan a model proposed」がカードの verdict と本文を確かめる。
- 承認と差し戻しがログに残り、理由がモデルへ届く: カードのボタンは composer の ask と同じ `answer` コマンドを送る。回答は `interaction/ask/answered` としてログに残り、`exit_plan_mode` はその文字列をそのまま返す。
- 全文を右ペインで Markdown として読める: `計画` タブが `planToolOf` で callId から計画を引き、全文を描く。

## 測った値

`pnpm run check`（2026-10-29）:

- tests 2311 passed / 3 skipped（322 files、skip は既存の real-api-e2e のみ）
- coverage lines 94.62%（床 93%）、functions 92.10%（床 92%）
- fmt / lint / typecheck / doc gate / duplication / complexity / cargo check はすべて通過

`pnpm run build:web` も通過。CSS 80.90 kB、JS 430.90 kB（gzip 15.42 kB / 138.51 kB）。
