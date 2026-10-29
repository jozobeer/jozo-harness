# ブラウザの中だけでハーネスを回す（#379）

## 受け入れ条件

1. ホストの Node が無いブラウザだけで、1 turn がツール呼び出しまで終わる。
2. ファイルはメモリ上のワークスペースに閉じ、ブラウザを閉じると消える。
3. 今の Node サーバの Web は、このランタイムを入れても既定のまま残る。

## いまのコードのどこが Node 前提か

`rg -l "from 'node:" packages apps --glob '!**/node_modules/**'` で 233 ファイル。テストを除くと 82 ファイル。内訳は次のとおり（`rg -o "from 'node:[a-z_/]+'" packages apps | sort | uniq -c`、テストを含む）。

| モジュール | 出現 | 何に使っているか | ブラウザに有るか |
| --- | --- | --- | --- |
| `node:path` | 187 | パスの結合・相対化・glob 一致 | 無い（純粋な計算なので自前実装で足りる） |
| `node:fs/promises` | 177 | 読み書き・走査・stat | 無い（File System Access API / OPFS はあるが非同期ハンドルで別物） |
| `node:os` | 149 | `homedir` / `tmpdir` | 無い |
| `node:fs` | 45 | `lstatSync` / `accessSync` など同期の判定 | 無い |
| `node:http` | 18 | Web サーバ、LLM のプロキシ | 無い（`fetch` と Service Worker が代わり） |
| `node:child_process` | 16 | bash、ripgrep、git、LSP、ブラウザ操作 | 無い |
| `node:crypto` | 13 | ハッシュ・UUID | `crypto.subtle` / `crypto.randomUUID` がある |
| `node:net` `node:tls` `node:https` | 5 | プロキシの受け口 | 無い |
| `node:zlib` | 3 | セッションログの zstd | 無い（zstd は `DecompressionStream` に無い） |

要点は fs の 222 箇所（`fs/promises` と `fs` の合計）が 1 か所に固まっていないことである。tier0 だけでも read / write / edit / glob / grep と、その下の walk / text / atomic / observed-files / ripgrep が直接 `node:fs` を呼ぶ。

## ツールごとの判定

判定は「ブラウザで動く（そのまま）」「差し替えが要る（fs・fetch・保存先を差す）」「ブラウザでは出さない」の 3 つ。

| ツール | 判定 | 理由 |
| --- | --- | --- |
| read / write / edit | 差し替え | `text.ts` `atomic.ts` `observed-files.ts` が fs を直に呼ぶ。FileSystem Service 越しにする |
| glob / grep | 差し替え | `walk.ts` の `readdir`/`stat` と `grep.ts` の `readFile` が fs。ripgrep は無いので既存の JS 側の経路（`fallbackNote`）に落とす |
| present / todo_write / ask_user / structured_output / exit_plan_mode | 動く | fs もプロセスも触らない |
| web_fetch / web_search | 差し替え | `fetch` に置き換える。CORS と鍵の置き場が別途要る（ブラウザに置く鍵は利用者のものになる） |
| read_image | 差し替え | 画像の復号を `createImageBitmap` に寄せる。1 turn には要らないので後回し |
| skill / artifact / session_search / session_trace / session_event_read | 差し替え | ディスクのファイルを読む。セッションログの置き場を決めたあと |
| bash | 出さない | 下の「閉じる判断」 |
| run_code / job_start / job_output / job_kill / job_list | 出さない | 子プロセスとプロセスの監督が前提 |
| create_worktree | 出さない | git のコマンドが前提 |
| lsp / mcp / plugin / workspace_dependencies | 出さない | 外部プロセスの起動とパッケージ解決が前提 |
| browser_* / computer_* / screen_capture | 出さない | 別のブラウザを CDP で操る前提。自分のブラウザの中では意味が変わってしまう |
| subagent / delegate / team / ralph / workflow / lead | 出さない（今回は） | 同じ Worker の中で回す設計はあり得るが、子の置き場とログの置き場が決まっていない。まず 1 turn を通す |
| goal / schedule | 出さない（今回は） | ディスクに書いて次回に読む前提。メモリに置くと閉じた瞬間に意味を失う |

## 1 turn を回すのに要る最小のもの

1. **メモリ上の fs**。ツールが `FileSystem` だけを見るようにし、`Map<string, string>` の実装を渡す。パスの正規化（`..` を畳む、`/` 区切り）は Service の内側に持つ。
2. **モデルへの fetch**。今の `packages/llm/llm/src/proxy.ts` は `node:http`/`https`/`tls`。ブラウザでは `fetch` のストリームを SSE として読む。プロキシを挟まないなら CORS を受けるサーバが要る（受け入れ 3 の Node サーバがそのまま使える）。
3. **ツール実行**。`packages/core/agent-loop/src/runner.ts` は `node:crypto` の `randomUUID` と `node:os` の `tmpdir`。UUID は `crypto.randomUUID`、tmpdir はメモリの fs に置き換える。Effect のランタイムはブラウザで動く。
4. **セッションログの置き場**。`session-jsonl` は zstd 圧縮・ロック・rename を使う。ブラウザではこの 3 つが無いので、ログはメモリの配列に持ち、閉じれば消える（受け入れ 2 と同じ性質）。

