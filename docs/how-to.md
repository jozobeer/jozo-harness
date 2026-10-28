# 設定の手順

キーの一覧と意味は [configuration.md](configuration.md) にある。

## モデルを変える

```sh
jzh models                                  # 使えるモデルを見る
jzh config set model ollama-cloud/glm-5.3   # 既定を書き換える
jzh config                                  # 入ったことを確かめる
```

1回だけ変えるなら `--model` を付ける。

```sh
jzh --model ollama-cloud/gemma4:31b "Reply with the single word pong"
```

## 推論の強さ（effort）を選ぶ

モデルにどこまで考えさせるかを、ルートと同じ3経路で決める。

```sh
jzh --effort high "このモジュールの分割方針を検討して"   # 1回だけ
jzh config set effort low                                  # 既定にする
jzh config                                                 # 入ったことを確かめる
```

行に書くこともできる（`model` と同じで、どの行でも読まれる）。

```yaml
plugins:
  - id: agent-loop
    name: '@jozo-harness/agent-loop'
    config:
      effort: high
```

優先順は `--effort` > 設定ファイルの `effort` > 行の `effort` で、どれも無ければ provider の既定になる。値は `reasoning_effort` としてそのまま provider に渡るので、受け付ける語は provider が決める（`jzh --dump-config` が「effort in effect:」で実効値を出す）。

## ブラウザ UI でセッションを始める

`jzh web` が出す起動 URL は、その run だけの短命 code（60 秒・1 回限り）を `?code=` に載せる。ブラウザが開くとサーバが code を `HttpOnly; SameSite=Strict; Path=/` の cookie と交換し、303 で `/` に戻すので、アドレス欄・履歴・転送されたメッセージに残るのは交換前の code だけになる。cookie はその run の間だけ有効な session cookie で、https で配信されている場合（`x-forwarded-proto: https`）だけ `Secure` を足す。交換済み・期限切れの code は 401 になる。WebSocket はこの cookie で認証し、Origin の検査はそのまま残る。テストやスクリプトが使う `ws://.../ui?token=...` の直接指定も引き続き受け付ける。

`jzh web` を開いただけではセッションは作られない。**最初のメッセージを送ったとき**（または `New session` を押したとき）に作られ、そのセッションが使うモデルと effort は、そのとき効いている設定（`--model` / `--effort` > 設定ファイル > 行）で決まる。composer のモデルのチップと effort の選択は、セッションを開く前からこの出発点を表示し、そこで選び直せる。

設定シートの `model` は「これから開くセッション」に効く。選んで `Use for new sessions` を押すと、そのあと開くセッションはそのモデルで始まり、同時に設定ファイルにも書かれるので次の run も同じモデルで始まる。すでに開いているセッションのモデルは、そのときには変わらない（下の「モデルを選ぶ」で変える）。

### tailnet の別端末から開く

`jzh web` は起動時に Tailscale を検出する。`tailscale status --json` からこのマシンの tailnet IPv4 と MagicDNS 名が取れたときは、`127.0.0.1` に加えてその IPv4 でも同じポートを listen する。`0.0.0.0` や `::` では受けない。Tailscale が無い・落ちている・CLI が PATH に無い・応答が遅いときは検出なしとして、従来どおり loopback だけで動く。

検出できた run の起動メッセージは次のようになる。`--public-url` を付けたときは最後の行も出る。

```
jzh web: local   http://127.0.0.1:4310/?code=...
jzh web: tailnet http://100.x.y.z:4310/?code=...
jzh web: tailnet http://<machine>.<tailnet>.ts.net:4310/?code=...
jzh web: public  https://<machine>.<tailnet>.ts.net/?code=...
```

各行は別の短命 code を持つので、片方を開いても他の URL は使える。tailnet の行は IP と MagicDNS の 2 つで、どちらも listen しているポートを URL に含める。同じ tailnet の別端末からこの行を開くと、ページが表示され socket もつながる。名前が取れない tailnet では IP の行だけ、IP が取れないときは loopback の 1 行だけになる。

