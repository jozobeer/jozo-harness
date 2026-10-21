# Web UI の Solid 移植と判断（Issue #2、2026-10-17）

ブラウザ UI を Solid + shadcn-solid + Tailwind で書き、現行の入口の隣（/solid/）で配れるところまで来た。同じ実 Chrome のシナリオが両方で通る。ここに何を作り、何を確かめ、採用するかどうかを記録する。

## 何を作ったか

- **入口**: `jzh:apps/web/client-solid` を Vite+ の別アプリとして建て、`vite-plugin-solid` と Tailwind v4 で `apps/web/dist/solid` に束ね、`/solid/` で配る。既定の `/` は現行のまま（`jzh:package.json` の `build:web` が両方をビルドする）。
- **橋**: `jzh:apps/web/client-solid/store.ts` が RPC のプログラムを 1 回だけ走らせ、ページからの要求はキューで渡し、値は signal に落とす。`jzh:apps/web/client-solid/bridge.ts` が Effect を走らせる唯一の場所で、ソケットが切れたら 1 秒ごとに張り直す。
- **画面**: レール（セッション一覧・New session・store）、会話（markdown・tool カード・ask・notice・live・読み位置の保持）、composer（queue・takeover・モデルの席）、右シート（run / settings / turns / job）、テーマ 3 種。純関数は現行のものを再利用する（イベントの畳み込み・テーマ・markdown・turn の台帳・スクロール規則）。
- **アニメーション 5 箇所**（150〜250ms、すべて CSS）: 会話のブロック到着、右シートの開閉（閉じる間は本文を 150ms 残して滑らせる）、承認・質問カードの到着、その下で composer が持ち上がる、Run ペインの速度計の弧（Issue #254 で追加）。`prefers-reduced-motion: reduce` では 5 つとも止まる。
- **shadcn-solid**: Button を 1 ファイル コピーインし、レール・composer・takeover・シートで使う。Tailwind はトークンを `@theme` に置き、現行スタイルシートを `layer(client)` に入れて utilities が上に来るようにした（レイヤ順: theme / base / components / client / utilities）。
- **コンポーネントテスト 5 本**（jsdom + `@solidjs/testing-library`）: レールの一覧と選択、会話の markdown・tool 出力・live、承認（ボタンと y / n）、composer の下書きと送信、シートの run 読みとタブ。

## 検証

- `pnpm run check`: 213 ファイル / **948 pass / 2 skip / 0 fail**、コンポーネントテスト **5 pass**、coverage lines 94.34%（床 93）/ functions 92.13%（床 92）。
- **実 Chrome**: `node apps/cli/tests/web-acceptance.ts`（現行）と `JZH_WEB_ENTRY=solid node apps/cli/tests/web-acceptance.ts`（Solid）が同じシナリオで **ACCEPTANCE PASS**。ready → 承認 Allow → markdown のコードと tool カード → レールの名前 → queued が出て消える → run が no goal → turns が turn 1 / completed → 新規セッション → 読み位置の保持 → 元のセッションに戻る → テーマ 3 種と再読込 → settings の読み値と、モデル一覧を取れないときの文言。
- Solid の走りではこれに加えて、4 箇所の computed style（`animation-name` と `animation-duration`）と、`prefers-reduced-motion: reduce` に切り替えた再読込で `animation-name` が none になることを確かめる。
- スクリーンショット: `.tmp/web-evidence.png`（現行）と `.tmp/web-evidence-solid.png`（Solid）。DOM の契約（id・class・data 属性）は現行と同じにしてあるので、同じシナリオがそのまま両方を駆動する。

## 判断: 採用し、置換する

置換の準備が 1 コミットで済む見込みで、移植側が測った軸で同等以上だから。

| 軸 | 現行 | Solid |
|---|---|---|
| 実 Chrome のシナリオ | PASS | PASS（アニメ 4 箇所と reduced-motion の確認込み） |
| バンドル | 223 kB | 194 kB |
| 描画の単位 | 文字列を innerHTML へ | コンポーネント |
| 動き | なし | 4 箇所、150〜250ms |
| テスト | なし（受け入れのみ） | コンポーネント 5 本 |

置換は 2026-10-17 に下の 4 手で行った（結果は `docs/notes/2026-10-17-web-entry-replaced.md`）。Issue の受け入れは「並走し、既定の配信は現行のまま」だったので、置換自体は Issue の外である。

1. `client/state.ts`・`theme.ts`・`markdown.ts`・`trajectory.ts`・`scroll.ts` を `client-solid` の外（例: `apps/web/src/ui/`）へ移し、両入口から読む。
2. ビルドの出力先と `base` を入れ替え、Solid を `/` で配る（SEA の `web/` 資産も追随）。
3. 現行の `main.ts`・`view.ts`・`index.html` を削除し、`style.css` のレイアウト分は Tailwind へ移すか `layer(client)` のまま残すかを決める。
4. `web-acceptance.ts` の `JZH_WEB_ENTRY` を外し、既定の入口に一本化する。

## いま残っているもの

- 右シートのタブ帯とモデル選択は Kobalte 化していない。「同じタブを押すと閉じる」挙動と既存の select をそのまま保ったため。採用時に Kobalte Tabs / Select をコピーインするか、Tailwind で書き直す。
- レイアウトは現行スタイルシート（`layer(client)`）のまま。Tailwind への完全移行は採用時の作業。
- アニメーションの目視確認はスクリーンショット止まり（自動の判定は computed style と DOM 契約）。動画は撮っていない。
