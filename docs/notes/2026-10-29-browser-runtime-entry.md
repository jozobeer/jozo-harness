# ブラウザだけで回すランタイムの入口

2026-10-29。#379 の残件だった、ページから Worker を起こす入口を入れた。

## 経路

- ページが `?runtime=browser` を持つときだけ `BrowserRuntimePage` を描く。既定は今までどおり `App`（Node サーバ）である。
- ページは `new Worker(new URL('./worker-entry.ts', import.meta.url), { type: 'module' })` を作り、最初の `postMessage` で route / baseUrl / apiKey を渡す。apiKey は sessionStorage の `jzh.browser.apiKey` から読み、URL には載せない。
- Worker は runtime-browser の `startBrowserWorker` を起動する。ワークスペースは memory のファイルシステム、ログは memory の persistence で、Worker を terminate すると両方消える。

## 受け入れの確かめ方

1. 1 turn がツール呼び出しまで終わる: `pnpm exec vp -C apps/web/client-solid test --run tests/browser-runtime.test.tsx`。偽 Worker の scope で本物の worker entry を動かし、write の tool call と答えが画面に出ることを確認する。runtime-browser の `tests/browser-turn.test.ts` も、同じ turn を memory のワークスペースで確認する。
2. メモリのワークスペースは Worker とともに消える: 上のテストで 1 つ目の Worker を unmount して terminate し、2 つ目の Worker で同じパスを read すると tool/result が isError になる。runtime-browser の `tests/worker.test.ts` も同じ境界を確認する。
3. Node が無い: `pnpm run bundle:check` が `apps/web/client-solid` を build し、出力の `worker-entry-*.js` に `node:` の import も `require("fs")` も無いことを確認する。worker chunk が出力されなければ失敗するので、build から entry が外れた場合も落ちる。

実行結果は次のとおり。

```
$ pnpm exec vp -C apps/web/client-solid test --run tests/browser-runtime.test.tsx
 Test Files  1 passed (1)
      Tests  4 passed (4)

$ pnpm run bundle:check
browser bundle: worker-entry-*.js has no Node imports (worker-entry chunk exists)
```

build 中に rolldown が Node 依存 module の externalize 警告を出すことがあるが、worker chunk には import として残らない。ページのコードは `apps/web/client-solid/runtime/` に閉じており、サーバ側の `apps/web/src` は変えていない。