ブラウザは MagicDNS 名を `Host` に載せるので、許可には IP だけでなく名前も要る。通すのは検出した IP と名前の完全一致（小文字化）で、どちらも listen ポートを付けた形だけである。ポートを省いた Host、別の tailnet ノードの名前、名前の後ろに何かを足した host は 403 になる。

ポート無しの `https://<machine>.<tailnet>.ts.net` で開きたいときは、これまでどおり Tailscale の `serve` に https を終端させ、公開する origin を `--public-url` で明示する。Serve は元の `Host` をそのまま渡すので、`--public-url` の Host と Origin だけが loopback に追加で通る。

```sh
# MagicDNS と HTTPS 証明書が有効になっていることが前提
tailscale serve --bg 4310
jzh web --public-url https://<machine>.<tailnet>.ts.net
```

`~/.config/jzh/config.yaml` に `port: 4310` を書いておけば `--port` は要らない（`jzh config set port 4310` でも同じ）。この URL は 443 の https なのでポートを持たない。`--port 0` は Serve の向き先が定まらないため、この使い方では固定 port を使う。`--public-url` の有無にかかわらず、tailnet の直 URL はポート付きの `http://` で出る。

起動 URL はその run を開ける credential である。code は 60 秒・1 回限りで、開けば `HttpOnly; SameSite=Strict` の cookie に変わり URL からは消える。**開く前の URL をチャットや issue に貼らない。** `--public-url` は https origin だけを受け付け、パス・query・fragment・userinfo が付いた値と `jzh web` 以外での指定は起動前にエラーになる。

### モデルにページを書かせる

`artifact` tool は opt-in である。使う run だけ、設定ファイルか `--patch` の `plugins:` に次の行を足す（profile に書くときも同じ形である）。

```yaml
plugins:
  - id: artifact
    name: '@jozo-harness/artifact'
```

行を足した run では、モデルにページを頼める。

```
この調査結果を report という名前の HTML ページにまとめて。表と図を 1 枚に入れて。
```

モデルが `artifact` に `{ deliverable: { path, title? } }` を渡すと、ページを書かずに作業ディレクトリ内の既存ファイルをその turn の成果物として宣言し、`deliverable: <path>` の 1 行を返す。`path` は cwd の中の実在するファイルに限り、cwd の外・存在しないパス・ディレクトリは `invalid-arguments` になる。宣言は読み取りだけで、preset が `read-only` でも拒否しない。

モデルが `artifact` に `{ name, html, images? }` を渡すと、run の session root の隣の `artifacts/<sessionId>/<name>.html` に書き、結果に `page: /artifact/<sessionId>/<name>` の 1 行を返す。preset が `read-only` の run では書かず、`denied` を返す。`name` は英数字と `.` `_` `-` だけで、`.html` は付けない。ページは CSS と JavaScript を中に持つ 1 枚の HTML にする。`images` は png / jpeg / webp / gif のパスを配列で受け、絶対パスか作業ディレクトリからの相対パスで書く。保存時に、HTML の `src` がそのパスを指す箇所を data URL へ畳むので、画像もページの中に入り、成果物は 1 ファイルで閉じる。1 枚は 2MB、合計は 10MB までで、超えると `invalid-arguments` になる。`img` の `src` や `link` の `href` など、ブラウザがサブリソースとして読む箇所に `http://` / `https://` / `//` を書くと `invalid-arguments` で拒否し、`images` に渡したのに HTML から参照していないパスも拒否する。外部ファイルを参照するページを保存しないので、保存された HTML は単体で完結する。

jzh web でそのセッションを開くと、結果の下にページが iframe で出る。iframe は `allow-scripts` だけを持つ sandbox なので、ページは jzh web の origin にも cookie にも触れない。`Open in a new tab` を押すと別タブで開く。

URL は相対パスなので、同じ tailnet の別端末から jzh web の tailnet の URL を開いても、その origin の `/artifact/...` として同じページが開く（開き方は「tailnet の別端末から開く」）。ページを配信するのは jzh web なので、起動していない run では URL を開けない。

