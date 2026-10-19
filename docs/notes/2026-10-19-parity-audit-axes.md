# DSH パリティ監査の軸（2026-10-19）

2026-10-18 の監査は、prompt cache と context window の差を「環境の違い」として正規化し、監査の外に置いた。その結果、production で最も効く 2 つの差（cache が 0、62k での compaction）を 2026-10-19 まで見落とした。次回の監査で同じ見落としをしないため、軸と「何を正規化したか」の記録方法をここに固定する。

軸と正規化の記録は `docs/notes/` に置く。`.tmp/audit/LEDGER.md` は作業中の台帳であり、`.tmp/` は残らない。監査の正本はこのノートと、そこから参照する各回の記録である。

## 監査の軸

各軸は「production の値」と「比較のために正規化した値」を分けて記録する。production の値は profile と adapter の設定から取り、モデルのカタログ値とは区別する。

| 軸 | 記録する値 | production の確認先 | 正規化するときの注意 |
|---|---|---|---|
| provider / transport: endpoint | 実際に叩いた URL、local daemon に届いたか | `baseUrl` と `localBaseUrl`（`jzh:packages/bundle/base/profiles/base.yml:30`）。`localBaseUrl` があれば常に local、なければ cloud（`jzh:packages/llm/llm-openai/src/plugin.ts:64`） | cloud に固定すると暗黙の prefix cache が消える。cache の差は測れなくなる |
| provider / transport: prompt cache | `cacheReadTokens`、`cacheWriteTokens`、明示制御の有無 | wire は `prompt_tokens_details.cached_tokens`（`jzh:packages/llm/llm-openai/src/sse.ts:52`）、usage は `LlmUsage`（`jzh:packages/llm/llm/src/types.ts:38`）、集計は `jzh:packages/core/session/src/usage-stats.ts:57` | 明示 API が無いことは暗黙 cache が無いことを意味しない。`promptCacheControl: false`（`jzh:packages/llm/llm-openai/src/plugin.ts:80`）は明示制御だけを言う |
| provider / transport: streaming | chunk が到着順に届くか、finish の flush、idle timeout | SSE の読み取りは `jzh:packages/llm/llm-openai/src/adapter.ts:132`、idle の既定は 300,000 ms（チャンク間、`jzh:packages/llm/llm-openai/src/adapter.ts:26`） | 全体時間のタイムアウトに読み替えない |
| provider / transport: retry | 再試行する code、回数、待ち時間 | `jzh:packages/core/agent-loop/src/retry.ts:6`（既定 maxRetries 5、初回 500 ms、上限 10 s、RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT / EMPTY_RESPONSE） | 再試行を足すと step 数と latency が変わる。失敗の種類ごとに分ける |
| provider / transport: model metadata | route、モデル名、contextWindow / maxTokens と宣言元 | base profile の `models`（`jzh:packages/bundle/base/profiles/base.yml:44`）と adapter の `LlmCapabilities`（`jzh:packages/llm/llm/src/types.ts:84`） | profile の既定値とモデル定義を混ぜない。A/B の dsh patch は 52,768 / 32,768 を宣言する（`jzh:scripts/ab/dsh-provider.patch.yml:20`） |
| production defaults: context window | 窓のトークン数と宣言元 | 既定ルートは 1,048,576（`jzh:packages/bundle/base/profiles/base.yml:46`） | 128,000 を既定と思わない。窓はモデルごとの `models` から読む |
| production defaults: max output | 出力予約と wire の `max_tokens` | 既定ルートは 393,216（`jzh:packages/bundle/base/profiles/base.yml:47`） | 予約を compaction の線から引くかどうかを分けて書く |
| production defaults: compaction line | `contextWindow` / `thresholdRatio` / `headroomTokens` / `maxTokens` と計算した線 | 既定は `min(1,048,576 × 0.8, 1,048,576 − 393,216 − 65,536) = 589,824`（[設定](../configuration.md)） | A/B の 16,000 は比較用の線であり、production の線ではない |
| production defaults: profile route | `provider/model` と profile 名 | 既定ルートは `ollama-cloud/deepseek-v4.1-flash`。model key は route の model 名と同じ `deepseek-v4.1-flash`（[設定](../configuration.md)）。local daemon へは wire で `:cloud` を付けるが、route と model key には付けない | route を変えると窓・cache・endpoint が同時に変わる。軸ごとに分けて記録する |

