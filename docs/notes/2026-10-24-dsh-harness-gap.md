# dsh ハーネス差分の起票（2026-10-24）

比較相手は [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) の `22ddee3792`（2026-10-23、`worktree-chatgap` のマージ）。こちらは `db527d6`。2026-10-14 の [ギャップ表](2026-10-14-dsh-gap-backlog.md) と [残りリスト](2026-10-14-dsh-gap-remaining.md) は、その時点のチェックアウトに対して閉じていた。今回は最新の木を読み、足りない能力を issue にした。

証拠はソースの読み比べである。両ハーネスを同じタスクで走らせてはいない。dsh の位置は、base または web の出荷プロファイル、任意バンドル、experimental、のどれかを各 issue の本文に書いた。

開いていた issue は [#305](https://github.com/jozobeer/jozo-harness/issues/305) だけだった。投影キャッシュの [#363](https://github.com/jozobeer/jozo-harness/issues/363) は、モデル往復ではなく開き直しの畳み込みなので別にしている。

## 起票した issue

[#330](https://github.com/jozobeer/jozo-harness/issues/330) から [#403](https://github.com/jozobeer/jozo-harness/issues/403) まで、74 件。ラベルは enhancement。

| 領域 | issue |
|---|---|
| モデル向けツール | [#330](https://github.com/jozobeer/jozo-harness/issues/330) pwsh、[#331](https://github.com/jozobeer/jozo-harness/issues/331) lsp、[#332](https://github.com/jozobeer/jozo-harness/issues/332) present、[#333](https://github.com/jozobeer/jozo-harness/issues/333) MCP resource、[#334](https://github.com/jozobeer/jozo-harness/issues/334) 子のモデル一覧、[#335](https://github.com/jozobeer/jozo-harness/issues/335) 永続シェル、[#336](https://github.com/jozobeer/jozo-harness/issues/336) 同梱ランタイム、[#337](https://github.com/jozobeer/jozo-harness/issues/337) 過去セッションの検索、[#345](https://github.com/jozobeer/jozo-harness/issues/345) workflow のスクリプト、[#346](https://github.com/jozobeer/jozo-harness/issues/346) run_code の記憶と Python、[#347](https://github.com/jozobeer/jozo-harness/issues/347) skill の呼び出し方針、[#351](https://github.com/jozobeer/jozo-harness/issues/351) 複数の質問、[#365](https://github.com/jozobeer/jozo-harness/issues/365) ripgrep、[#366](https://github.com/jozobeer/jozo-harness/issues/366) spill、[#372](https://github.com/jozobeer/jozo-harness/issues/372) Exa / Perplexity |
| プラグイン | [#338](https://github.com/jozobeer/jozo-harness/issues/338) 導入と画面、[#339](https://github.com/jozobeer/jozo-harness/issues/339) 再起動しない着脱 |
| 委譲と製品面 | [#340](https://github.com/jozobeer/jozo-harness/issues/340) computer use、[#341](https://github.com/jozobeer/jozo-harness/issues/341) browser use、[#342](https://github.com/jozobeer/jozo-harness/issues/342) 外部の子、[#343](https://github.com/jozobeer/jozo-harness/issues/343) ACP、[#344](https://github.com/jozobeer/jozo-harness/issues/344) SDK、[#349](https://github.com/jozobeer/jozo-harness/issues/349) team の権限、[#378](https://github.com/jozobeer/jozo-harness/issues/378) デスクトップ、[#379](https://github.com/jozobeer/jozo-harness/issues/379) ブラウザ内ランタイム、[#380](https://github.com/jozobeer/jozo-harness/issues/380) hooks.json、[#381](https://github.com/jozobeer/jozo-harness/issues/381) webhook、[#382](https://github.com/jozobeer/jozo-harness/issues/382) Liveshare |
| 予定・安全・シェル | [#348](https://github.com/jozobeer/jozo-harness/issues/348) schedule、[#350](https://github.com/jozobeer/jozo-harness/issues/350) Auto 審査、[#364](https://github.com/jozobeer/jozo-harness/issues/364) 原子的な write、[#367](https://github.com/jozobeer/jozo-harness/issues/367) Windows ACL、[#368](https://github.com/jozobeer/jozo-harness/issues/368) Landlock、[#369](https://github.com/jozobeer/jozo-harness/issues/369) SSH、[#370](https://github.com/jozobeer/jozo-harness/issues/370) 途中の permission、[#371](https://github.com/jozobeer/jozo-harness/issues/371) 管理環境変数 |
| 文脈 | [#354](https://github.com/jozobeer/jozo-harness/issues/354) 引用、[#355](https://github.com/jozobeer/jozo-harness/issues/355) @ の中身、[#356](https://github.com/jozobeer/jozo-harness/issues/356) persona、[#357](https://github.com/jozobeer/jozo-harness/issues/357) tmux、[#358](https://github.com/jozobeer/jozo-harness/issues/358) GUI の URL |
| セッション | [#352](https://github.com/jozobeer/jozo-harness/issues/352) 評価、[#353](https://github.com/jozobeer/jozo-harness/issues/353) 題の生成、[#359](https://github.com/jozobeer/jozo-harness/issues/359) 添付、[#360](https://github.com/jozobeer/jozo-harness/issues/360) zstd、[#361](https://github.com/jozobeer/jozo-harness/issues/361) ロック、[#362](https://github.com/jozobeer/jozo-harness/issues/362) 書き出し、[#363](https://github.com/jozobeer/jozo-harness/issues/363) 投影キャッシュ |
| モデル呼び出し | [#373](https://github.com/jozobeer/jozo-harness/issues/373) 公式 Messages API、[#374](https://github.com/jozobeer/jozo-harness/issues/374) effort の宣言、[#375](https://github.com/jozobeer/jozo-harness/issues/375) HTTP プロキシ、[#376](https://github.com/jozobeer/jozo-harness/issues/376) 資格情報、[#377](https://github.com/jozobeer/jozo-harness/issues/377) OTLP |
| Web | [#383](https://github.com/jozobeer/jozo-harness/issues/383) 音声、[#384](https://github.com/jozobeer/jozo-harness/issues/384) ロケール、[#385](https://github.com/jozobeer/jozo-harness/issues/385) 設定の編集、[#386](https://github.com/jozobeer/jozo-harness/issues/386) フォント、[#387](https://github.com/jozobeer/jozo-harness/issues/387) ショートカット、[#388](https://github.com/jozobeer/jozo-harness/issues/388) ファイルツリー、[#389](https://github.com/jozobeer/jozo-harness/issues/389) プレビュー、[#390](https://github.com/jozobeer/jozo-harness/issues/390) ブラウザタブ、[#391](https://github.com/jozobeer/jozo-harness/issues/391) プランカード、[#392](https://github.com/jozobeer/jozo-harness/issues/392) workflow ノード、[#393](https://github.com/jozobeer/jozo-harness/issues/393) 伏字、[#394](https://github.com/jozobeer/jozo-harness/issues/394) 外部アプリ、[#395](https://github.com/jozobeer/jozo-harness/issues/395) 子のフォロー、[#396](https://github.com/jozobeer/jozo-harness/issues/396) fork と本文検索、[#397](https://github.com/jozobeer/jozo-harness/issues/397) 表示密度、[#398](https://github.com/jozobeer/jozo-harness/issues/398) Todo ドック、[#399](https://github.com/jozobeer/jozo-harness/issues/399) パネル順、[#400](https://github.com/jozobeer/jozo-harness/issues/400) preset 編集、[#401](https://github.com/jozobeer/jozo-harness/issues/401) 推論の翻訳、[#402](https://github.com/jozobeer/jozo-harness/issues/402) 提案カード、[#403](https://github.com/jozobeer/jozo-harness/issues/403) ログ検査 |

kernel 設計が除外したままのものは、issue の本文にその旨を書いた。閉じる判断も、採用する判断も、issue 側で行う。

## 既にあるので起票しなかったもの

読み比べて、名前が違っても同じ仕事をしているものは issue にしていない。

- 基本のツール。read / write / edit / glob / grep / bash、todo、skill、web_search（Brave と DeepSeek）、web_fetch、ask_user 一つ、goal、schedule の every / daily / weekly / cron、job、subagent、team の名簿と板、workflow の扇状実行、ralph、run_code の呼び出しごと、create_worktree、MCP の tools/list と tools/call、plugin 行の次起動反映。
- 文脈。identity と tool guidance、AGENTS.md / CLAUDE.md、runtime context の cwd / 時刻 / 承認 / sandbox、skill カタログ。
- compaction。閾値、要約、メーター、tool 結果の head/tail、画像の参照化、/compact。ログの fsync はモデル要求とツール副作用の前にある。
- 安全。seatbelt と bwrap、昇格の承認、plan mode。承認は記憶しない。
- セッション。JSONL、切れた末尾の修復、v0 から v1、FTS の CLI 検索、最初の発話を切った題。
- Web。一覧の名前・ピン・アーカイブ・削除、モデルと effort、steer と待ち行列、下書き、goal バー、差分、job、子を開くことと止めること、使用量、Timeline、skill カード、@ のパス補完、light / dark / system、artifact ページ。

## 起票しなかった差分

次は dsh の木にはあるが、ハーネスの欠落としては issue にしていない。

- `str_replace_editor`。edit が同じ操作をする。
- worktree の削除やマージ。dsh のツールも作成して入るだけである。
- sandbox のネットワーク遮断。dsh の Windows ACL は、読み取りとネットワークは閉じないと書いている。こちらもファイルの境界だけを閉じる。
- escalation の回数カウント。dsh の `allowed-once` は、その実行 1 回の許可であり、同じ引数の再試行を機械的に拒否する実装は見当たらなかった。こちらも承認を記憶しない。
- DeepSeek アカウントの PKCE、請求の表示、ブランド、モデル名のバッジ、出力に付ける「powered by dsh」。製品固有で、OTLP の既定送信先にもしない（[#377](https://github.com/jozobeer/jozo-harness/issues/377)）。
- `cordis_inspect`。dsh のプラグイン開発用で、こちらの実行系には対応物が無い。
- goal をホスト全体に持つこと。dsh の goal もセッションの中である。
- セッション形式の v2 以降の codec。dsh 自身の履歴を読むための段で、こちらのログは v1 のまま読める。

## 確かめ方

dsh は `git clone --depth 1 --filter=blob:none` のあと `packages` と `apps` を sparse checkout し、`22ddee3792402c3e70ec5f86a63c3e3e895a2f60` を読んだ。プロファイルの行は `packages/bundle/base/cordis.patch.yml` と `packages/bundle/web-app/cordis.patch.yml`、任意バンドルの一覧は `packages/util/official-bundles/src/bundles.ts`。こちらは `db527d6` の `packages/` と `apps/web` を読んだ。`gh issue create` で 74 件を作り、失敗は 0 だった。
