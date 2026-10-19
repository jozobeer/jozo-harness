# DSH との差を埋めるための残りリスト（2026-10-14 夜）

同日の [dsh のギャップ表](2026-10-14-dsh-gap-backlog.md)の31項目はすべて実装・検証済み。本ファイルはその後の実測で残った差分を列挙する。優先度は付けない。上から依存関係の順に片付ける。

- `dsh:` は DSH リポジトリ（`/Users/hondazn/git/github.com/hondazn/deepseek-harness`）のルートからのパス。
- `jzh:` はこのリポジトリのルートからのパス。
- 起票時の実測は 2026-10-14 22:50 で、`bun run check` は 742 pass / 1 skip / 0 fail（743 テスト / 189 ファイル）。このリストを片付けた後の `bun run check` は 798 pass / 1 skip / 0 fail（799 テスト / 195 ファイル）、coverage は lines 94.61% / functions 93.53%（床は 93% / 92%）。

## 実装度（重み付き 約95%）

| 層 | 重み | 実装度 | 主な残り |
|---|---|---|---|
| 核・実行機構 | 15% | 95% | なし（ログの忠実性は回復済み） |
| モデルに見える文脈 | 30% | 95% | なし（閾値・要約・meter・pruner が入った） |
| ツール実行面 | 20% | 95% | 説明文の総量は DSH より少ないが、回復手順は全 tool にある |
| 自律性・委譲 | 20% | 95% | repeat は配線済み、workflow は決定で充足 |
| 安全・耐久 | 10% | 80% | zstd 圧縮・lease・export・trace は持たない（v1 の規模の外） |
| UI・提示・検証 | 5% | 95% | なし（A/B は 4 タスク × n=3 の範囲。長いタスクは発火点 16,000 で測った） |

## 0. 作ったのに効いていない（先に片付ける）

- [x] **repeat リマインダーの配線**（実測で既に閉じていた）。`installRepeatReminders` は `jzh:apps/cli/src/index.ts:644` で agent ごとに `tools/post-execute`（prepend）へ登録され、結果を組む前に他の listener を通す。登録 0 箇所という前回の実測は誤りで、テストだけでなく出荷経路に載っている。受け入れ: e2e `jzh:apps/cli/tests/repeat-reminder-e2e.test.ts` が同じ `todo_write` を3回呼び、3回目の結果にリマインダが載り、その次のリクエスト本文にも入ることを観測する。

## 1. モデルに見える文脈（層2）

- [x] **runtime context の残り2種**（実測で既に閉じていた）。`builtinContexts` は cwd と時刻だけだが、`jzh:packages/core/safety/src/plugin.ts:64` の `policyLayerWithContexts` が同じ registry に `approval` と `sandbox` を order 20/21 で登録するので、出荷構成の snapshot は 4 種である。受け入れ: e2e `jzh:apps/cli/tests/runtime-context-e2e.test.ts` が `cwd:`・`time:`・`approval: workspace-write`・`sandbox: seatbelt` の4行を確かめ、`working_directory` で cwd が変わったときに snapshot が1枚だけ増えることを観測する。
- [x] **compaction の閾値**。`meterOf`（`jzh:packages/core/session/src/token-meter.ts`）が推定した次リクエストのトークン量を、`contextWindow × thresholdRatio` と `contextWindow - headroomTokens` の小さい方と比べ、越えたときだけ `recordCompaction` が動く（既定 0.8 / 65,536 / 128,000）。contextWindow は profile の agent-loop config か、adapter の `LlmCapabilities.contextWindow` から取る（`jzh:packages/llm/llm/src/types.ts`）。予算内では reasoning も落とさず、そのまま送る。受け入れ: e2e `jzh:apps/cli/tests/compaction-e2e.test.ts` の「a conversation with room left is sent untouched」が同じ履歴・同じ prune price で budget だけを変え、予算内は compaction イベント 0 件・元の文がそのまま、超過時だけ置き換わることを示す。
- [x] **compaction の要約**。閾値を越えると、retention の外の範囲を補助 LLM 呼び出し（同じ route、指示を末尾に足し、tools を外す）で構造化要約し、`compaction/checkpoint` として `{ shadowedSeqs, shadowedRange, summary, provider, model }` を記録する。projection が範囲を1件の user メッセージに置き換えるので、ログの元イベントは残り、範囲は seq で辿れる。要約が空・失敗なら checkpoint を書かず、従来の `compaction/prune`（stub）が受け皿になる。checkpoint のメッセージは prune の対象外。受け入れ: `jzh:packages/core/session/tests/checkpoint.test.ts` 7本と e2e の「an old span becomes one summary the next request carries」「a summarizer that cannot answer leaves the prune as the fallback」。
- [x] **token meter**。`meterOf(events, budget)` は、最後に usage を持つ `assistant/message` の input+output を土台にし、それ以降のイベントだけを UTF-8 バイト / 4 で見積もって次リクエストの圧力とする（状態を持たず、resume でも同じ）。`source` が 'usage' か 'bytes' かを返す。受け入れ: e2e「what the provider counted is what pushes the request over」が、バイトは同じで報告 usage だけ 900+50 / 5+5 と変え、閾値を切った側だけが compaction することを示す。
- [x] **tool-result pruner と image offload**。dsh は別プラグインだが、jozo-harness は compaction の prune 規則の中に持つ（パッケージを増やさない）。retention の外では、tool 結果の text が 8,192 字を超えたら head 4,096 字 + `[... tool result middle pruned ...]` + tail 1,024 字を残し（コードポイント単位で surrogate pair を割らない）、image ブロックは `[image offloaded: <name>; read it again with the read_image tool to see it]` に置き換える。受け入れ: `jzh:packages/core/session/tests/compaction.test.ts` の3本（head/tail 保持、価格内は無変更、画像が参照になり fold から base64 が消える）。
- [x] **AGENTS.md の候補名**。既定の候補を `AGENTS.md` / `CLAUDE.md`、ローカル上書きを `AGENTS.local.md` / `CLAUDE.local.md` にし、1 ディレクトリにつき base → local の順で読む（`jzh:packages/core/system-prompt/src/agents-md.ts`）。home は dsh と同じく `AGENTS.md` だけ。受け入れ: 単体テスト2本と e2e `jzh:apps/cli/tests/agents-md-e2e.test.ts` の「CLAUDE.md だけの作業ディレクトリ」で、内容がプロンプトに入る。