## 正規化の規則

- 監査ノートには「正規化した軸」の表を必ず置く。列は 軸 / production の値 / 正規化した値 / 正規化した理由 / その結果として言えなくなること とする。
- 正規化した軸は「差が無いことの証拠」に使わない。正規化は差を測れなくする操作であり、差が無いことの証明ではない。
- 各軸について、少なくとも 1 セルは production の既定のまま走らせる。正規化した比較とは別のセルとして記録する。
- production のセルには `cacheReadTokens`（usage）と compaction の件数（ログ。jozo-harness は `compaction/checkpoint`、dsh は `compaction/summary`）、step 数を必ず記録する。0 件も記録である。
- モデルの窓・出力予約は、profile の既定値ではなく、その走の `request/header` の route と、その route に対応する profile の `models` から読む。

## 2026-10-14 A/B で正規化した軸

| 軸 | 当時の production | A/B の値 | その結果として言えなくなること |
|---|---|---|---|
| endpoint | local daemon が答えれば `http://127.0.0.1:11434/v1`、答えなければ `https://ollama.com/v1` | 両ハーネスとも `https://ollama.com/v1`。dsh は `jzh:scripts/ab/dsh-provider.patch.yml` で固定した | prompt cache の差、endpoint 由来の latency の差 |
| compaction line | 62,464（窓 128,000、headroom 65,536） | 16,000（jozo-harness は窓 20,000 / headroom 4,000、dsh は窓 52,768 / 予約 32,768 / headroom 4,000） | 当時の production の窓での compaction の回数・位置の差 |
| model metadata | モデル定義を宣言せず、窓 128,000 の既定に落ちていた | jozo-harness は窓 20,000、dsh は 52,768 / 32,768 | モデル定義の窓に由来する差 |

この A/B の「ハーネス由来の系統差は観測されなかった」は、endpoint と compaction の線をそろえた範囲の主張である。cache と production の線については何も言っていない。production の既定のまま走らせた A/B セルはまだ無い。

2026-10-18 の監査は、さらにモデル metadata を読み違えた。監査ノートの「実窓（128,000 / 線 62,464）」は profile の既定値であり、既定ルートのモデル定義（1,048,576）ではなかった。現在の base profile では線は 589,824 である。既存の A/B タスク（`find-disagreement` は約 87,780 推定トークン、`long-prompt` は約 78,750）はこの線に届かないので、production の線での compaction は 0 件になる。compaction の差は、線を下げたセル（正規化）と、production の線を越えるタスク（未作成）を分けて測る。

次回は、local daemon が答える状態で両ハーネスの endpoint を local daemon にし、dsh は窓・compaction 行を patch しない版（未作成）、jozo-harness は `JZH_AB_SHIPPED_WINDOW=1` で 1 セル以上走らせ、`cacheReadTokens`、compaction の件数、step 数を記録する。タスクは `find-disagreement` を使う。cache は local daemon の prefix cache が効くかを、compaction は 0 件を、それぞれ production の値として記録する。

## 決めたこと

- 軸の置き場は `docs/notes/` にする。`.tmp/audit/LEDGER.md` は作業メモであり、正本にしない。
- endpoint が違うセルの latency と tool 行動は混ぜない。tool calls は同じ endpoint のセルだけで比べ、endpoint 由来の latency は別の列に置く。
- `request/context` はキャッシュの理由では除外しない。除外するのは「イベント列から再構成でき、記録形式が重複する」ときだけである。
- 定期監査の再開はこのノートでは決めない。次回は手動で回し、記録を `docs/notes/` に足す。

## 完了条件

- 監査ノートに、監査した軸と正規化した軸が並んでいる。
- production の既定のまま走らせたセルが 1 つ以上あり、`cacheReadTokens`、compaction の件数、step 数が記録されている。
- kernel 設計の除外表で、「明示 API が無い」と「暗黙の挙動が無い」が分けて書かれている。cache は明示 API が無くても除外しない。
- `request/context` を外す理由が「記録形式が不要」に狭まっている（キャッシュ効果の有無を理由にしない）。
