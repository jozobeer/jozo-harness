# jozo-harness と dsh の同一タスク A/B（2026-10-14、長いタスクは 2026-10-15）

4 つのコーディングタスクを jozo-harness と dsh に同じ文面で投げ、それぞれのセッションログからツール呼び出し回数・失敗した edit の数・読み直しの回数・turn 数・compaction の回数を数えた。判定はワークスペースのファイルだけを見る（モデルの自己申告は使わない）。

## 条件

- 実行者: `bun run scripts/ab/run.ts`（リポジトリのルートから）。タスクは `jzh:scripts/ab/tasks.ts`、計数は `jzh:scripts/ab/metrics.ts`、dsh の経路は `jzh:scripts/ab/dsh-provider.patch.yml`。
- モデルは両ハーネスとも Ollama Cloud の `deepseek-v4.1-flash`（jozo-harness は自前の OpenAI 互換 adapter、dsh は pi-ai 経由で同じ baseURL・同じモデル名）。jozo-harness は `~/.config/jzh/secrets.env` の鍵を自分で読み、dsh は harness が同じ鍵を環境に渡す。
- 1 セル（ハーネス × タスク）を 3 回繰り返した。合計 24 走、タイムアウトは短いタスクが 300 秒/走、`fix-rules` が 1,200 秒/走。
- compaction の発火点は両ハーネスとも 16,000 トークンにそろえた（jozo-harness は `jzh:scripts/ab/run.ts` の patch で window 20,000 / headroom 4,000、dsh は patch で window 52,768 / headroom 4,000。dsh は出力予約 32,768 も差し引く）。そろえる前は jozo-harness が 62,464（当時の既定 window 128,000）、dsh が 163,840 で、長いタスクでは設定の違いだけで jozo-harness が先に圧縮していた。短いタスクのリクエストは最大で jozo-harness 5,174 / dsh 10,352 トークンで、どちらの線にも届かない。
- タスク:
  1. `fix-add` — `src/math.ts` の `add` が引き算になっているので足し算に直す。
  2. `write-notes` — `# Notes` 見出しと `status: ready` の行を持つ `notes.md` を作る。
  3. `rename-function` — `fetchValue` を `readValue` に、`src/` 全体で改名する。
  4. `fix-rules` — `src/rules/` の 48 ファイルのうち、ヘッダの説明と食い違う 12 個のルール関数を直す（`jzh:scripts/ab/rules-task.ts`）。判定はワークスペースのルールを乱数入力で実行し、判定側の参照実装と比べる。
- 計数の定義: tool calls は `tool/call` の数、failed edits は edit の結果がエラーだった数、re-reads は同じセッションで既に読んだパスをもう一度 read した数、turns は `turn/start` の数、compactions は要約を書いた回数（jozo-harness は `compaction/checkpoint`、dsh は `compaction/summary`）。

## 正規化した軸（2026-10-19 追記）

この A/B は endpoint と compaction の線をそろえた。そろえた軸は比較の前提であり、「差が無いことの証拠」ではない。軸の定義と記録方法は [DSH パリティ監査の軸](2026-10-19-parity-audit-axes.md) に固定した。以下の 2026-10-15 までの節にある「既定の窓 128,000 / 線 62,464」は当時の profile の値である。現在の既定は窓 1,048,576、線 589,824 である。

| 軸 | 当時の production | この A/B の値 | この A/B で言えなくなること |
|---|---|---|---|
| endpoint | local daemon が答えれば `http://127.0.0.1:11434/v1`、答えなければ `https://ollama.com/v1` | 両ハーネスとも `https://ollama.com/v1` | prompt cache の差、endpoint 由来の latency の差 |
| compaction line | 62,464（窓 128,000、headroom 65,536） | 16,000（jozo-harness は窓 20,000 / headroom 4,000、dsh は窓 52,768 / 予約 32,768 / headroom 4,000） | 当時の production の窓での compaction の回数・位置の差 |
| model metadata | モデル定義を宣言せず、窓 128,000 の既定に落ちていた | jozo-harness は窓 20,000、dsh は 52,768 / 32,768 | モデル定義の窓に由来する差 |