会話の外でページを探すときは、右の Run ペインの `pages` を開く。会話の iframe がその turn の結果の下に出すページなのに対し、`pages` にはセッションが公開したページが新しい順に並ぶ。同じページは 1 行に畳まれ、対象は読み込んだ履歴のすべてで、いまの run が公開した分に限らない。行の名前は `<name>`（`.html` を除いたもの）で、`Open in a new tab` を押すと `/artifact/<sessionId>/<name>` が別タブで開く。`Download` は同じ URL に `?download=1` を付けて `content-disposition: attachment` として受け、`<name>.html` として保存する。ページは画像も data URL で持つ 1 ファイルなので、保存したファイルは jzh web もネットワークも無しに開ける。複数枚を公開したセッションではその数だけ行が並び、畳みも上限も無い。行の `Delete` はそのページをサーバーから消し、204 が返ると行が消える。消せなかったときは行が残り、その行に理由が出る。

同じ名前でもう一度書くと、ファイルが差し替わって URL は変わらない。開き直すと新しい中身になる。既定の profile に入れないのは、全セッションの tool 一覧を太らせないためである。

ページはセッションのログの隣に置く。セッションを削除すると、そのセッションが公開したページも一緒に消える。ログの `<sessions root>/<id>/` とページの `artifacts/<id>/` を同じ操作で消し、`/artifact/<id>/<name>` の URL も開けなくなる（#291 の時点ではページが残ったが、いまは残らない）。ページだけを消したいときは、Run ペインの `pages` の `Delete` か、ディスクの `artifacts/<id>/` から消す。

### モデルを選ぶ（走っているセッションと、これから開くセッション）

composer のモデルのチップを押すと、その endpoint が持つモデルの一覧が開く。選ぶと**そのセッションの route が変わり**、同時に**この run でこれから開くセッションもその route で始まる**。効くのは次のリクエストから（turn の途中なら次の step、待っていれば次の turn）。いま効いているモデルには印が付く。

セッションをまだ開いていなければ、チップは「いま始めるとしたら使う route」を出す。最初のメッセージを送る前（や `New session` の前）に選んでおけば、そのセッションはそのモデルで始まる。隣の effort の選択も同じで、開く前は「いま始めるとしたら使う effort」を出す。

一覧は provider の `GET /models` を叩くので、**チップを押したときだけ**読む。profile にモデル一覧を返す endpoint が無ければ、選ぶ代わりに理由がページに出る。返るのは `provider/model` の形で、provider は llm の行の `baseUrl` から決まる（知っている provider ならその route、知らなければ host 名）。

席の選択はこの run の中だけのもので、**設定ファイルには書かない**。次の run に持ち越す値は設定ファイルの `model` なので、`jzh config set model <provider/model>` か、設定シートの `Use for new sessions` で書く（その選択はこの run の選択でもあるので、設定シートの `model` の行は席の選択をそのまま映す）。

### effort を選ぶ（走っているセッションと、これから開くセッション）

ブラウザ UI（`jzh web`）の composer には、モデルの隣に effort の選択がある。セッションを開いていれば、選ぶとそのセッションの effort が変わり、効くのは**次のリクエスト**から（turn の途中なら次の step、待っていれば次の turn）。`default` は「provider に任せる」に戻す。選択肢に無い語が効いているとき（`--effort max` など）は、その語も選択肢に並ぶ。セッションを開く前は、その選択はこの run で次に開くセッションの出発点になる。

並ぶ語は endpoint が受ける語なので、llm の行が決める。書かなければ `low` / `medium` / `high` / `xhigh` / `max` で、空配列にすると選択肢を出さない。

```yaml
plugins:
  - id: llm
    name: '@jozo-harness/llm-openai'
    config:
      baseUrl: https://ollama.com/v1
      apiKeyEnv: OLLAMA_API_KEY
      reasoningEfforts: [low, medium, high, xhigh, max]
```

セッションを開いた後の切り替えはそのセッションだけに効き、**これから開くセッションには持ち越さない**（新しいセッションは run の解決から始まる）。開く前の選択は、この run で次に開くセッションの出発点になる。次の run に持ち越す値は設定ファイルの `effort` なので、`jzh config set effort <level>` で書く。

### 走っている turn に送る（steer）

