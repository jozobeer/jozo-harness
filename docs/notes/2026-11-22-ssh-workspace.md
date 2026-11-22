# ssh 先のワークスペース（#369）

[#369](https://github.com/jozobeer/jozo-harness/issues/369) の受け入れのうち、bash と write がリモートのワークスペースを対象に動くこと、リモートでも `workspace-write` の外に書けないこと、ローカルの既定が変わらないことを満たした。実際の `sshd` をループバックで立てて確かめている。

## 受け入れとの対応

| 受け入れ | どう満たしたか | 確かめ方 |
|---|---|---|
| 設定したホストで、bash と write がリモートのワークスペースを対象に動く | tier0 行の `ssh` が `root` をセッションの cwd にし、bash はホストの sandbox、ファイル系 tool はホストの file seam を使う | `apps/cli/tests/ssh-workspace-e2e.test.ts` の 1 本目。`pwd` と書き込みがホストの `root` に落ち、ローカルの起動ディレクトリには何も残らない |
| リモートでも workspace-write の外には書けない | コマンドをホストの bwrap で包み、書き込み根を `root` と `/tmp` に限る。file tool 側は `resolveInside` がワークスペース外とリンク経由を拒否する | 同 2・3 本目。`root` の外を指す write が拒否され、ホストにファイルができない。`/var/tmp` への書き込みはホストのカーネルが `Read-only file system` で拒否し、結果は `[exit code: 1]` と `[sandbox: file access denied under workspace-write mode]` になる |
| 接続できないときは、その呼び出しが理由を返す | 行の読み込み時に bwrap の probe がホストへ届き、届かなければ `PluginError` で起動を止め、理由にホスト名を出す | 同 3 本目。到達できないホストで終了コードが 0 でなく、セッションも作られない |
| ローカル実行の既定は変わらない | `ssh` を書かない行は `nodeFileSystem` とローカルの sandbox のまま。既存の `plugin.test.ts` と CLI の e2e がその並びを固定している | `vp test` 全体（下記） |

## 決めたこと

- **file seam は「小さな POSIX シェルプログラム + タグ付きの行」で答える。** 形は `src/ssh.ts` にまとめた。kind / size / mtime / mode / base64 の読み / 一覧 / ホスト側で取る digest / commit で初めて置き換わる staged write。人が読むメッセージは一切パースしない。GNU と BSD の `stat` の差は両方試す形で吸収し、どちらも無いホストでも kind（リンクか、ディレクトリか、ファイルか）は答える。リンクかどうかは閉じ込めが最初に聞く質問なので、そこだけは必ず答える。
- **`lstat` を非同期にした。** ssh 越しの 1 コンポーネントは 1 往復である。同期のままだとリモートの seam が答えられない。歩き方はコンポーネントごとに 1 回問い合わせ、リンクを見つけた時点で止める（`workspace.test.ts` に、問い合わせたパスの列を固定するテストがある）。
- **リモートの閉じ込めは ssh の argv そのもの。** `wrap` が返す argv は `ssh … sh -c <program>` で、program の中にホストの bwrap とコマンドが入る。`bash.ts` は `wrapped.argv` をローカルで spawn するだけなので、変更は要らなかった。
- **ssh は引数を空白で連結してホストのシェルに渡す。** そのため program はもう 1 回クォートする。これが無いと、ホストは `sh -c` を program の最初の単語だけで実行する。最初の e2e はこれで落ち、直した。
- **`workspace-write` を守れないホストでは行を失敗させる。** bwrap の版だけを見ると、入っているのに名前空間を作れないホストを通してしまう。probe は最小のコマンドを bwrap の中で 1 回走らせる。守れないまま走らせるより、起動しないほうがよい。
- **セッションの cwd をホストの `root` にする。** workspace はセッションのものであり、AGENTS.md の探索も skill の根もツールのパスも同じ cwd を読む。`tools-tier0` の行が `ssh` を持つときだけ差し替え、持たないときは起動ディレクトリのまま。
- **worktree tool は ssh 先では出さない。** それはローカルの git checkout を切る操作で、ホストのワークスペースはこのマシンの checkout ではない。

## 確かめたこと

- `apps/cli/tests/ssh-workspace-e2e.test.ts`: 4 本。実 `sshd`（`/usr/sbin/sshd`、ループバック、ed25519 の鍵、`BatchMode`）を立て、`ssh` 経由で bash / write / read を turn ごとに駆動する。上の表の 4 項目をこの 4 本で確かめている。
- `packages/core/filesystem/tests/ssh.test.ts`: 14 本。同じプログラムをローカルの `sh` で走らせ、読み・状態・一覧・リンク・staged write・discard・mkdirp・引用符を含むパス・タイムアウト・届かないホストを確かめる。
- `packages/core/safety/tests/remote.test.ts`: 10 本。書き込み根、bwrap のフラグ、program の組み立て、`danger-full-access` が包まないこと、bwrap の無いホストが `confines: false` になること。
- `packages/core/tools-tier0/tests/plugin.test.ts`: 3 本。`ssh` を書かない行が従来の並びのままであること、届かないホストが行を失敗させること、知らない `mode` が起動前に拒否されること。
- `vp test` 全体: 336 files / 2,488 tests passed、1 failed、3 skipped。落ちたのは `apps/cli/tests/real-api-e2e.test.ts` だけで、この環境に local Ollama daemon が無い（`connect ECONNREFUSED 127.0.0.1:11434`）。この変更の影響ではない。
- `vp check`（fmt / lint / typecheck）、`node scripts/doc-gate.ts`、`node scripts/duplication-gate.ts`、`cccc`、`node scripts/browser-bundle-check.ts`: すべて通った。`bundle-check` は `vp` を PATH から呼ぶので、`node_modules/.bin` を通して走らせた。

## やっていないこと

- **`workspace-write` の外に `bash` で書けないことを、`/tmp` 以外の 1 点でしか見ていない。** e2e は `/var/tmp` への書き込みがホストのカーネルに拒否されることを確かめる。書き込み根が `root` と `/tmp` の 2 つで、後者は意図的に開けている（ローカルの bwrap と同じ）。
- **リンク経由の脱出をリモートで確かめていない。** `resolveInside` は同じ関数なので、リンクの判定がリモートの `lstat` でも成り立つことは `ssh.test.ts` の「リンクはリンクとして返る」までで、書き込みの拒否までは見ていない。
- **複数ホスト。** 1 プロファイル 1 ホストである。2 つ以上を同時に持つ形は作っていない。
- **`read_image` のリモートを実 sshd で確かめていない。** ツールは reader を受け取る形になり、CLI は tier0 行が解決した file seam を渡す（ホストを書いた行ならホスト、書いていなければこのディスク）。テストは reader が呼ばれることと、ホストを書いた行ではこのディスクを読まないことを見ている。実 sshd で画像を 1 枚読む e2e はまだ無い。
- **Windows の ssh 先。** ホストは POSIX のシェルを前提にしている。
- `docs/how-to.md` の手順は足していない。設定キーは `docs/configuration.md` に書いた。
