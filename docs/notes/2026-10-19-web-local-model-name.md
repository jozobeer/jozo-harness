# jzh web の送信が local daemon のモデル名で 404 になる（2026-10-19）

## 症状

`jzh web` でメッセージを送ると turn が `ended: error` になり、セッションログの `assistant/attempt` に次の失敗が残る。

```
provider returned HTTP 404: {"error":{"message":"model 'deepseek-v4.1-flash' not found","type":"not_found_error","param":null,"code":null}}
```

## 原因

既定 route は `ollama-cloud/deepseek-v4.1-flash`。`localBaseUrl` の probe は `GET /v1/models` が 200 を返せば local を選ぶが、この環境の Ollama は local model を持たず、`/v1/models` は 200 で `{"object":"list","data":null}` を返す。local daemon は cloud model を `deepseek-v4.1-flash:cloud`（タグ付きは `...:tag-cloud`）として提供するため、route の名前をそのまま送ると 404 になる。

`/api/show` で確認した名前:

| name | status |
|---|---|
| `deepseek-v4.1-flash` | 404 |
| `deepseek-v4.1-flash:cloud` | 200 |
| `deepseek-v4-pro:0813` | 404 |
| `deepseek-v4-pro:0813-cloud` | 200 |

## 修正

- `llm-openai` の adapter に `modelName` を足し、route のモデル名を wire で変換できるようにした。
- local route のときだけ `localOllamaModelName` で `:cloud` / `-cloud` を付ける。route とセッションログは cloud の名前のまま。
- `base` profile の `agent-loop.models` のキーを route の model 名 `deepseek-v4.1-flash` に揃えた。`:cloud` のままだと 1M 窓の宣言が当たらず 128,000 に落ちていた。

## 検証

- `vp test packages/llm/llm-openai/tests packages/bundle/base/tests`: 40 passed
- `pnpm run check:static`: fmt / lint / typecheck / doc gate / duplication / complexity（max cognitive 7）/ cargo check 緑
- 実機: `jzh web --patch <session root を /tmp に向ける patch>` を起動し、headless Chrome から `Reply with the single word pong` を送信。turn は completed で `pong` を返し、`usage.cacheReadTokens` は 9.7k（local daemon 経由の cache が効いている）。
- local daemon を到達不能にした patch で cloud 直結も確認し、`pong` を返した。

## 追記（同日）

利用者の判断で、起動時の probe と cloud fallback は削除した。現在は `localBaseUrl` があれば常に local daemon へ送り、daemon が動いている前提になる。詳細は [local daemon を前提にする](2026-10-19-local-daemon-assumed.md)。