turn が走っている間に composer から送った行は、既定では**次の turn** に積まれる（`queued`）。走っている turn の**次の step** に届けたいときは、送信モードを `steer` にする。turn が走っているときだけ、composer の席に `queue` / `steer` のチップが出る。押すと切り替わり、選んだモードはブラウザに残る。`Enter`（と送信ボタン）はそのモードで送り、`Cmd/Ctrl+Enter` は反対のモードで送る。turn が走っていないときはどちらも queue として扱われ、次の turn になる。

積まれた行は composer の上に出る。`queued` は次の turn、`steering` は走っている turn の next step。steer は turn を止めない。止めたいときは `Stop` を使う。

## 設定ファイルを雛形から始める

```sh
jzh config init    # 全キーをコメントで並べたファイルを作る
jzh config         # 値が入ったかを確かめる
```

`jzh config` が出すパスのファイルを開き、使う行の `#` を外す。

## API キーを入れる

```sh
jzh auth add ollama   # 端末に打つ。シェルの履歴に残らない
jzh auth list         # 入っている名前を見る
```

`.env` に書く場合は `OLLAMA_API_KEY=` を作業ディレクトリかその祖先に置く。どれが勝つかは [configuration.md](configuration.md) の環境変数の節にある。

## Ollama の local daemon 経由で prompt cache を効かせる

同梱の `base` profile は、`localBaseUrl` に `http://127.0.0.1:11434/v1` を置き、リクエストを常にその local daemon へ送る。dsh の web profile と同じく、daemon が動いている前提である。`baseUrl` の `https://ollama.com/v1` は `jzh models` がモデル一覧を読む先として残る。route のモデル名は cloud の名前（例 `deepseek-v4.1-flash`）のままで、local daemon へ送るときだけ Ollama の cloud 名（`deepseek-v4.1-flash:cloud`、タグ付きなら `deepseek-v4-pro:0813-cloud`）に直す。

local daemon が動いているかは、先に model 一覧で確かめられる。一覧が空でも、Ollama が cloud model を中継できればよい。

```sh
curl -sf http://127.0.0.1:11434/v1/models >/dev/null && echo local
```

cache が効いたかは、2 step 以上走る依頼を出したあと、セッションログの `assistant/message` の `usage.cacheReadTokens` で見る。2 step 目以降が 0 より大きければ、同じ prefix が cache から返っている。

```sh
jq -c 'select(.type == "assistant/message") | .usage.cacheReadTokens' ~/.jzh/sessions/<id>.jsonl
```

local daemon を止めて走らせると、リクエストは接続エラーになる。cloud への自動 fallback はない。cloud 直結にしたいときは、`jzh config set plugins.llm.localBaseUrl ''` で local route を切る。

## スキルを読ませる

```
.jzh/skills/<name>/SKILL.md   作業ディレクトリの中（ほかの作業ディレクトリへは効かない）
~/.jzh/skills/<name>/SKILL.md 自分のマシン全体
```

`SKILL.md` の先頭に frontmatter を置く。

```markdown
---
name: release
description: リリース手順を踏むときに読む
---

手順の本文。
```

`description` はセッション開始時にモデルへ配る一覧に載る。`name` と `description` の無いファイルは無視される。別のディレクトリを足す場合は設定ファイルに書く。

```sh
jzh config add skills ~/skills     # <name>/SKILL.md を持つディレクトリ
jzh config remove skills ~/skills  # 外す
jzh config                         # 入ったことを確かめる
```

同じディレクトリを二度足しても増えない。

`/release` のように名前だけを送ると、その skill を読んで会話にカードを出す。turn は始まらない。後ろに文章を付けたときだけ、その文章を入力に turn が始まる。

## 書き込みと実行の許可を変える

`preset` はコマンドを走らせる sandbox モードを決める。`read-only` は書き込み不可、`workspace-write` はコマンドの cwd と一時ディレクトリと `writableRoots` に書き込み可、`full` は封じ込めなしである。同梱 `base` profile の `safety` 行に、変えたいキーだけを重ねる。

```sh
jzh config set plugins.safety.preset full
jzh config                                             # 入ったことを確かめる
```

