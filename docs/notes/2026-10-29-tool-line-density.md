# ツール行の表示密度

Issue #397。Web の会話はツール呼び出しを一種類の card で描いていた。deepseek-harness の ui-chat はプロセスの折りたたみを Compact / Standard / Detailed / Verbose から選び、選択を残す。同じ選択を jozo-harness にも入れた。

## 受け入れ条件

- 四つの密度のどれを選んでも、同じログからツールの名前と結果へ辿れる。
- 選んだ密度は再読込後も残る。
- 既定は、今の card に一番近い密度である。

## 決めたこと

- 密度は `ToolDensityContext` で会話に配り、値は `App` が `localStorage` の `jzh.tool-density` から読む。lens・theme・font と同じく、表示の設定をセッションの状態には入れない。
- 既定は `standard`。変える前の card の DOM をそのまま保つ。
- `compact` は名前と時間だけを残し、結果は card の中に出す。名前を消さず、結果を開けば読めるようにして、密度を変えても同じログへ辿れるようにした。
- `detailed` は引数（JSON の key/value）と出力の先頭を折り畳んだ行に出す。`verbose` は引数と出力を最初から開く。
- 密度が変えるのは行の描き分けだけである。store へコマンドは送らず、ログにも会話の本文にも触れない。

## 確かめたこと

- `pnpm exec vp -C apps/web/client-solid test`: 9 files、223 tests passed。密度の 7 tests を含む。標準 card が従来の DOM を保つこと、四つの密度すべてでツール名と出力が読めること、選んだ密度が再読込後も残り、セッションに何も送らないことを見ている。
- `pnpm run build:web`: 491 modules transformed、`dist/assets/index-5dei5UeR.js` を出力。
- `pnpm run check`: passed。coverage は lines 94.70%（床 93%）、functions 92.11%（床 92%）。

実際のブラウザでは開いていない。上のテストは jsdom の描画と `localStorage` の読み書きで確かめており、見た目の目視はしていない。
