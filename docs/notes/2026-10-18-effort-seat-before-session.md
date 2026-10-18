# 新しいセッションの effort 席（2026-10-18）

`jzh web` の composer で、セッションを開く前だけ effort の選択が出ず、最初のメッセージを送ると現れていた。出た後もモデルのチップと縦位置が揃っていなかった。両方を直した記録である。

## 原因

- effort の席は run 状態があるときだけ描いていた。空のページには run が無いので、設定ファイルの `effort` が表示されなかった。
- 空のページが読む `settings` には実効値 `effort` はあったが、provider が受ける語の一覧が無かった。選択肢を作れないので、表示だけ足すわけにはいかなかった。
- 席の中身は inline-flex のチップと素の `select` で、`vertical-align` が bottom と baseline に分かれていた。実 Chrome で測ると、チップの top 385.58 / 高さ 24.39、select の top 387.97 / 高さ 22 で、2.39px ずれていた。

## 変更

- `jzh:apps/web/src/shared/rpc.ts` の `SettingsView` に `efforts` を足し、run がセッションを開く前に読む語を返す。
- `jzh:apps/cli/src/index.ts` で、profile の layer から `Llm.capabilities.reasoningEffort` を読んで `settings.efforts` にする。空のページの選択は `setEffort` RPC で run の choice に置き、次に開くセッションの `reasoningEffort` にする。
- `jzh:apps/web/client-solid/components/composer.tsx` は、空のページなら `settings`、セッションがあれば `run` から実効値と語を読む。空のページの変更は `chooseEffort` が run の choice へ、開いているセッションでは従来どおりコマンドへ流す。
- `jzh:apps/web/src/ui/style.css` は `#seat` を flex 行にし、チップと select に同じ 24px の高さと 18px の行高を与えた。

## 確かめたこと

- 実 Chrome の受け入れ（`node apps/cli/tests/web-acceptance.ts`）: セッションを開く前の席に `default` と `low` / `medium` / `high` / `xhigh` / `max` が並び、top の差は 0 になった（以前は 2.39px）。
- `apps/cli/tests/effort-switch-e2e.test.ts`: 空のページで `high` を選ぶと `setEffort` が返り、その次に開いたセッションの `effort` が `high`、送信したリクエストの `reasoning_effort` も `high` になる。
- `apps/web/tests/store.test.ts`: 空のページの選択は `setEffort` だけを呼び、開いているセッションの選択はコマンドだけを送る（run の choice は変えない）。
- `pnpm run check`: 245 files / 1274 passed、coverage lines 94.78% / functions 92.31%。