`plugins.safety.preset` は「id が `safety` の行の `preset`」の意味で、`sandbox` のような他のキーは同梱の値のまま残る。`full` は sandbox を外すので、コマンドは何も封じ込められずに走る。1回の実行だけ変えるなら `--patch` に渡すファイルで同じ行を書く。

```yaml
name: full
plugins:
  - id: safety
    name: '@jozo-harness/safety'
    config:
      preset: full
```

```sh
jzh --patch full.yml "…"
jzh --dump-config --patch full.yml   # 効いた行を確かめる
```

`sandbox` 自体を外す（`sandbox: none`）と、preset に関わらず封じ込めは無くなる。`auto` で使える backend が無い場合や、明示した backend（`seatbelt` / `bwrap`）がその platform で動かない場合は、無制限に落ちずに起動が失敗する。

## 拒否された呼び出しを1回だけ通す

sandbox が断った呼び出しの結果には、断ったモードと再試行の案内が付く。

```
bash: /etc/hosts: Operation not permitted
[exit code: 1]
[sandbox: file access denied under workspace-write mode]
[sandbox: escalation available — retry this exact command once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]
```

モデルは同じ呼び出しを `sandbox_permissions`（より広いモード）と `justification`（1文の理由）付きでやり直せる。端末 UI と Web UI はそこで y/n を尋ね、`y` のときだけその1回が広いモードで走る。拒否されれば呼び出しは拒否されたままで、`safety/approval/requested` と `answered` がセッションログに残る。`write` / `edit` も同じ引数を持ち、ワークスペースの外を指すパスで同じ往復になる。

`bash` の `session` は同じ名前の次の呼び出しにシェルを残し、ディレクトリと変数を持ち越す。残るのは起動したときのシェル・ディレクトリ・sandbox モードだけである。広いモードを承認したあとに同じ名前を指定しても、その広いモードでは走らない。シェル・ディレクトリ・モードのどれかが違う呼び出しはコマンドを走らせず `invalid-arguments` を返し、別の session 名を要する。

## worktree に移って続ける

モデルが `create_worktree` を呼ぶと、今の HEAD（か `base` で指名した commit）から新しい branch の worktree を作り、session の cwd とワークスペースの根をそこへ移す。以後の `bash` / `write` / `edit` はその中で走り、元の checkout は branch も commit も変えない。

- 置き場所の既定はリポジトリの兄弟 `../<repo>-<branch>`。`path` で変えられる。
- branch 名を省くと `worktree-<UTC timestamp>` になる。
- 部分 clone でも作成時に fetch しない（`GIT_NO_LAZY_FETCH=1`）。
- ワークスペースの外へ書くため、`workspace-write` では `sandbox_permissions: danger-full-access` と `justification` を付けた再試行で承認を求める。
- `working_directory` は新しい根の内側で動く。元の checkout へ戻る操作はまだ無い。

## MCP サーバを繋ぐ

行を足し、`command` に起動コマンドを配列で渡す。

```sh
jzh config add plugins @jozo-harness/mcp
jzh config set plugins.mcp.command '["npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp"]'
jzh config set plugins.mcp.prefix 'fs__'   # 省略すると mcp__
```

サーバの tool は `prefix` を頭に付けて登録される。行を消すときは `jzh config remove plugins mcp`。

## セッションログの置き場を変える

```yaml
name: sessions
plugins:
  - id: session-jsonl
    name: '@jozo-harness/session-jsonl'
    config:
      root: ~/work/jozo-harness-sessions
```

```sh
jzh --patch sessions.yml "…"
```

`root` を変えると、その run の `artifact` が書くページと `jzh web` が配信するページも、この root の隣の `artifacts/` に移る。既定の `~/.jzh/sessions` のときは `~/.jzh/artifacts/` になる。

## コマンドを sandbox の外で走らせる

`@jozo-harness/safety` の `sandbox` は既定で `auto` である。macOS では `seatbelt`（`sandbox-exec`）、Linux では `bwrap`（bubblewrap）が走る。コマンドは自分が走るディレクトリと一時ディレクトリにだけ書ける。それ以外の場所に書こうとすると macOS では `Operation not permitted`、Linux では `Read-only file system` になる。読み取りは制限せず、`/dev/null` への書き込みは許可する。