## 2. ツールの深さ（層3）

- [x] **説明文の量**。失敗からの回復手順を説明本文に書いた: read は footer が続きを言ったら offset で呼び直す、edit は no match か複数一致なら読み直して正確な文字列を引く、bash は spill されたら保存先を offset/limit で読む。write・glob・grep にも同じ 1 文を足した。あわせて `toolSchemaIssues` を入れ子の object と配列 item まで降ろし（`jzh:packages/core/tools/src/schema-check.ts`）、`jzh:packages/core/tools-tier1/tests/schema.test.ts` は tier 1 の全 tool（subagent・team・workflow・schedule・goal・plugin・exit_plan_mode を含む）を検査する。前回の「9,184 B / 108 箇所」は広い集合の数字で、既定 profile の実測は 19 tool / 45 パラメータ / 3,251 B、説明の無いパラメータは 0。受け入れ: `jzh:apps/cli/tests/tool-schema-e2e.test.ts` と上記 unit test が指摘ゼロを要求する。
- [x] **edit の CRLF とバイナリ**。`readForEdit` が NUL バイトを decode の前に拒否し、LF に正規化した本文と元の ending を返す（`jzh:packages/core/tools-tier0/src/text.ts`）。edit は編集後に `restoreLineEndings` で書き戻すので、CRLF のファイルは CRLF のまま。受け入れ: `jzh:packages/core/tools-tier0/tests/edit.test.ts` に CRLF 保持と NUL 入りファイルの拒否の2本を追加（読み直せない非 UTF-8 のファイルは従来どおり read の段で止まる）。
- [x] **glob の並び順と grep の上限**。`walkFiles` に `order: 'modified'` を足し、glob は更新時刻の古い順になった。glob / grep は既定 100 / 250 件を inline の page とし、`SEARCH_PAGE_BYTES` 30,000 の範囲で切り、超過分は `writeSpill` でセッション横のファイルに保存して locator と読み方（read の offset/limit）を返す。locator を渡す seam は `ToolRunContext.spill` で、場所は loop が持ち、何を保存するかは tool が決める。grep の一致行は 2000 字で切る。受け入れ: `jzh:packages/core/tools-tier0/tests/search.test.ts` の mtime 順・locator の2本と、e2e `jzh:apps/cli/tests/search-recovery-e2e.test.ts`（2000 件の検索で page 250 + 全量ファイル + 次のリクエストで tail を読む）。
- [x] **bash の退避通知**（実測で充足していた）。一般の退避通知 `[spilled to <path>: N lines, M bytes. Use the read tool with offset and limit to page through it.]`（`jzh:packages/core/tools/src/spill.ts`）は、dsh の `[output truncated; full output: <path>]` が持つ要素（退避先のパス・行数・読み方）をすべて含む。bash 専用の文言ではないが、モデルが次に取る行動は同じである。受け入れ: e2e `jzh:apps/cli/tests/spill-recovery-e2e.test.ts` が bash の 32 KB 超出力で通知のパスを取り、次の step でそのファイルを read して末尾を読む。違いは preview が末尾ではなく先頭であること（dsh は末尾を残す）。
- [x] **除外したツールの方針変更**。除外は変えない、と [kernel 設計の表](../superpowers/specs/2026-10-13-jozo-harness-kernel-design.md) の追記で決めた。再検討したのは `present`（提示層の判断に合わせて持たない）と `terminal`（bash と job_* で足りる）で、他は当初の理由のまま。あわせて実装で古くなっていた 2 行（`workflow` は採用、`schedule` は採用済み）を直した。

