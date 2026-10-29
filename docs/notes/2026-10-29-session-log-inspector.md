# セッションログの検査面

Issue #403。Web の会話は trace からツール呼び出しの中身を開けたが、そのノードがどのログイベントから生まれたかは読めなかった。deepseek-harness の session-inspector と同じく、生イベントを一覧し、チャットのノードと行き来できる検査面を入れた。

## 受け入れ条件

- 開いているセッションの生イベントを、型と seq 付きで一覧できる。
- イベントから、会話の対応するノードへ移動できる。
- 検査面はイベントを書き換えない。

## 決めたこと

- 生イベントは新しい保存形式を作らず、ページがすでに会話と trace へ畳んでいるのと同じ適用済みイベントから射影する。`WebState.log` が seq・time・type・data と、data の key 集合、会話の turn / step / call を持つ。セッションを移ると空に戻り、購読した履歴で埋まる。
- ログは右ペインの `log` タブに置いた。一覧は 28px の行を viewport と前後 8 行だけ描く windowed list で、長いログでも描画量は画面の行数に比例する。
- data は長い文字列を 160 字、長い配列を 24 件、深さ 5 で畳み、残りを「… (N chars / N more)」と添える。表示だけの畳みで、イベント本体は変えない。
- 絞り込みは型か data の key（入れ子を含む）に一致する語で行う。key はイベント適用時に一度だけ集める。
- 会話側には turn / step / call を `data-turn` / `data-step` / `data-call-id` で印し、イベントの node ボタンは chat lens に切り替えて折り畳みを開き、その位置までスクロールして印を付ける。ログも会話も書き換えない。
- 逆向きとして、ツール・skill・workflow・plan・提案カードにログのアイコンを置いた。押すとその card を生んだ call または offer のイベントをログで選ぶ。モデルには何も送らず、変わるのはペインの選択だけである。
- イベントから node を引くときは call の id を先に見る。call はステップの外（standalone の load）にも置けるため、turn / step だけでは一意にならない。

## 確かめたこと

- `pnpm exec vp -C apps/web/client-solid test`: 11 files、258 tests passed。ログ一覧が seq と型を出し、選択した data を表示し、key で絞れ、イベントから call の card へ移動し、card から call / offer のイベントを開き、そのどちらも store にコマンドを送らないことを見ている。
- `pnpm exec vp test apps/web/tests/log.test.ts`: 9 tests passed。turn / step / call の対応、standalone の call、key の収集、畳み方、card からイベントの seq を引くことを見ている。
- `pnpm run build:web`: 500 modules transformed、`dist/assets/index-kQ_5f-Ms.js` と `dist/assets/index-KlnAxUkb.css` を出力。
- `pnpm run check`: passed。coverage は lines 94.96%（床 93%）、functions 92.45%（床 92%）。complexity は cognitive の最大 7、cyclomatic の最大 10 で、どちらも床の内側。
- 実ブラウザでは開いていない。上のテストは jsdom の描画と DOM で確かめており、見た目とスクロールの体感は目視していない。