```yaml
  - id: safety
    name: '@jozo-harness/safety'
    config:
      preset: workspace-write
      sandbox: none          # 明示的に外すときだけ
      writableRoots:         # 足したいディレクトリ（既定は cwd と一時ディレクトリ）
        - ~/work/shared
```

`auto` で sandbox が使えないとき、または明示した backend がその platform で動かないときは、無制限に切り替えず起動が失敗する。Linux では `bwrap` の probe が通らない（未導入、user namespace を作れない）場合も起動が失敗する。

Ubuntu 23.10 以降は AppArmor が非特権の user namespace を拒むので、bubblewrap を入れただけでは probe が通らない。bwrap に user namespace を許す profile を置く（CI も同じ手順を踏む）。

```sh
sudo apt-get install -y bubblewrap
printf '%s\n' 'abi <abi/4.0>,' 'include <tunables/global>' \
  'profile bwrap /usr/bin/bwrap flags=(unconfined) {' '  userns,' '}' \
  | sudo tee /etc/apparmor.d/bwrap
sudo apparmor_parser -r /etc/apparmor.d/bwrap
bwrap --ro-bind / / --dev /dev --proc /proc --unshare-pid true && echo ok
```

## PowerShell でコマンドを走らせる

`bash` tool は `shell` 引数で PowerShell を選べる。既定は `bash` で、`shell: powershell` を渡すと `pwsh -NoProfile -Command <script>` として走る。sandbox は bash と同じで、`sandbox-exec` / `bwrap` の内側で `pwsh` が起動する。

`pwsh` が PATH に無い環境では、その呼び出しは理由を添えた `execution` の tool 失敗になる。turn は落ちないので、モデルは `shell: bash` でやり直せる。

## チームで分担させる

`ralph` は `--subagents` を要さず、tier1 行がある run で既定でモデルに渡る。objective と前 round の handoff だけを受け取る fresh な子を round ごとに起こすので、親の会話を長期記憶にしない反復に向く。通常の長い仕事は同じ session を続ける `goal` を使う。

`--subagents` を付けると、`subagent` / `workflow` / 子を操る 4 つ（`list_agents` / `send_message` / `interrupt_agent` / `wait_agent`）と `team` がモデルに渡る。モデルは `team` ツールで名前つきの子（teammate）と共有の板（board）を持てる。teammate は `subagent` と同じ子 agent で、仕事を渡すのは既存の `send_message`、待つのは `wait_agent` である。

```
team spawn name=builder role="writes the guide"
team create title="write the guide" owner=builder
send_message id=<roster に出た session id> message="write the guide"
team update id=task-1 state=done revision=1
```

`team list` が roster（子の状態つき）と板を出す。板の revision は更新のたびに増え、古い revision での update は拒否される。

子を 1 つだけ使うときは `subagent` で足りる。`model` で別の route（`provider/model`）を走らせられるが、その run が設定に置いている route に限る。候補はその run の既定 route と、`agent-loop` 行の `models` が値を持つモデル名（既定 route が provider を持つなら `<provider>/<model>` の形も）である。一覧に無い route は子を起こす前に `invalid-arguments` で拒否する。`context=fresh` で親の履歴を渡さず、`task` を省くと起こしたまま idle で残せる（あとから `send_message` で仕事を渡す）。

## モデルにプログラムを書かせて tool を束ねる（run_code）

tier1 行がある run では、モデルに `run_code` が渡る。モデルは既定で async 関数の本体を書き、`await tools.name(args)` で可視の tool を呼べる。`runtime: 'python'` を渡すと python3 のスクリプトとして走り、同じ tool を `tools.name(...)` で呼べる。大量の read / grep を 1 step に畳むときに使う。

実行は呼び出しごとの子プロセスで、bash と同じ sandbox の下で走る。中の tool 呼び出しも、直接呼んだときと同じ policy と承認を通る。戻るのは node なら `return` と `console.log`、python なら `print` だけで、途中の tool の結果は会話に入らない。python の呼び出しは同期で、1 本ずつ順に走る。