このため、結果の節の「ハーネス由来の系統差は観測されなかった」は、endpoint と compaction の線をそろえた範囲の主張である。cache と production の線については何も言っていない。production の既定のまま走らせた A/B セルはまだ無い。次回は、local daemon が答える状態で両ハーネスの endpoint を local daemon にし、dsh は窓・compaction 行を patch しない版（未作成）、jozo-harness は `JZH_AB_SHIPPED_WINDOW=1` で 1 セル以上走らせ、`cacheReadTokens`、compaction の件数、step 数を記録する。タスクは `find-disagreement` を使う（約 87,780 推定トークンで、現在の production の線 589,824 には届かないので compaction は 0 件の記録になる）。

## 結果: 短いタスク（3 回の幅と平均）

`counted` は数値の出た走の数で、幅と平均はその走だけから出る。

| harness | task | runs | counted | done | tool calls | turns | failed edits | re-reads |
|---|---|---|---|---|---|---|---|---|
| jozo-harness | fix-add | 3 | 3 | 3 | 3-4 (3.3) | 1 | 0 | 1 |
| dsh | fix-add | 3 | 3 | 3 | 3-4 (3.7) | 1 | 0 | 1 |
| jozo-harness | write-notes | 3 | 3 | 3 | 2-3 (2.3) | 1 | 0 | 0 |
| dsh | write-notes | 3 | 3 | 3 | 2-4 (3.0) | 1 | 0 | 0 |
| jozo-harness | rename-function | 3 | 3 | 3 | 7-14 (10.3) | 1 | 0 | 0-2 (1.3) |
| dsh | rename-function | 3 | 3 | 3 | 8-12 (10.0) | 1 | 0 | 0-2 (0.7) |

走ごとの値（参考）:

| harness | task | run 1 | run 2 | run 3 |
|---|---|---|---|---|
| jozo-harness | fix-add | 4 calls / 1 re-read | 3 / 1 | 3 / 1 |
| dsh | fix-add | 3 / 1 | 4 / 1 | 4 / 1 |
| jozo-harness | write-notes | 3 / 0 | 2 / 0 | 2 / 0 |
| dsh | write-notes | 2 / 0 | 4 / 0 | 3 / 0 |
| jozo-harness | rename-function | 10 / 2 | 7 / 0 | 14 / 2 |
| dsh | rename-function | 10 / 0 | 12 / 2 | 8 / 0 |

## 差の説明

- **完了と turn 数に差は無い**。6 セルすべて 3/3 完了、どの走も 1 turn。3 タスクは 1 turn で終わる大きさなので、turn 数はハーネスの差を写さない。
- **失敗 edit は両方 0**。どちらの edit も一発で当たっており、この 3 タスクでは edit の当たり外れが差にならない。
- **tool calls の差は走ごとのばらつきに埋もれている**。rename-function は jozo-harness が 7〜14、dsh が 8〜12 で、平均の差（10.3 対 10.0）より各ハーネス内の幅の方が大きい。n=3 でこの幅では、平均の 0.3 回を「dsh の方が少ない」と読む根拠は無い。
- **読み直しの型は同じ**。fix-add は両方とも「read → edit → read」で、最後の read が同じパスの 2 回目になる（1 re-read）。rename-function の 0〜2 回は、改名後に両ファイルを読み直して確認した走だけに出る（jozo-harness 2/3 走、dsh 1/3 走。n=3 では区別できない）。jozo-harness は 1 走で `bash(git diff)` を挟んでから読み直し、dsh は 1 走で編集前に `ls -R` を重ねた——どちらも同じ確認行動の別表現で、頻度の差ではない。
- したがって、この 3 タスク・n=3 の範囲では **ハーネス由来の系統差は観測されなかった**。

## 結果: 長いタスク（fix-rules、2026-10-15）

| harness | task | runs | counted | done | tool calls | turns | failed edits | re-reads | compactions |
|---|---|---|---|---|---|---|---|---|---|
| jozo-harness | fix-rules | 3 | 3 | 3 | 84-95 (88.7) | 1 | 0 | 13-26 (18.7) | 2-10 (6.3) |
| dsh | fix-rules | 3 | 3 | 3 | 55-112 (83.3) | 1 | 0 | 12-44 (25.0) | 10-16 (12.3) |