## 3. 自律性（層4）

- [x] **repeat リマインダー**（0 と同じ。実測で既に配線済みで、e2e が次リクエストへの注入を観測する）。
- [x] **workflow の編成**。前段の出力を後段に渡すパイプラインは要らない、と [S6 の決定 4](../superpowers/specs/2026-10-13-jozo-harness-tier3-design.md) の追記で決めた。理由は、dsh の hook がスクリプト engine の一部であること、段を跨ぐ依存は workflow の再呼び出しで表せ、後段の子は親のログから fork するので前段の結果を最初から履歴に持つこと（`forkSeed` が落とすのは最後の `user/message` だけ）、段ごとの往復のコストは「同一タスクの A/B」で測ってから engine を足すこと。受け入れは決定そのものなので、テストは要らない。
- [x] **goal の権限規則**。`turnHasSource` / `inHumanTurn` / `inGoalRound` を `jzh:packages/core/tools-tier1/src/goal-state.ts` に置き、最後の `turn/start` から先だけを見る。pause / resume は human source の message がある turn でだけ動き、モデルが自分で始めた round では拒否される。blocked は自動 round で `MIN_BLOCKED_ROUNDS`（3）未満なら拒否し、人間の turn があれば round 数に関係なく許す。前回の `inAutomaticRound` は「最後の user/message が goal-round か」だけを見ていたので、round の途中に steer（source: inject）が入ると閾値をすり抜けた——いまは open turn を走査する。受け入れ: unit 9 本（pause/resume の拒否、steer が入った round の blocked 拒否、人間の turn の blocked 許可）と e2e `jzh:apps/cli/tests/goal-rounds-e2e.test.ts`（実際の round で pause が拒否され、goal は paused にならない）。

## 4. 耐久（層5）

- [x] **session の読み出し機構**。一覧は `readFirstLine` で先頭行だけを読み、10,000 イベントのログでも本文を運ばない（`jzh:packages/core/session-jsonl/src/first-line.ts`）。検索は同じ root に置く SQLite FTS5 の索引（`index.v1.sqlite`）で引き、変更のあったファイルだけを `(mtimeMs, size)` で再索引し、消えたセッションを落とす（`src/query.ts` の `sync` / `search`）。索引は生の JSONL 行から作り、event schema に依存しない（decode できない行も検索でき、切れた末尾は読み飛ばす）。CLI は `jzh sessions --search <text>`。zstd 圧縮・flock lease・ZIP export・trace は持たない（v1 の規模の外）。受け入れ: `jzh:packages/core/session-jsonl/tests/query.test.ts` に 10,000 イベントの一覧 <1s・512 MB の sparse tail でも一覧が本文を読まないこと・索引の増分更新・削除の反映、e2e `jzh:apps/cli/tests/sessions-e2e.test.ts` に `--search` の実走。
  - **2026-10-16 追記**: 一覧は名前も読む。`readTitle` が同じ 64 KB の予算で先頭から最初の user/message を探し、`SessionSummary.title` に入れる（`jzh:packages/core/session-jsonl/src/title.ts`）。本文全体を運ぶことは変えていない。512 MB の sparse tail と 10,000 イベントの一覧は同じ予算のまま通る。
- [x] **複数 consumer**。`SessionObservation` が 1 つの不変カット（header・events・file revision）を貸し出し、`retain()` で同じカットを別の読み手に渡し、`dispose()` で自分の lease だけを返す。カットはファイルの revision が変わらない限り再利用され、最後の lease が返ると捨てられる（`jzh:packages/core/session-jsonl/src/query.ts`）。UI host の fan-out（複数タブ）はそのまま。読み出し経路（`jzh sessions <id>`）はこの observation を通るので、共有の実消費者がいる。受け入れ: `tests/query.test.ts` の「hands the same cut to every reader that retains it」（同一 events 配列の共有、lease が生きている間は再読み込みしない、全部返すと読み直す）と「a file that changed since the cut is read again」。
- [x] **除外した基盤**（telemetry、identity、settings UI、credentials サービス）。除外は変えない、と [kernel 設計](../superpowers/specs/2026-10-13-jozo-harness-kernel-design.md) の追記で決めた。telemetry・identity・credentials は D5 の理由のまま、settings UI は `jzh config` / `--dump-config` / 承認つき `plugin` ツールで足りる。

