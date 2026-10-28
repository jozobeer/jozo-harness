# 2026-10-29 credentials の参照と保存域（#376）

## 決めたこと

#376 は「dsh の credentials サービスを採るか、issue を閉じるか」を問うていた。採るのは**参照と保存域だけ**で、発行・更新・失効を持つサービスは持たない。設定ファイルには鍵の名前（参照）だけを置き、値は `credentials.json` にだけ置く。

- 設定: llm 行の `apiKeyRef`（例: `apiKeyRef: openrouter`）。既存の `apiKeyEnv` は残す。
- 保存域: `~/.config/jzh/credentials.json`（`XDG_CONFIG_HOME` に従う。モード 600）。`{"openrouter": "..."}` の flat な JSON。
- 書き込み: `jzh auth ref openrouter`。値は端末から読み、表示にもログにも出さない。
- 解決順: シェル > 近い `.env` > `secrets.env` > `apiKeyRef` の参照。前の 3 つが `apiKeyEnv` の名前を埋めたら store は読まない。
- 参照が無いとき: `jzh: the credential reference "openrouter" has no value in <path>; add it there or set OPENROUTER_API_KEY` で止まる。値は返さない。
- 表示: `jzh --dump-config` は参照が効いたとき `credentials (the reference "openrouter" in <path>)` と出し、値は出さない。

保存域を `~/.jzh` ではなく config ディレクトリに置いたのは、`secrets.env` と同じ `XDG_CONFIG_HOME` の下にまとめ、テストが同じ seam で差し替えられるためである。

## 受け入れとの対応

| #376 の受け入れ | 実装 |
|---|---|
| 設定には鍵の名前だけ、値は秘密のファイルか環境にだけ | llm 行の `apiKeyRef`。値は `credentials.json`（600）か環境 |
| `jzh --dump-config` が参照と store を出し、値は出さない | `renderEffective` の `credentials (the reference ... in ...)` |
| 今ある `OLLAMA_API_KEY` の経路は移行せず動く | 参照を書かなければ loader の順も結果も変わらない。既存テストは無変更で通る |

## テスト

`apps/cli/tests/credentials.test.ts`:

- fills the key from the reference when the environment chain leaves it empty
- names the missing reference and leaves the value absent
- keeps the shell, the nearest .env, and secrets.env ahead of the reference
- creates the file with 600 and keeps the references it already had
- refuses text that is not an object of strings without echoing it
- shows the reference and the store in --dump-config without the value
- sends the reference as the provider key when the environment has none
- stops a models listing and names the reference it could not find

`apps/cli/tests/auth-provider.test.ts` は `jzh auth ref` が 600 で書き、値を表示しないことを確かめる。`apps/cli/tests/config.test.ts` は `configPaths` が `credentials.json` を返すことを確かめる。

確かめたコマンド:

```sh
pnpm exec vp test apps/cli/tests/credentials.test.ts apps/cli/tests/auth-provider.test.ts apps/cli/tests/config.test.ts apps/cli/tests/settings.test.ts apps/cli/tests/bin.test.ts apps/cli/tests/models-cli.test.ts
pnpm run check
```

`pnpm run check` は成功した（307 files / 2160 tests passed、1 file skipped は real-api）。coverage は lines 94.74%（床 93%）、functions 92.07%（床 92%）。CI は macOS と Ubuntu の 2 本で同じ `pnpm run check` を走らせる。