走ごとのリクエストの入力トークン（provider の usage。dsh は input + cacheRead）と、要約が書かれた位置（C）:

```
jozo-harness-1: 3880 4318 4719 8607 14402 C 15324 C 15848 C 16282 C 16832 C 17537 C 17198 C 20797 C 21379 C 15495 C 9248 … 14827
jozo-harness-2: 3880 4322 5670 13419 C 15637 C 16189 C 16765 C 17116 C 17522 C 11219 … 15035 C 10665 … 14246
jozo-harness-3: 3880 4324 9176 10728 11177 13750 16334 C 7767 … 16666 C 10468 … 12900
dsh-1:  8586 10222 10681 11770 13680 C 14473 C … 23733 C 25681 C 25899 C C 15078 C 14985 C 14862
dsh-2:  8586 10222 10709 13909 15841 C 14759 C 14040 16410 C … 15574 C 16235
dsh-3:  8586 9105 11417 14954 C 16636 C 13623 C … 15640 C 14305 C 15136
```

- **完了は両方 3/3、失敗 edit は両方 0**。どの走も compaction を経たうえで 12 個すべてを直した。この範囲では、compaction がタスクの完了を壊すことは観測されなかった。
- **compaction の回数は dsh の方が多い**（jozo-harness 2〜10、dsh 10〜16 で幅が重ならない）。ただし回数の大半は空回りである。両ハーネスとも、要約の直後のリクエストが線の少し下（約 15,000）までしか縮まず、次の step でまた発火する。縮みきったのは jozo-harness-3 の 1 回目（16,334 → 7,767）と jozo-harness-1 の終盤くらいである。
- **空回りの仕組み（jozo-harness）**: jozo-harness は末尾 12 メッセージを残し（`DEFAULT_COMPACT_KEEP_LAST`）、その手前の 8 件前後だけを要約する。要約は前の要約を含めて書き直されるので、jozo-harness-1 では 3,708 字から 9,395 字へ育つ。システムプロンプト + 要約 + 末尾 12 件で約 15,000 になり、線の下に戻れない。保持がメッセージ数で決まり、圧縮後の大きさを線の下に収める目標を持たないことが原因である。
- **dsh の方が多い理由は未確認**。dsh の初回リクエストは 8,586 トークンで jozo-harness（3,880）の 2 倍あり、線までの余裕が小さいことは数字から言えるが、それが回数の差をどれだけ説明するかは切り分けていない。
- **tool calls と re-reads はばらつきに埋もれている**。dsh は 55〜112、re-reads 12〜44 と幅が大きく、平均の差は走間の幅より小さい。
- 16,000 は長さを縮めた線である。当時の実際の窓（jozo-harness 62,464 / dsh 163,840）では、線に対して保持分と要約が小さくなるので空回りは起きにくいと見込むが、測っていない。

## 空回りを直した後の再測（2026-10-15、同じ fix-rules × n=3）

保持をトークン目標に変え（`retainTokens`、既定は窓の 16%）、メーターが生ログではなく畳んだ履歴を測るようにした後、同じコマンド（`JZH_AB_TASKS=fix-rules JZH_AB_REPEATS=3 bun run scripts/ab/run.ts`）を走らせ直した。

| harness | task | runs | counted | done | tool calls | turns | failed edits | re-reads | compactions |
|---|---|---|---|---|---|---|---|---|---|
| jozo-harness | fix-rules | 3 | 3 | 3 | 81-122 (97.7) | 1 | 0 | 5-49 (26.3) | 3-4 (3.7) |
| dsh | fix-rules | 3 | 3 | 3 | 71-94 (83.0) | 1 | 0 | 19-24 (21.3) | 9-12 (10.3) |

走ごとの入力トークンと要約の位置（C の括弧は要約の字数）:

```
jozo-harness-1: 3894 4355 5379 6768 7986 9572 11741 13890 16042 C(10213) 12016 13116 14982 C(11102) 11266 12157 12268 12381 C(10811) 16259 C(11807) 8902 9404 10649 10987
jozo-harness-2: 3894 4349 5747 7107 15063 C(4450) 8905 10637 12358 14925 C(6006) 9442 11370 13292 15448 C(7644) 10928 13485 13660 13776 13860 C(4238) 12231 12484 13173
jozo-harness-3: 3894 4377 8292 11133 13944 C(4572) 9160 11038 C(6823) 9775 12701 13965 C(8071) 11873
```

