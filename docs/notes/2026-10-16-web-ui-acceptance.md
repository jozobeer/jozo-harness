# Web UI の到達点と検証（2026-10-16）

目標「jozo-harness のブラウザ UI を DSH 相当に引き上げる」の 4 スライスを実装し、
コミットした。設計は [DSH レベルの設計](../superpowers/specs/2026-10-16-jozo-harness-web-dsh-level-design.md)、
DSH 側の棚卸しは [機能棚卸し](2026-10-16-dsh-web-ui-inventory.md) にある。

## できること

**シェルとセッションの入口**

- 画面は 3 列。左は「どこにいるか」（セッション一覧。名前・いつ始まったか・id の先頭と
  cwd の末尾。名前は最初の user メッセージで、turn が終わるたびに store を読み直して付く）、
  中央は「何が話されているか」、右は「いま何が起きているか」。
  幅が 1100px を切ると右は会話の上に重なる。
- New session、行クリックで切り替え。URL は `?session=<id>` なので再読込しても戻る。
- サーバはセッション登録簿を持ち、必要になったときに 1 つ開く
  （`apps/web/src/server/sessions.ts`）。開いたセッションはサーバが止まるまで生きる。

**会話の描画**

- assistant は markdown。見出し・箇条書き・引用・コードフェンス（言語名つき）・
  インライン。素の http / https URL もアンカーにする（文末の句読点と釣り合わない
  閉じ括弧は URL の外に残す）。明示リンクは http / https / mailto / 相対だけを
  アンカーにし、プロトコル相対の `//` は拒否する。自動リンクのラベルはホストと
  パスの先頭 48 字まで（超過分は `…`）にし、クエリとフラグメントは落とす。URL 全体は
  href と title に残す。明示リンクの label は書き手の文字列をそのまま使う。
- tool はカード。1 行の要約と、`<details>` に全文（16,384 字まで）。エラーは開いた状態。
  要約・結果・出力・reasoning・prompt・inspector でも、http / https の URL は
  アンカーになる。コードの中と、truncate で末尾が `…` になった URL はリンクにしない。
- 承認と質問は **composer の上**（takeover）に出る。次に読むべきものは次に打つ場所の隣に
  あるべきだからである。承認は Allow / Deny（y / n でも答える）、質問は選択肢のボタン。
  質問そのものは尋ねた場所にブロックとして残り、markdown で読める。plan の提示もこの経路。

**設定とテーマ**

- テーマは system / dark / light。選んだものは保存され、system を選ぶと属性を書かない
  ので機械の設定に追従し続ける。
- 右のペインは tab（run / settings / turns ＋ 開いた job）で切り替える。settings は
  model / effort / cwd / セッションの置き場 / 設定ファイルを出し、**テーマもここ**にある
  （好みは設定であって案内ではない）。モデルは composer の席にあり、押すとここが開く。
- モデルは `List models`（provider の `GET /models`）から選び、`jzh config set model`
  と同じ書き手（`runConfig`）で書く。効くのは次の run から。

**走行状態**

- 右のペインの run が goal（objective / phase / ラウンド数）、schedule（rule / prompt）、
  job（実行中か、開いて出力、まだ走っていれば Stop）、subagent が始めた子セッションへの
  移動を出す。queued（次の turn を待つ入力）は composer の上、
  trajectory（ターンごとの長さ・ステップ数・呼び出し数・
  終わりの理由）。

## 検証

- `bun run check`: **923 pass / 1 skip / 0 fail**（coverage lines 95.18% /
  functions 93.37%。床は 93 / 92）。
- 実 Chrome の受け入れ（`apps/cli/tests/web-acceptance.ts`、`bun run
  tests/web-acceptance.ts`）が次の順に確かめる。ready → 承認を出して Allow →
  回答が markdown のコード要素と tool カードになる → レールに名前が付く →
  承認待ちに入力した 1 通が queued として出て、次の turn になって消える →
  RUN が空の姿を出す → trajectory が turn 1 と completed を出す →
  New session で会話が消えて行が 2 つになる → 長い応答でも読んでいる位置を保つ →
  元のセッションに戻ると履歴が戻る → テーマ 3 種が効いて、選んだものが再読込後も残る →
  settings シートが読み値を出し、モデル一覧を持たない profile では失敗を文言で返す。
- 画面は `.tmp/web-evidence.png` に残る。

## 意図的に残したもの

- 右サイドバー（ファイル・端末・プレビュー）と trajectory 以外の第 2 の面。
- 選んだモデルを**いまの**セッションに効かせること（route は agent を組み立てるときに
  決まるので、差し替えの設計が要る）。
- job 出力の自動更新（開いた時点の写し）、設定の他のキー（effort / profile / plugins）。
- 受け入れが踏んでいない経路: subagent の系譜・ask / plan・job は、受け入れの profile が
  tier1 を持たないため**単体テストだけが証拠**である。

## 受け入れを回す

```sh
cd apps/cli && bun run tests/web-acceptance.ts
```