## 判断

**採用する。** ただし 1 round で入れるのは「FileSystem を Service に切り出し、メモリ実装を足す」ところまでにする。

理由は 3 つ。

- fs の呼び出しが 9 モジュールに散っている。ブラウザ対応のたびに 9 か所を直すのは、対応のたびに別の壊れ方をする。差し替え点を 1 つにすると、ブラウザ実装は 1 ファイルで済み、テストも同じ口から書ける。
- Node 実装をそのまま既定にするので、既存の Node の Web は挙動が変わらない（受け入れ 3 を壊さない）。Service を足すだけで、呼び出し側の意味は変えない。
- ブラウザ実装そのものは、パッケージング（Worker に Effect とツールを束ねる工程）が最大の未知で、この round では見積もれない。fs の口を先に決めておけば、パッケージングは後から差し込める。

**閉じるもの。** bash と、プロセスを前提にするツールはブラウザのツール一覧に出さない。

- カーネルの安全は OS の sandbox（macOS は seatbelt、Linux は landlock）が強制する設計である（`docs/how-to.md` の sandbox の節、`packages/core/safety/src/sandbox.ts`）。ブラウザにはその強制点が無い。強制できない道具を出すと「sandbox が守る」という約束が、ブラウザのときだけ嘘になる。守れないものは出さない、が kernel の記述と整合する。
- 同じ理由でセッションログのディスク永続も閉じる。lock と rename が無いところに、lock と rename を前提にした不変条件は置けない。

**保留。** 委譲（subagent 系）と goal / schedule は、置き場が決まれば Worker の中で回せる。今回の受け入れ条件には要らないので、issue の残件に回す。

## 入れたもの（スライス 1）

`packages/core/filesystem` を足した。中身は口と 2 つの実装である。

- `src/index.ts`: `FileSystemShape`（`readBytes` / `stat` / `readdir` / `mkdirp` / `stage` / `observe` / `lstat`）と、`Context.Service` の `FileSystem`、`withFileSystem`。`lstat` だけ同期なのは、パスの封じ込めがファイルを開く前に走るため。
- `src/node.ts`: ディスクの実装。`atomic.ts` の temp + fsync + rename と `observed-files.ts` の SHA-256 がそのまま移った。
- `src/memory.ts`: プロセス内の実装。ファイルは `Map`、mtime は書き込みごとの通し番号、digest は短いハッシュ。閉じれば消える。

`read` / `write` / `edit` / `glob` / `grep` は `yield* FileSystem` で口を取り、`withFileSystem` で呼び出し口に実装を差す。`ToolDefinition` の `execute` は `R = never` のままなので、pipeline もフックも変えていない。`resolveInside` は `lstat` だけを受け取る形にした（bash と worktree は Node の実装を渡す）。

## 検証

- `packages/core/tools-tier0/tests/memory-file-system.test.ts`: メモリの workspace で write → read → glob → grep を 1 往復。別のインスタンスからは見えないこと、初期ファイルを読めることも見る。
- `vp test packages/core/tools-tier0`: 18 ファイル 139 テストが通る（メモリ実装を足す前と同じ数に 3 を足した）。
- `pnpm run check`: fmt / lint / typecheck / doc gate / duplication / complexity / cargo / coverage を通す。閾値は動かさない。

## スライス 2 の計画

1 turn をメモリの workspace で回すために、残件のうち 2 つを先に片付ける。

- モデルへの通信を `LlmTransport` に寄せる。DeepSeek の adapter は transport 越しに SSE を読み、ブラウザの実装は `fetch`、テストはスタブを渡す。Node の既定は今の `outboundFetch`（プロキシを通す）にする。
- セッションログを `SessionLog` の口に寄せる。JSONL は今のディスク実装をそのまま渡し、メモリ実装はイベントの配列を持つ。ブラウザの組み立てはメモリの実装を渡す。

その上で `packages/core/runtime-browser` に、メモリの `FileSystem`・ツール・モデル transport・メモリのログを 1 か所で繋ぐ組み立てを置き、Node 上で 1 turn を回すテストを書く。

## 残件

- Worker へのパッケージング（`pnpm run build:web` とは別の工程）。Effect とツールを 1 つの bundle にまとめる。
- モデルへの `fetch` 経路と CORS の扱い。`packages/llm/llm/src/proxy.ts` は `node:http`/`https`/`tls` のまま。
- `node:path` の差し替え。`matchesGlob` は Node 22 以降にしか無く、ブラウザには無い。パスの正規化は今も Node の関数である。
- ripgrep の口。`grep` / `glob` は `defaultRipgrep` を import しており、その module は `node:fs` と `@jozo-harness/process` を読む。ブラウザでは `ripgrepAt(undefined)` を渡して walker に落とすが、import 自体は残る。
- セッションログのメモリ実装と、閉じたときに消えることの確認。
- Worker の中でツール一覧を組む口（`tier0Tools` は今も Node の plugin から `nodeFileSystem` を渡している）。
- 受け入れ条件 1（ブラウザだけで 1 turn）を実際に確かめる手順の用意。
