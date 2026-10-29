# Landlock の fallback が truncate を落としていた

`landlock-run` は `AccessFs::from_write(ABI::V3)` を best-effort で適用し、`RulesetStatus::NotEnforced` 以外を成功にしていた。crate の既定は未対応の権利を黙って落とす。Linux 6.2 より前（Landlock ABI 2 以下）では `truncate` が落ち、ruleset は `PartiallyEnforced` のままコマンドを実行する。

`truncate(2)` は `WRITE_FILE` の対象外である。ABI 2 相当の ruleset では作業ディレクトリの外への `open(O_WRONLY)` は拒否されるが、`truncate(2)` は通る。

確認は kernel 6.12（ABI 6）上で、V3 の書き込み集合から `truncate` を外した ruleset を当てて行った。

```sh
# /tmp/ll-poc で landlock 0.4.7 を使い、writable 以外を from_write(ABI::V2) にした
./target/debug/ll-poc v2
```

結果: `status=PartiallyEnforced`、`truncate_outside=ok`、対象ファイルは空。同じ場所へのリダイレクトは `Permission denied`。`from_write(ABI::V3)` では `truncate_outside` は `Permission denied` で内容は残った。このホストの ABI は `landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)` が 6 を返した。

修正後の helper は書き込み一式を hard requirement にし、`FullyEnforced` 以外では probe を失敗させる。ファイル（`/dev/null`）の rule はディレクトリ専用の権利を外し、その調整だけで partial にならないようにする。
