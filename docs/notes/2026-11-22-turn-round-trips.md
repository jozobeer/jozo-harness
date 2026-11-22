# 長いセッションの往復と出力（#305、第 2 スライス）

[#305](https://github.com/jozobeer/jozo-harness/issues/305) の残りは 2 つだった。読み取り専用の tool を並列にして、A/B の計数に step と出力トークンを足す。あわせて、計測が止まっていた 2 箇所を直した。guidance（[#307](https://github.com/jozobeer/jozo-harness/pull/307)）と `scripts/turn-metrics.ts`（[#323](https://github.com/jozobeer/jozo-harness/pull/323)）は先に入っている。

## 決めたこと

- `read` / `glob` / `grep` / `read_image` に `isConcurrencySafe: () => true` を宣言した。4 つとも `readOnly: true` で、書き込みはしない。
  - 共有するのは `observed-files` の Map だけである。同じ step で同じファイルを 2 回読むと、後から終わった観測が勝つ。両方が同じバイトを見ているので、そのあとの `write` の比較相手としてはどちらでも同じである。`write.test.ts` にその前提のテストを足した。
  - `bash` / `write` / `edit` は宣言しない。3 つは他の呼び出しと順序を持つ（`batch.ts` は宣言の無い呼び出しを 1 件だけの batch に切る）。
  - 並列度の上限は既存の `maxParallelToolCalls`（既定 10、`docs/configuration.md`）がそのまま効く。新しい knob は足していない。
- `scripts/ab/metrics.ts` に `steps`（`assistant/message` の数＝モデル往復）と `outputTokens`（その `usage.outputTokens` の和）を足した。dsh のログも同じ `assistant/message` に同じ形の `usage` を書くので、計数は 1 本で両方を読む。`METRIC_NAMES` にも足したので、`tasks.test.ts` が「regime が計数の名前で差を説明している」ことを引き続き検査する。
- `scripts/ab/table.ts` の走ごとの行と集計の行に steps と output tokens を出した。

## 直した計測の不具合

1. **jozo-harness のセルは #451 以降すべて未計数だった。** セッションの保存が `session.v1.jsonl.zst` になってからも `run.ts` は `session.v1.jsonl` を探していたので、`newestFile` が何も見つけず、jozo-harness 側の全セルが `counted 0` で「no session log」になっていた。両方の名前を探し、`.zst` なら zstd のフレームを解いて読むようにした。
2. **`long-prompt` は Linux で 1 度も走れない。** 315 KB の 1 プロンプトを 1 個の argv として渡しており、Linux は 1 引数 128 KB（`MAX_ARG_STRLEN`）で `E2BIG` にする。macOS にはこの上限が無いので、この task は platform によって走ったり走らなかったりする。
   - `spawn` が `E2BIG` を拾い、表の note にその理由と文字数を出すようにした。
   - そのうえで口を用意した。`jzh --task-file <path>` が 1 turn のタスクをファイルから読む。`long-prompt` は `promptAsFile: true` を立て、A/B が task をファイルに書いてこのフラグで渡す。task の文面そのものは変えていない（窓を越えさせる目的は変えたくない）。

## 測ったこと

`JZH_AB_HARNESS=jozo-harness` で 8 task を 1 回ずつ、`ollama-cloud/deepseek-v4.1-flash`、compaction の線は A/B の patch（窓 20,000 / headroom 4,000）。dsh はこの環境に無いので、dsh との比較は取れていない。

| task | done | steps | toolCalls | outputTokens | re-reads | compactions |
|---|---|---|---|---|---|---|
| fix-add | yes | 8 | 9 | 1,594 | 1 | 0 |
| write-notes | yes | 3 | 2 | 148 | 0 | 0 |
| rename-function | yes | 11 | 14 | 2,424 | 0 | 0 |
| fix-rules | yes | 30 | 89 | 28,520 | 0 | 0 |
| read-report | yes | 5 | 4 | 606 | 0 | 0 |
| find-disagreement | yes | 16 | 15 | 6,701 | 0 | 0 |
| recover-ambiguous-edit | yes | 8 | 8 | 1,222 | 1 | 0 |
| long-prompt | yes | 4 | 3 | 778 | 0 | 0 |

（`fix-rules` は 2 回目で steps 33 / toolCalls 32 / outputTokens 26,445 / re-reads 1。3 回目は steps 36 / toolCalls 51 / outputTokens 27,754。同じ task でも走ごとに振れるので、1 走の差は読まない。）

`--task-file` を入れた後の 8 task 一巡では、`long-prompt` を含む 8 本すべてが `done: yes` で終わった（`JZH_AB_TIMEOUT_MS=900000`、1 走ずつ）。`long-prompt` は steps 4 / toolCalls 3 / outputTokens 778 / compactions 0。**compaction は 0 で、この task は窓を越えていない**（A/B の patch は窓 20,000。line-filling のつもりだったが、この走では越えなかった）。

step の中身を `fix-rules` のログで見ると、読み取りだけの複数 call の step はこの走には無かった（並列にしても減る往復は無い）。`fix-rules` の初回の走では 12 個の `read` が 1 step にまとまっていた。issue の指摘どおり、**並列化は往復を減らさない**。減るのは tool 時間だけで、その tool 時間は turn 全体の 4% 程度である。

`read` 12 本を直列と並列で走らせた計測（`.tmp` の使い捨てスクリプト、60,000 行 × 12 ファイル）は取れなかった。`scripts/ab` の外に置いた一時テストはリポジトリの test 設定（`apps/*/tests`、`packages/*/*/tests`、`scripts/**`）に入らず、`scripts/` に置くと workspace の package 解決が効かなかったためである。代わりに実セッションのログから、複数 call の step の「呼び出しの所要の和」と「step の壁時計」を比べた（2026-11-22、`fix-rules` の初回走）: 10 step で和 1,150 ms、壁時計 542 ms。差の 608 ms が並列で縮んだ分である。**tool 時間は turn の 1〜4% なので、この短縮は issue の目標（step 190→120、1,946→1,200 秒）には効かない。**

## 目標に対する現在地

| 指標 | issue の実測（2026-10-22） | 目標 | いま |
|---|---|---|---|
| turn 1 の実時間 | 1,946 秒 | 1,200 秒以下 | 未計測（同じ依頼を長いセッションで走らせる必要がある） |
| step | 190 | 120 以下 | 未計測 |
| 出力トークン | 478,820 | 250,000 以下 | 未計測 |

上の 8 task は 1 turn・36 step 以内で終わる短いもので、issue が対象にした長いセッションではない。`long-prompt` が Linux で走らないことは直し、この環境でも 8 本すべてが完走するようになったが、それでも 1 turn の短い task である。**目標に対する判定は、まだできていない。** 次に要るのは「同じ依頼」の固定で、issue の「明確にすべきポイント」のままだ。

## 確かめたこと

- `vp test packages/core/tools-tier0 packages/core/tools-tier1 packages/core/tools packages/core/agent-loop packages/core/system-prompt apps/cli/tests/parallel-e2e.test.ts`: 81 files / 744 tests passed。
- `vp test --coverage`: 332 files / 2,458 tests passed、1 failed。落ちたのは `apps/cli/tests/real-api-e2e.test.ts` で、base profile が #466 で足した telemetry 行を test の plugin 一覧が持っていなかった（test の plugin 一覧に `sessionTelemetryPlugin` を足して直した）。直したあとは、この環境に local Ollama daemon が無いため `TRANSPORT: connect ECONNREFUSED 127.0.0.1:11434` で落ちる。**これは環境の制約で、変更の影響ではない**（変更を stash しても同じように落ちることを確かめた）。
- `vp check`（fmt / lint / typecheck）、`node scripts/doc-gate.ts`、`node scripts/duplication-gate.ts`、`cccc`、`node scripts/bundle-check.ts`: すべて通った。`bundle-check` は `vp` を PATH から呼ぶので、`node_modules/.bin` を通して走らせた。
- `JZH_AB_TASKS=read-report`、`fix-add`、`long-prompt`、`fix-rules` で `node scripts/ab/run.ts` を走らせ、上の表の数値と、`long-prompt` の note の文言を実物で見た。

## やっていないこと

- dsh との A/B 比較（この環境に dsh が無い）。
- 実ブラウザでの確認。
- 長いセッション（issue の C4 依頼）での再計測。issue の「明確にすべきポイント」にある「同じ依頼を固定する方法」は未決のままで、`scripts/ab` の task は短いものしか無い。