## 5. 検証機構（層6）

- [x] **記録の corpus**。7 シナリオ（既存 2 + 追加 5）。追加は tool 失敗、承認拒否、compaction 発火、resume、subagent。harness を広げた: `Scenario` が `resumeTask`（同じログから 2 turn 目を開く）、`extraRows`（agent-loop の予算を小さくして compaction を起こす）、`subagents` を持ち、snapshot は 1 回の実行が残した**全セッション**のログを正規化テキスト順に並べる（subagent の子のログも残り、並び順が安定する。`jzh:packages/test-support/replay/src/scenario.ts`）。1 つの step カウンタが resume と子のストリームを順に配る。受け入れ: 5 本それぞれに印（isError、approval/requested と denied、compaction/checkpoint、turn/start 2 つ、session 区切り）が入り、`UPDATE_SNAPSHOTS` 無しの再生が 3 回連続で全緑。
- [x] **coverage 閾値**。`bun run check` は `scripts/coverage-gate.ts` を通す。lcov の LF/LH と FNF/FNH を合計し、lines 93% / functions 92% を下回ると、どの指標が落ちたかを stderr に出して 1 で終わる（2026-10-14 の実測は lines 94.58% / functions 93.49%）。bunfig の `coverageThreshold` は使わない——Bun 1.4.3 は値（0.01 でも）を読んだうえで毎回無言で失敗する。受け入れ: 床を 99 に上げると `bun run check` が `jzh: coverage fell below the floor: lines, functions` で落ちることを実走で確認した。
- [x] **doc gate・重複検出・real-API lane**。
  - doc gate: `scripts/doc-gate.ts` が docs/ と README の相対リンクと `jzh:<path>` 参照を解決し、無ければ 1 で落ちる（全 .md、起票時 18 ファイル）。既に壊れていた 5 本のリンクも直した。受け入れ: README に切れたリンクを足すと `README.md: link points nowhere` で落ちる。
  - 重複検出: `scripts/duplication-gate.ts` が jscpd を bunx で走らせ、production の src と scripts で 12 行 / 70 トークン以上の反復が 1 つでもあれば落ちる（tests と fixtures は除外）。初回に実際 1 件見つかり、`childAnswerOf` を共有して消した（`jzh:packages/core/tools-tier1/src/child-answer.ts`）。jscpd は devDependency にできなかった——`bun add` が sandbox の外の temp dir に書けず EPERM になるため bunx で取る（初回のみ net が要る）。受け入れ: 同じ 15 行を 2 つの src に足すと `1 duplicated runs` で落ちる。
  - real-API lane: `jzh:apps/cli/tests/real-api-e2e.test.ts` が `OLLAMA_API_KEY` の無い環境では skip し、あるときは出荷 profile で 1 turn を走らせ、外部状態（書かれたファイル）だけを判定する。鍵は CLI と同じく環境変数から取る（`~/.config/jzh/secrets.env` は読まない）ので、既定の `bun run check` をネットワークに触らせない。この環境では未設定なので skip のままである（A/B の jozo-harness 走は CLI 経由なので secrets.env の鍵で動いた）。
- [x] **提示層**。v1 はカードを持たない、と [S8 の設計](../superpowers/specs/2026-10-13-jozo-harness-web-design.md) に書いた。理由は、1 行要約がログに残って TUI・Web・replay が同じ行を読むこと、カードはクライアントごとの描画契約を増やすこと、差分は edit の要約と read の行番号で足りること。見直す条件（1 行では追えない・markdown をそのまま読みたい）も書いた。

## 6. 挙動の実測（実施済み）

