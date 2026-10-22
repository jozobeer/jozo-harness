# 回答の図解はどの形式で出すか

Issue #300 の決定。当初は「表・コードブロック・artifact ページ」の3形式に絞ったが、同日に SVG と画像もチャットで見たいという要求を受けて方針を変えた。この文書は変更後の決定である。

## 決めたこと

図はまずチャット本文に置く。本文で足りない大きさのときだけ artifact のページにする。

| 形式 | 使う場面 | 出し方 |
| --- | --- | --- |
| markdown の表 | 比較・一覧・対応（案 A と B の差、設定キーと既定値） | 本文の GFM パイプ表（#298） |
| ```svg のフェンス | 本物の図（箱と矢印、状態遷移） | 中身を allowlist でサニタイズしてインライン SVG として描く（#310） |
| 本文の生 `<svg>` | 同上。フェンス無しで書かれたとき | 行頭の `<svg` から `</svg>` までを1枚として描く（#311） |
| markdown の画像 | 既存の画像ファイル・URL・base64 の data URL | `<img>`（#309）。data URL は png / jpeg / gif / webp のみ、2MB まで（#300） |
| コードブロックの図 | 小さな関係・順序（3〜5 ノードの依存、処理の流れ） | ```text の fence。`pre.code` は横スクロールする |
| artifact の HTML ページ | 大きく視覚的な図・レイアウト・触れる図 | `artifact` tool。opt-in の plugin 行が要る |

## 画像の data URL

markdown の画像記法の src には、http(s) の URL と base64 の data URL を取る。data URL は `<img>` の secure static mode で描くので、ラスタ画像に限れば allowlist は要らない。

- 描く MIME: `data:image/png`、`data:image/jpeg`、`data:image/gif`、`data:image/webp` の `;base64,` 形式
- 上限: data URL の文字列が 2,000,000 bytes（2MB）。超えたら画像ではなく `alt` をラベルにしたリンクとして出す
- 描かないもの: `data:image/svg+xml` の data URL（SVG はフェンスか生タグの allowlist 経路に寄せる）、`javascript:` などの他のスキーム。従来どおり記法のまま文字で出す

実装は `apps/web/src/ui/diagram.ts` の `imageViewOf` が持ち、描く・リンクする・文字のままの3通りを返す。

## SVG の描き方

本文にインラインの `<svg>` として置く。当初は base64 の `data:image/svg+xml` にして `<img>` に入れる案だったが、`<img>` の中の SVG はページの CSS 変数も `currentColor` も受け取らず、文字を選択・検索できず、`<title>` も本文の一部にならないため、インラインに変えた。

代わりに、要素と属性の allowlist を持つサニタイズ境界を自前で維持する（`apps/web/src/ui/svg.ts`）。

- 通す要素: svg, g, path, rect, circle, ellipse, line, polyline, polygon, text, tspan, title, desc, defs, marker, linearGradient, radialGradient, stop, clipPath, use
- 通す属性: viewBox, width, height, d, x, y, x1, y1, x2, y2, cx, cy, r, rx, ry, points, fill, stroke, stroke-width, stroke-linecap, stroke-linejoin, font-size, font-family, text-anchor, dominant-baseline, transform, opacity, id, class, marker-start, marker-end, offset, stop-color, stop-opacity, gradientUnits, preserveAspectRatio, role, aria-label
- 落とすもの: script, foreignObject, iframe, image, a, style, animate 系, `on*` の属性, href / xlink:href
- サイズ: 100KB を超えるものは描かず、コードブロックのまま見せる
- パースに失敗したもの、閉じタグの無い `<svg` は、エスケープしたテキストとして出す

## 採らない形式と理由

- **Mermaid**: 描画器の依存と、崩れたときのフォールバック設計が要る。SVG を直接描ければ足りる。
- **DOMPurify などのサニタイズ依存**: allowlist は自前で持つ。依存を足すと、その依存の更新と挙動の追跡が要る。

## 置き場所

- 常設: system prompt の identity に、形式の振り分けを短く置く。
- 詳細な作法（ノードの書き方、色、幅の目安）は、必要になった時点で skill に切り出す。

## 残る制約

`artifact` は opt-in なので、plugin 行の無い run ではページを出せない。その場合は本文の SVG・表・コードブロックで収める。ページを既定で有効にするかは、この決定の範囲外とする。