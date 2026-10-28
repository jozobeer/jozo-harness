# Web のセッション一覧: fork・本文検索・手動の順

issue #396 の受け入れ条件を、実装前に here に書き出す。

1. セッションを fork すると、その時点のログを持った新しいセッションができ、元は変わらない。
2. 一覧の検索が本文の抜粋も返し、題だけの一致と区別できる。
3. 手動の順を保存でき、再読込後もその順で出る。選んでいないワークスペースは今の順のままである。

## 進め方

- fork: 既存のセッションのログを写して新しいセッションを作り、fork 元を記録する。既存の fork 経路があれば再利用する。
- 本文検索: 一覧の検索欄で本文に当たったものを絞る。既存の全文検索の索引があれば使う。
- 手動の並べ替え: ワークスペースごとに順を決めて保存する（localStorage か設定）。

## 決めたこと

- fork は `SessionRegistry.fork` に置いた。親のログを `factory.read` で読み、ヘッダ以外をそのまま seed にして新しいセッションを作る。subagent 用の `forkSeed` は最後の user message を落とすので使わない（手で fork した人は、いま読んでいる続きをそのまま copy したい）。fork 元は `.web-meta.json` の `forkOf` に残す。
- 本文検索は `--search` と同じ `makeSessionQuery` の索引を web サーバに 1 つ持たせ、RPC で引く。索引に当たった行だけを抜粋として出し、題だけで当たった行には抜粋を付けない。
- 手動の順はワークスペース（cwd）ごとに `localStorage` の `jzh.session-order` へ保存する。初回の移動で画面の順を種にし、触っていないワークスペースは今の順（pinned → 新しい順）のまま。

## 確かめ方と結果

- `pnpm run check`: 325 files、2366 passed / 3 skipped。coverage lines 94.66%（床 93%）、functions 92.01%（床 92%）。
- `pnpm run build:web`: 488 modules、built in 468ms。
- `pnpm exec vp test apps/web/tests/sessions.test.ts apps/web/tests/server.test.ts apps/web/tests/board.test.ts apps/web/tests/session-meta.test.ts`: fork の registry / route、本文検索の route、並びの純関数が通る。
- `pnpm exec vp -C apps/web/client-solid test`: 216 passed。抜粋の表示、題だけの一致との区別、行メニューの移動と fork を含む。
