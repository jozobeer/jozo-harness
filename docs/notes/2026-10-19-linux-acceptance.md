# Linux での受け入れ（bwrap）

#159 のゴール（Linux で既定の構成のまま起動し、bash が sandbox の下で走る）を Linux 実機で確かめた記録。

## 環境

- Ubuntu 24.04.5 LTS、kernel 6.8.0、x86_64
- bubblewrap 0.9.0（`apt` の `bubblewrap`）
- `kernel.apparmor_restrict_unprivileged_userns = 1`。`/etc/apparmor.d/bwrap` に userns を許す profile を置いた状態（手順は `docs/how-to.md`）
- Node 26.8.2、pnpm 12.14.0（`mise.toml`）

## 結果

| 確認 | 結果 | 方法 |
| --- | --- | --- |
| `pnpm run check` が通る | 通過。テスト 1285 件成功、skip 2 件（macOS 専用の拒否テストと、キーが無いときの実 API テスト）。coverage lines 94.79% / functions 92.30% | `pnpm run check` |
| 同梱 profile のまま `jzh` が起動し、bash が bwrap で封じ込められる | workspace 内の `in.txt` は書けた。リポジトリ直下への書き込みは `Read-only file system` で失敗し、tool 結果に `[sandbox: file access denied under workspace-write mode]` と escalation の案内が付いた。runtime context は `backend: bwrap; enforcement: full` | `node apps/cli/src/run.ts --patch <patch.yml> --model llm/model "run it"`。patch は llm 行の `baseUrl` を OpenAI 互換のローカルスタブへ向けただけ |
| Web UI で承認してコマンドが走る | `ACCEPTANCE PASS` | `CHROME=<playwright の chromium> node apps/cli/tests/web-acceptance.ts` |

## 直したこと

- seatbelt を名指ししていたテストを、platform の既定 backend（macOS は seatbelt、Linux は bwrap）で読むようにした。snapshot は backend 名を `<native>` に置き換えて記録する。
- sandbox e2e の probe を Linux では `probeBwrap` にした。以前は `sandbox-exec` を spawn して ENOENT で suite ごと落ちていた。
- CI を macOS と Ubuntu 24.04 の matrix にした。Ubuntu では bubblewrap と AppArmor の profile を入れてから `pnpm run check` を走らせる。

## 残り

- Landlock の fallback は入れていない。bwrap を使えないホストでは、今まで通り理由と `sandbox: none` の案内を出して起動が止まる。