- **要約の直後のリクエストは 11 件中 10 件が線（16,000）の下**に入った（8,905〜12,231）。前回は要約の直後が 15,000〜21,000 に留まり、C が連続していた。回数は 2〜10（6.3）から 3〜4（3.7）へ減り、連鎖は消えた。
- **残る 1 件（jozo-harness-1 の 16,259）は、保持の外に置けない最新の 1 件が目標より大きい場合**である。その時点の畳み込みは枠 507 + 要約 2,762 + 末尾 7,503（1 件、推定トークン）で、末尾の 1 件が目標 3,200 に入らないため「最新は大きさによらず残す」規則が働いた。保持の外の tool 結果は刈られるが、保持の中は刈らない（モデルが今使っているものを壊さないため）。要約では解決できない種類の超過である。
- **要約は 4,238〜11,807 字**。前回は 3,708 字から 9,395 字へ育った。1 回の要約が覆う範囲が広がったためで、保持が小さいことの裏返しである。
- **完了は 3/3、失敗 edit は 0**。保持を小さくしても長いタスクは完走した。
- **tool calls と re-reads は増えた可能性がある**（81〜122 / 5〜49、前回 84〜95 / 13〜26）。ただし n=3 で走間の幅（特に re-reads 5〜49）に埋もれ、dsh の re-reads 19〜24 と同じ帯なので、保持を小さくした影響とは断定しない。
- 未確認: 16,000 は依然として縮めた線である。既定の窓（128,000、目標 20,480）で最新の 1 件が目標を越えるのは 82 KB 級の 1 件が来たときで、そこでの挙動は測っていない。**同日追記**: 実窓で測った（下の節）。

## 推定と provider の実測（2026-10-15、下の再測 3 走の 65 リクエスト）

メーターの推定（tools を含む）と、provider が申告した入力トークンを突き合わせた。比（推定 ÷ 実測）:

| 平均 | 最小 | p10 | 中央 | p90 | 最大 |
|---|---|---|---|---|---|
| 1.010 | 0.892 | 0.936 | 0.992 | 1.117 | 1.436 |

- 偏りは無い（平均 +1%、中央 0.992）。ばらつきは ±10% 程度で、内容の濃さ（JSON・識別子・散文の混ざり方）でトークン/バイトが変わるためである。1.436 は要約の直後に出る——アンカーの実測から消えた分をバイトで引きすぎた側。
- 下振れ側（p10 の 0.936）でも線を 6% 越える程度で、headroom（16,000 の線に 4,000、出荷の 62,464 に 65,536）が吸収する。補正係数は入れない。平均が 1 に乗っており、モデルや題材を変えれば符号も変わりうる。
- 測り方: `meterOf(その step の直前までのイベント)` と `assistant/message` の `usage.inputTokens` を比べる（`.tmp` の使い捨てスクリプト。ログは `.tmp/ab/runs/` に残っている間だけ）。

## メーターが tools を数えるようにした後の再測（2026-10-15、fix-rules × n=3）

線は「リクエスト全体」に対する約束なのに、メーターはメッセージしか数えておらず、毎リクエスト送っている tool の schema（この profile で 3,075 トークン）を数えていなかった。dsh のメーターは `estimateToolsTokens(header)` で数えている（`dsh:packages/llm/token-meter/src/index.ts:164`）。同じに揃えてから、同じ fix-rules を jozo-harness だけで 3 回走らせ直した。

| harness | task | runs | counted | done | tool calls | turns | failed edits | re-reads | compactions |
|---|---|---|---|---|---|---|---|---|---|
| jozo-harness | fix-rules | 3 | 3 | 3 | 68-96 (85.0) | 1 | 0 | 2-25 (15.3) | 4-8 (5.7) |

