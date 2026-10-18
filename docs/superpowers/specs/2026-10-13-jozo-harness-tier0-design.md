# jozo-harness 設計: S3 Tier 0

範囲は設計文書の分割表に従う: read / write / edit / glob / grep / bash の 6 ツール。実装は packages/core/tools-tier0。

## 前提（S1 と S2 から引き継ぐもの）

- ツールは ToolDefinition（parameters / needs / output / execute）で宣言し、execute の Effect は R = never。
- output.render は (args, value) を受け取る。パイプラインがその順で呼ぶ。
- 実行は executeTool の 1 本の pipeline を通り、tools/pre-execute の ask 決定で承認要求になる（S2 の bridge）。preset が needs を覆っていれば問い合わせなしで実行される。
- bash は Sandbox.wrap を通してから spawn する。provider は profile の @jozo-harness/safety 行が決める。

## 決定

1. パスの扱いは 1 つの関数に閉じる。write.ts の resolveInside(root, path) が、root の外へ出るパスを denied で拒否する。read / edit / bash の cwd も同じ関数を通す。
2. 曖昧な編集はしない。edit は oldString の一致が 0 件ならエラー、複数件で all 未指定ならエラー。ファイルは書き換えない。
3. 探索の前に検証する。grep は正規表現を走査前にコンパイルし、壊れていれば invalid-arguments を返してファイルを 1 つも読まない。
4. sandbox は構築時に注入する。makeBashTool(sandbox) とし、ツール定義の Effect に Sandbox を要求させない。profile の行からは plugin.ts が Layer.effect(Tier0Tools, Effect.map(Sandbox, tier0Tools)) で渡す。
5. ツール群は値のリストとして公開する。Tools.register は Scope を要するため、層の構築時に登録せず、呼び出し側（CLI）が profile の tier0 行を見て登録する。

## 実装

| ツール | needs | 要点 |
|---|---|---|
| read | read | 1 始まりの行番号、offset / limit、末尾の空行は落とす |
| write | write | 親ディレクトリを作る。workspace.ts の resolveInside で workspace 外とリンク経由を拒否 |
| edit | write | 一意一致を要求。all で全置換 |
| glob | read | Bun.Glob で走査し、相対パスをソートして返す |
| grep | read | 正規表現を先にコンパイル。file / line / text を返す |
| bash | exec | sandbox.wrap を通してから bash -c を spawn。非 0 は出力付きのエラー |

## パスをどこで 1 本にするか（2026-10-14 追記）

書き込みと、コマンドを走らせるディレクトリの解決は `packages/core/tools-tier0/src/workspace.ts` の `resolveInside` に集める（write / edit / bash の cwd）。判定は 2 段である: (1) 字句的に workspace の下にあること（`relative` が `..` で始まらない。`startsWith` では `/work-other` を誤って通す）、(2) **root の下の既存の成分を順に `lstat` し、リンクが 1 つでもあれば拒否する**。リンクは workspace の中を指していても拒否する（指し先は我々の関知しないうちに変わる）。まだ無い成分は新規の仕事として通す。`realpath` で親を canonical 化するだけでは足りない: 宙に浮いたリンクは canonical にできず、`mkdir -p` がリンクをたどって外に作ってしまう。

## 検証

- packages/core/tools-tier0/tests/: read / write / edit / glob / grep / bash / tools（一覧と needs）/ plugin（loader 経由で sandbox が渡る）/ approval（exec は承認される）。
- apps/cli/tests/tools-e2e.test.ts: 10 行の profile でモデルが read を呼び、実 registry と pipeline を通り、ファイル内容がログに残る。
- apps/cli/tests/approval-e2e.test.ts: workspace-write では bash が承認要求になり拒否で止まる。full では問い合わせず実行される。
