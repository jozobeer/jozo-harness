# ワークスペースを外部アプリで開く（#394）

## 受け入れ条件

1. セッションの cwd（ワークスペース）を、インストール済みのアプリ（Finder / VS Code / Terminal など）から選んで開ける。
2. アプリが 1 つも無い環境では、操作を出さないか、押したときに理由が分かる。
3. 開く操作はモデルの turn を起こさない。人間の操作としてサーバ側で完結する。
4. 開けるのはワークスペース内のパスだけ。外へのパス、シェルメタ文字、制御文字は拒否する。
5. sandbox 内のツール実行ではなく、サーバプロセスが OS の launcher を argv 配列で起動する（シェルを介さない）。
6. 起動関数は注入可能にし、テストは実際のアプリを起動しない。

## 決めたこと

- 検出はサーバ側で行い、既知のアプリだけを allowlist としてクライアントへ返す。クライアントから任意のコマンドは受け取らない。
- 起動は `spawn` に argv 配列を渡し、`shell: false` を固定する。パスは `realpath` でワークスペース配下を確認してから渡す。
- 失敗は型付きの理由（アプリ無し / 範囲外 / 起動失敗）で返す。
- 画面の導線はワークスペース根を開く 1 つにした。RPC は根からの相対パスを受けるので、選んだファイルやフォルダを開く導線は同じ検査のまま後から足せる。

## 実装

- `apps/web/src/server/open-in-app.ts`: 検出（macOS は bundle と標準の場所、Linux は PATH）、`realpath` による範囲検査、argv 配列での起動。ホスト事実と起動関数は注入する。
- `apps/web/src/shared/rpc.ts`: `openApps`（検出結果と理由）と `openInApp`（セッション id・アプリ id・相対パス）。アプリ id は検出済みのものだけをサーバ側で照合する。
- `apps/web/src/server/serve.ts`: セッションの cwd を解決して port へ渡すだけ。`sendCommand` を呼ばないので turn は始まらない。
- `apps/cli/src/index.ts`: `makeOpenInApp()` を注入する。
- `apps/web/client-solid/components/status.tsx`: 検出済みアプリの選択と「開く」。0 件なら理由を出す。

## 検証

- `pnpm exec vp test apps/web/tests/open-in-app.test.ts`: 16 passed（検出・範囲検査・symlink・argv・失敗理由。アプリは起動しない）
- `pnpm exec vp test apps/web/tests/server.test.ts -t "viewer opens the session workspace"`: 1 passed（RPC が port に届き、host の command は空のまま）
- `pnpm exec vp test`（`apps/web/client-solid`）: 210 passed（ステータスバーの選択と理由の 2 件を含む）
- `pnpm run check`, `pnpm run build:web`: 以下で確認する。