```
jozo-harness-1: 3895 4342 12105 C(3976) 8691 16451 C(6441) 9580 11295 13017 14526 C(8801) 10913 11049 11450 12203 12874 12967 15025 C(7793) 8007 12934 14320 15287 15408 15826 C(8859) 9684 9911 10149 10253 12136 16394
jozo-harness-2: 3895 3979 4364 12113 C(4560) 8830 16590 C(6325) 8574 12467 C(7854) 9943 13831 C(9339) 10472 14379 C(8991) 10598 13149 15015 C(10217) 11779 C(10600) 13607 14065 14919 16221 C(10894) 10778
jozo-harness-3: 3895 4347 5710 14418 C(5708) 9292 15099 C(8570) 10345 14233 C(9947) 10854 14783 C(11472) 11639 12597 13550 14278 14820 15059
```

- **要約の直後のリクエストは 17 件中 17 件が線の下**に入った（8,007〜13,607）。tools を数える前は 11 件中 1 件が線を越えていた（メッセージだけで線を見ていたので、実際のリクエストは最大 ~19,000 まで伸びていた）。
- 回数は 3〜4（3.7）から 4〜8（5.7）へ増えた。線をリクエスト全体で守るようになった分、正しく早く発火する。連鎖（要約の直後にまた発火）は無い。
- 走ごとの幅は大きい（tool calls 68〜96、re-reads 2〜25、compaction 4〜8）。前回との差は走間の幅に埋もれるので、回数以外の差は主張しない。
- 未確認: 最後のリクエストが 16,221（run 2）と線を 1.4% 越えた。推定は provider の実測に対して 0.5〜3% の範囲でずれる（下の節）ので、この程度の超過は headroom が吸収する前提である。

## 出荷した窓での実測（2026-10-15）

当時の既定の窓（128,000、headroom 65,536）の線は 62,464 である。A/B は線を 16,000 に縮めて比較しているので、実窓での compaction は未確認だった。線を越えさせるタスクを 2 つ足して測った。

- `read-report`: data/ の 24 KB × 16 を読ませる。**線に届かなかった**。モデルは最初の 8 本を全文で読み、残りは `offset` で末尾だけ読んだ（要約に必要なのは末尾の行だと判断したため）。リクエストは最大 53,253 トークンで、compaction は 0 回。読み物タスクは、線を越えさせる目的には使えない。
- `long-prompt`: 315 KB のプロンプト 1 発（約 78,750 推定トークン）。`JZH_AB_HARNESS=jozo-harness JZH_AB_TASKS=long-prompt JZH_AB_SHIPPED_WINDOW=1 bun run scripts/ab/run.ts` で 1 走。結果は done、tool calls 2、**compaction 2 回**。リクエストの並び（括弧は要約の字数）:

```
C(554) 82955(要約直後) C(1210) 4196(要約直後) 4259
```

- 線は 1 発目で越えた。畳み込み 79,443 + tools 3,075 = 82,518 の推定に対し、provider の実測は 82,955（**0.5% 差**）。2 つ目の要約の直後は 4,083 の推定に対し 4,196（**3% 差**）。推定は tools を含めれば実測に追随する。
- **要約の直後が 82,955 と線を越えた**。理由は記録済みの限界で、最新の 1 件（この場合は 315 KB のプロンプトそのもの）が保持の目標 20,480 より大きいため「最新は大きさによらず残す」規則が働き、要約が覆えるのは枠だけになる。次の step の 2 回目の要約で 4,196 まで下がり、走りは完了した（done）。
- 限界: n=1、そしてこの形は「1 件が線より大きい」極端な場合である。多数の中くらいのメッセージで線を越える通常の形は、下の `find-disagreement` と、縮めた線（16,000）の n=3、同じ規則を既定の予算で回す e2e（`apps/cli/tests/compaction-e2e.test.ts` の「the window a profile does not name keeps its own line」）で押さえている。
- `find-disagreement`: data/ の 40 ファイル（343 KB、約 87,780 推定トークン）にクレートの主張が並び、どのファイルも同じクレートを 2 回数えている。2 つの数が食い違うファイルは 1 つだけで、その id は規則的（id は意図的に重複する）なので、**数を読まないと解けない**。40 本のうち食い違うのは 36 本目なので、線を越えてから見つかる。1 走（`JZH_AB_HARNESS=jozo-harness JZH_AB_TASKS=find-disagreement JZH_AB_SHIPPED_WINDOW=1`）で done、tool calls 143、**compaction 1 回**。リクエストの並び:

