# jzh は local Ollama daemon を前提にする（2026-10-19）

## 決定

dsh の web profile と同じく、jzh も `http://127.0.0.1:11434/v1` の local daemon が動いている前提にする。起動時の probe と cloud への fallback は外す。daemon が無ければリクエストは接続エラーになる。

## 変更

- `llm-openai` から `localDaemonReachable` / `LocalProbe` / `resolveRoute` / `localProbeTimeoutMs` を削除した。
- `localBaseUrl` があれば常にそこへ送る。`baseUrl` は `jzh models` の一覧取得と、`localBaseUrl` が無いときの送信先として残す。
- `localBaseUrl` を空文字にすると local route を切って `baseUrl` に送る。`jzh config set plugins.llm.localBaseUrl ''` で cloud 直結にできる。
- route のモデル名を local daemon の cloud 名（`:cloud` / `-cloud`）に直す処理は残す。`jzh models` と設定は cloud の名前のまま使える。
- `base` profile の `agent-loop.models` は route 名 `deepseek-v4.1-flash` と、local 名 `deepseek-v4.1-flash:cloud` の両方を持つ。

## 検証

- `vp test packages/llm/llm-openai/tests packages/bundle/base/tests`: 36 passed
- `pnpm run check:static`: fmt / lint / typecheck / doc gate / duplication / complexity（max cognitive 7）/ cargo check 緑
- `pnpm run check`: 1352 passed / 3 skipped、coverage lines 94.96% / functions 92.40%（floor 93 / 92）
- `jzh models`: cloud の一覧を返す（先頭は `ollama-cloud/beam`）。`baseUrl` が一覧取得に残っている。
- 実機: `jzh web` を起動し、headless Chrome から `Reply with the single word pong` を送信。turn は completed で `pong` を返し、`usage.cacheReadTokens` は 6.9k。
- `localBaseUrl` を `http://127.0.0.1:1/v1` にした patch で `TRANSPORT: provider request failed: TypeError: fetch failed` になり、cloud fallback しないことを確認した。
