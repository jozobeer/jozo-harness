# セッション所有ブラウザの実測（#341）

2026-10-28、Node 26.8.2、Google Chrome 156.0.8078.48、macOS で `browser_open` / `browser_snapshot` / `browser_click` / `browser_type` を通した。

## 確かめたこと

一時スクリプトで localhost に `<h1>Smoke</h1><button id="go">Go</button><input name="q">` の HTML を配信し、セッションを作って次の順に呼んだ。

1. `browser_open` は `Smoke\nGo` と `#go`（button）・`input`（textbox）を返した。
2. `browser_click('#go')` のあと、スナップショットの本文に `clicked` が増えた。
3. `browser_type('input[name=q]', 'hello')` のあと、スナップショットの要素に `value: "hello"` が入った。
4. セッションを閉じたあと `pgrep -fl 'jzh-browser-'` は何も返さず、一時プロファイルも残らなかった。

この環境ではエージェントハーネス自身が macOS の sandbox の中にいるため、Chrome は自前の sandbox を初期化できず exit 133（SIGTRAP）で落ちる。実測は `--no-sandbox` を一時的に足した起動で行った。出荷するコードはこのフラグを渡さない。run の sandbox で `sandbox-exec` を重ねた場合は `sandbox-exec: sandbox_apply: Operation not permitted` で起動そのものが拒否された。そのためセッション用ブラウザは run の sandbox を通さず、Chrome 自身の sandbox に任せる。jzh 自身が別の sandbox の中で動く場合は `unavailable` になる。

## 残る確認

通常のターミナルから起動した jzh（外側の sandbox が無い状態）で、Chrome の起動と受け入れ 1〜3 を通す確認は、このハーネスの中では行えていない。`pnpm run check` と CI は別に通す。