- [x] **同一タスクの A/B**。harness は `jzh:scripts/ab/run.ts` にあり、3 タスク × 2 ハーネス × 3 回（計 18 走）を同じモデルで走らせ、ツール呼び出し・失敗 edit・読み直し・turn をログから数える。両ログの request/header が `deepseek-v4.1-flash` を記録していることを確認した（dsh は `jzh:scripts/ab/dsh-provider.patch.yml` の pi-ai 経路で同じ baseURL・同じモデル名に載せ、DSH_HOME は走ごとの workspace 内に置く）。結果: 6 セルすべて 3/3 完了、どの走も 1 turn、失敗 edit 0。tool calls は fix-add 3-4（jozo-harness 平均 3.3 / dsh 3.7）、write-notes 2-3（2.3）/ 2-4（3.0）、rename-function 7-14（10.3）/ 8-12（10.0）で、ハーネス間の平均差より各ハーネス内の走間の幅が大きい。読み直しは fix-add が両方 1（read → edit → read の確認）、rename-function が 0-2 で、型は同じ。つまりこの 3 タスク・n=3 ではハーネス由来の系統差は観測されない。計数の途中経過: 最初の集計は dsh の read 引数が `file_path` なのに `path` だけを見て re-reads を 0 と数えていた（計測の不具合）ので、両綴りを読むよう直して `jzh:scripts/ab/metrics.test.ts` に dsh 綴りの回帰を足し、同じ 18 走のログを数え直した。記録と再実行手順、限界は [A/B の記録](2026-10-14-ab-measurement.md)。
  - **2026-10-19 追記**: この A/B は endpoint と compaction の線を正規化している。正規化した軸を「差が無いことの証拠」に使わず、production の既定のまま走らせたセルを別に持つ規則を [DSH パリティ監査の軸](2026-10-19-parity-audit-axes.md) に固定した。production のセルはまだ無いので、cache と実窓の compaction は未測定である。

## 未確認

- jozo-harness の compaction が実際の窓の大きさで期待どおり縮むかは、実測していない。発火点を 16,000 に縮めた A/B では、両ハーネスとも要約の直後に線の下へ戻りきらず、続けて発火した（[A/B の記録](2026-10-14-ab-measurement.md)の長いタスク）。jozo-harness は保持をメッセージ数（末尾 12 件）で決め、圧縮後の大きさの目標を持たない。**2026-10-15 追記**: その空回りは直した。保持は `retainTokens`（既定は窓の 16%）になり、要約の範囲と prune の境界を同じ 1 本が決め、メーターは生ログではなく記録済みの compaction を適用した畳み込みを測る。同じ A/B の再測で、要約直後のリクエストは 11 件中 10 件が線の下に入り、compaction は 6.3 → 3.7 回になった（残る 1 件は、保持の外に置けない最新の 1 件が目標より大きい場合）。**実窓でも測った**: メーターが tools の schema（1 リクエストあたり 3,075 トークン）を数えていなかったので dsh と同じく数えるようにし、そのうえで fix-rules × n=3 を走らせ直すと要約直後は 17 件中 17 件が線の下、回数は 5.7 回。出荷した窓（線 62,464）では `long-prompt` タスク 1 走で 2 回発火し、1 回目の直後だけ 82,955（最新の 1 件が目標 20,480 より大きい場合）で、2 回目で 4,196 に収まって完走した。推定は provider の実測に対して 0.5〜3% の範囲で一致する（[A/B の記録](2026-10-14-ab-measurement.md)）。
- dsh の発火条件の既定は jozo-harness と同じ（threshold 0.8、headroom 65,536、pruner 8,192 / 4,096 / 1,024。`dsh:packages/compaction/compaction-basic/src/config.ts`、`dsh:packages/compaction/compaction-tool-result-pruner/src/config.ts`）。違いは、dsh が出力予約（リクエストの maxTokens）も窓から差し引くこと、保持をトークン（窓の 16%）で決めることである。**2026-10-15 追記**: どちらも揃えた。保持は窓の 16%。出力予約は agent-loop 行の `maxTokens` で、送る `max_tokens` が発火点から先に引かれ（`min(窓 × ratio, 窓 − 予約 − headroom)`）、保持も予約を引いた残りから取る。dsh と同じく**何も宣言しなければ予約しない**（dsh は未設定時 headroom を予約に流用するが、jozo-harness の既定 headroom 65,536 でそれをやると線が 1 になるので採らない）。既定は今までどおり無予約で、線は 128,000 の窓で 62,464 のままである。
- `bun run check` の所要時間は約 18 秒（coverage 込みのテスト約 10 秒 + 静的検査 + 3 つの gate）。CI は無い。**2026-10-15 追記**: GitHub Actions を入れた（`.github/workflows/check.yml`、macOS）。push と PR ごとに `bun run check` を丸ごと走らせる。ツールは mise.toml から入れる（bun と cccc の版が手元と揃う）。pre-push は `check:static` のまま速く保つ——ゲートは CI が持つ。jscpd は CI でも `bunx` で取る（初回だけネットが要る）。
