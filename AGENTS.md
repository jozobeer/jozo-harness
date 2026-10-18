# AGENTS.md

このリポジトリで作業するエージェント向けの約束。全体像は [README.md](README.md)、設定キーは [docs/configuration.md](docs/configuration.md)、設計は `docs/superpowers/specs/` にある。jzh 自身もこのファイルを system prompt に読み込む（`packages/core/system-prompt/src/agents-md.ts`）。

## 道具と版

- Node と pnpm は `mise.toml`、Rust は `rust-toolchain.toml` が版を決める。別の版で走らせた結果を根拠にしない。
- パッケージマネージャは pnpm 12。npm / yarn / bun は使わない。依存を足すときは版を固定で書く（`pnpm-workspace.yaml` の `minimumReleaseAge` で、公開から 1 日未満の版は解決されない）。
- fmt・lint・型検査は Vite+（`vp`）、テストは Vitest（`vp test`）。下の道具（oxlint / oxfmt）を直接呼ばない。

## 変更したら通すもの

```sh
pnpm run check          # 全部。CI（macOS）と同じ
pnpm run check:static   # テスト以外。pre-push hook がこれを走らせる
vp test <path>          # 触ったパッケージのテストだけ先に回すとき
```

`check` の中身は fmt → lint（警告も失敗）→ typecheck → doc gate → 重複検出 → complexity → `cargo check` → テストと coverage の床（lines 93% / functions 92%）。床を下げて通すのではなく、テストを足して通す。

- doc gate: README と `docs/` の相対リンクと `jzh:<path>` 参照は、実在するパスを指さなければならない。ファイルを動かしたら参照も直す。
- 重複検出: `packages` / `apps` / `scripts` の本番コードで 70 トークン以上の繰り返しは失敗する（テストは対象外）。
- e2e は macOS の seatbelt を前提にするものがある。Linux で落ちるテストは、それだけを理由に skip や削除をしない。落ちた理由を報告する。

## ワークスペース

- `apps/*`（`cli` / `tui` / `web`）は実行するもの、`packages/<group>/<name>` は組み込むもの。`crates/` は cargo の管轄で pnpm からは外してある。
- パッケージは `"exports": "./src/index.ts"` で TS をそのまま公開し、ビルド工程を持たない。import は拡張子 `.ts` 付きで書く。
- 機能は plugin（`Plugin<Config, Provides, Requires>`）として `packages/*` に置き、profile（`packages/bundle/base/profiles/*.yml`）の行で組む。CLI に機能を直書きしない。
- Web UI のブラウザ側は `apps/web/client-solid/`（Solid + Tailwind）。`apps/web/src/ui/` と `client-solid/` を変えたら `pnpm run build:web` を走らせ直す。
- 既定でモデルに渡す tool を増やすと、全セッションのプロンプトが太る。既定に入れるか `--subagents` のような opt-in にするかは理由を添えて判断する。

## コードの書き方

- TypeScript は strict に加え `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` が効いている。`as` や `!` で黙らせず、型で受ける。
- セミコロンなし、シングルクォート、インデント 2 スペース（`vp fmt` に任せる）。
- 副作用と依存は Effect（`Effect` / `Layer` / `Context.Service` / `Schema`）で表す。既存パッケージの書き方に合わせる。
- コメントとドキュメントコメントは英語。「何をするか」より「なぜそうなっているか」を一文で書く。周りのコメント密度に合わせ、自明な行には付けない。
- テストは `packages/*/*/tests/*.test.ts` と `apps/*/tests/*.test.ts`。名前は振る舞いを文で書く（`'resolves the tool list with the sandbox from the safety row'`）。LLM を叩くテストは `packages/test-support/replay`（記録した SSE）か `stub`（HTTP スタブ）を使い、実ネットワークに出ない。

## ドキュメント

- README と `docs/` は日本語。です・ます調ではなく、だ・である調で短く書く。
- 利用者が触る挙動を変えたら `docs/how-to.md`（手順）か `docs/configuration.md`（キー）を同じ変更で直す。
- 調査・受け入れ・判断の記録は `docs/notes/YYYY-MM-DD-<topic>.md` に残す。測った数値と、どのコマンドで確かめたかを書く。

## コミットと PR

- Conventional Commits、英語、命令形、scope はパッケージか領域名: `fix(session): ...`, `feat(web): ...`, `fix(tools): ...`。
- 本文は「何が問題で、なぜこう直したか」を文章で書く。差分の箇条書きを並べない。関連 issue は `Refs #<n>`。
- 1 コミット 1 目的。fmt だけの変更を機能変更に混ぜない。
- main へ直接 push しない。ブランチを切り、PR で `check` が緑になってから入れる。

## やらないこと

- テストの skip・削除、coverage の床や gate の閾値の引き下げで緑にすること。
- `.env` や `~/.config/jzh/secrets.env` の中身を読んで出力やログに載せること。
- `pnpm-lock.yaml` を手で編集すること（`pnpm install` で再生成する）。
- sandbox の既定（`seatbelt` / `workspace-write`）を緩める変更を、理由と承認なしに入れること。