```
3905 3984 4233 11067 11123 13029 13103 14614 14687 15266 15454 15608 22470 22872 25267 38177 C(4883) 5314(要約直後) 6374 7221 8924 11356 12353 14726 17097 18289 19452 19870 20031
```

- 38,177 の次の step で、読み足した分を足すと線を越えると推定して発火し、**要約の直後は 5,314 トークン**（線の 8.5%）に収まった。以後は 20,031 まで緩やかに伸びており、掃除と保持が効いている。タスクは完走した（done）。
- これが「通常形」（中くらいのメッセージが多数）の実窓での証拠である。極端形（`long-prompt`）と合わせて、実窓の n=2、縮めた線の n=3 になった。

## 計数の訂正（同じログの数え直し）

最初の集計は dsh の re-reads を 0 と数えていた。dsh の read は引数を `file_path` に、jozo-harness は `path` に置くのに、計数が `path` だけを見ていたためである（行動ではなく計測の不具合）。`jzh:scripts/ab/metrics.ts` を両方の綴りを読むように直し、`scripts/ab/metrics.test.ts` に dsh 綴りの回帰を足した。上の表は同じ 18 走のログを数え直した結果で、モデルは走らせ直していない（ログは `.tmp/ab-2026-10-14/runs/<harness>-<task>-<n>/` に退避してある。`run.ts` は実行のたびに `.tmp/ab` を消す）。

## 再実行

```
bun run scripts/ab/run.ts                      # 1 回ずつ
JZH_AB_REPEATS=3 bun run scripts/ab/run.ts    # 3 回ずつ（上の表）
JZH_AB_ROUTE=ollama-cloud/qwen3-coder:480b bun run scripts/ab/run.ts
JZH_AB_TASKS=fix-rules JZH_AB_REPEATS=3 bun run scripts/ab/run.ts   # 長いタスクだけ
JZH_AB_HARNESS=jozo-harness JZH_AB_TASKS=long-prompt JZH_AB_SHIPPED_WINDOW=1 bun run scripts/ab/run.ts
```

- 成果物: `.tmp/ab/runs/<harness>-<task>-<n>/` に workspace、セッションログ（jozo-harness は `sessions/session.v1.jsonl`、dsh は `dsh-home/sessions/**/session.v4.jsonl.zstd`）が残る。
- 環境変数: `JZH_AB_REPEATS`（既定 1）、`JZH_AB_ROUTE`（既定 `ollama-cloud/deepseek-v4.1-flash`）、`JZH_AB_TIMEOUT_MS`（既定 300000。タスクが自分の値を持てばそちら）、`JZH_AB_TASKS`（カンマ区切りのタスク名。既定は全部）、`JZH_AB_HARNESS`（カンマ区切りの harness 名。既定は両方）、`JZH_AB_SHIPPED_WINDOW=1`（jozo-harness の窓を patch せず、出荷した既定のまま走らせる）。
- タスク: `fix-add` / `write-notes` / `rename-function`（短い）、`fix-rules`（48 ファイルの長いタスク。発火点 16,000 の比較用）、`read-report`（24 KB × 16 の読み。実窓では線に届かず、モデルは末尾だけ読んだ）、`long-prompt`（1 つの巨大なプロンプト。実窓の線を確実に越えさせる）、`find-disagreement`（40 ファイルの主張を読み比べる。通常形で実窓の線を越える）。既定は 7 つ全部なので、短い比較だけを回すときは `JZH_AB_TASKS=fix-add,write-notes,rename-function` のように選ぶ。

## 限界

- n=3、モデル 1 つ。どのタスクも 1 turn で終わり、edit の失敗は起きなかった。多 turn と subagent は測っていない。
- 長いタスクは発火点を 16,000 に縮めて測った。**2026-10-15 追記**: 当時の出荷した窓（128,000、線 62,464）でも 1 走だけ測った（下の節）。縮めた線での n=3 が主で、実窓は n=1 である。
- ツールセットは両ハーネスで同じではない（dsh は `present`・`herdr` なども持つ）。プロンプトと作業ディレクトリだけを揃えた比較である。
- モデルの出力は非決定的で、幅は上の表のとおり。平均の差を主張するには走数を増やす必要がある。
