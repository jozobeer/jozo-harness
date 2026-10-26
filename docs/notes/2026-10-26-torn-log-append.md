# 切れたログの修復に失敗したあと、次の append がログを壊す

## 現象

`session.v1.jsonl` の末尾が改行で終わっていないとき、open は完全な行だけを残して `session/repaired` を書こうとする。2026-10-14 の実装はこの書き込みを対象ファイルへの `writeFile` で行っていた。`writeFile` は先にファイルを切り詰める。書き込みの途中でプロセスが死ぬと、書けていた行が消える。

書けなかった場合（ディレクトリに書けない、ディスクが足りない）でも open は成功し、sink は `appendFile` のままだった。次の append は切り株の末尾に新しい行を接着する。ファイルは改行で終わるので、次の open は切れた行とは見なさない。接着された行は JSON として不正で、`decodeEvents` はログ全体を拒否する。大きいログの書き換えは失敗し、短い 1 行の append は成功する、という状況で再現する。

## 直し方

修復は隣の一時ファイルへ書いてから rename する。rename の前に死んでも、元のファイルは残る。修復を書けなかった open は、メモリ上には `session/repaired` を載せたまま、次の append で「残した行 + 注記 + 新しい行」を同じ rename で書き直す。注記をメモリに残すのは、次の seq が注記と重ならないようにするためである。ファイルとメモリが揃うのは、その書き直しが成功したときだ。

## 確かめ方

```sh
pnpm exec vp test packages/core/session-jsonl/tests/failures.test.ts packages/core/session-jsonl/tests/durability.test.ts
```

2026-10-26 に上記を実行し、失敗系と耐久の両ファイルが通った。失敗する修復はセッションディレクトリを `0o500` にして再現した。ファイルだけを読み取り専用にしても rename は成功する。