- 打ち切り: 30 秒（`RUN_CODE_TIMEOUT_MS`）と 16,000 文字（`RUN_CODE_OUTPUT_LIMIT`）。切ったときは結果に印が付く。
- 既定の子は JavaScript として走る。TypeScript の型注釈はまだ実行できない。
- python は run に python3 があるときだけ使える。無ければ `unavailable` になる。
- `run_code` 自身はプログラムからは呼べない（入れ子の再帰を防ぐ）。

## モデルにプラグイン行を直させる

モデルは `plugin` ツールで settings の `plugins` 行を list / add / remove / disable できる。1 回ごとに承認を求められ、効くのは**次の起動から**である（走っているプロセスの構成は変わらない）。足せるのは同梱のパッケージ名だけ。

```
plugin list                     この run が組まれた行
plugin add id=mcp name=@jozo-harness/mcp
plugin set id=mcp disabled=true
```

行が増えて tool が増えても、そのセッションはそのまま続けられる（新しい構成が記録される）。tool が減る変更や profile を変えるときだけ `--allow-preset-change` が要る（[構成を変えてセッションを再開する](#構成を変えてセッションを再開する)）。

## 構成を変えてセッションを再開する

セッションは、始めたときの profile 名と tool の一覧を覚えている。

- tool が増えただけなら、そのまま続く。増えた分は新しい構成として記録される。
- tool が減ったとき、profile が変わったときは、turn を始める前に拒否され、違う点が stderr に出る。

```sh
jzh --resume <sessionId> "続き"                          # 同じ構成なら続く
jzh --resume <sessionId> --allow-preset-change "続き"     # 減った tool や profile の変更を受け入れる（新しい構成を記録する）
```

## セッションに話しかけずに尋ねる（コマンド）

REPL・TUI・Web では、行頭が `/` の行はコマンドとしてその場で答える。モデルの turn は消費せず、`command/run` と `command/done` としてログに残る。

```
/help     使えるコマンドを並べる
/status   このセッションの居場所（モデル、cwd、turn 数、token 統計、goal、schedule）
```

`/status` の `stats` 行はセッションログから読める値だけを出す。tok/s は最後の turn の decode 区間、token は非キャッシュ入力・cache read / write・output・課金入力、cache は cache read ÷ 課金入力、context は runner が compaction に使うのと同じ budget に対する推定値の割合である。ログに無い値は `—` になり、0 と偽らない。

Web UI は同じ値を、Run ペインの Usage と composer の context の輪で見せる。Usage は context の棒（compaction の位置に印）、入力と出力、最後の turn の tok/s を 0〜500 の速度計で示す。500 を超えると輪は満ちきり、中央の数字がそのまま速さを示す。速度計の青い弧は、値が変わると 180ms で前の長さから次の長さへ伸び縮みする。compaction まで窓の 10% を切ると、棒と輪が金になる。輪を押すと Run ペインの Usage が開く。`prefers-reduced-motion: reduce` の環境では弧はその場で切り替わる。

知らない名前は登録済みの一覧を返す。コマンドの答えは TUI と Web では会話の notice として出る。

## 過去のセッションを探して読む

```sh
jzh sessions              # 新しい順に、id・開始時刻・作業ディレクトリ
jzh sessions <sessionId>  # そのセッションの会話を読む
```

続きから走らせるには `jzh --resume <sessionId>` を使う。一覧はセッションログの置き場（既定は `~/.jzh/sessions`）を見るので、置き場を変えているときは `--config` で同じ設定を指す。プロセスが止まる前に積まれ、まだ turn が取り込んでいなかった queued と steering は、開き直したセッションがそのまま走らせる。

## 設定が効かないときに見る

```sh
jzh config          # 設定ファイルのパス、4キーの今の値、リストの中身
jzh --dump-config   # 行、plugin ごとのキー、フラグ、環境変数
```

`jzh config` に値が出なければ、そのキーは読まれていない。綴りは [configuration.md](configuration.md) の表と突き合わせる。`profile:` が指せるのは同梱の `base` / `headless` / `repl` だけである。
