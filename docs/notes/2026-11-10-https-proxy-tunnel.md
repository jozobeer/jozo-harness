# HTTPS の proxy がトンネルを使わず直接つなぐ

## 現象

`HTTPS_PROXY` を設定しても、https の外向き通信は CONNECT の先へ出ていなかった。`sendOverTunnel` はトンネルの TLS ソケットを `https.request` の `createConnection` に渡す一方で `agent: false` も渡していた。Node は `agent: false` を「既定の Agent を新規に作る」と解釈し、`createConnection` を無視して対象ホストへ直接ダイヤルする。直接出られる環境では proxy を迂回し、直接出られない環境ではモデルへの接続と `web_fetch` が失敗する。

Node 26 では、対象ホストが IP アドレスのとき `tls.connect` の `servername` にその IP を渡すと同期的に例外を投げる。例外は `connect` ハンドラから漏れ、fetch の Promise は解決せず、プロセスは未処理例外になる。

## 直し方

`agent` は渡さない。トンネルのソケットは既に TLS なので、`createConnection` がそれを返す。ホストが IP のときは `servername` を付けない。`tls.connect` の同期例外とハンドシェイク失敗は Promise の reject にする。応答を読み終えたらソケットを閉じる。Node は `createConnection` で渡したソケットを自分では閉じない。

## 確かめ方

```sh
pnpm exec vp test packages/llm/llm/tests/proxy.test.ts
```

2026-11-10 に Node 26.8.2 で上記を実行し、19 件が通った。トンネルを転送しない proxy に対して、修正前の `agent: false` は上流へ直接届き、`createConnection` だけにしたリクエストはトンネルの先で止まった。
