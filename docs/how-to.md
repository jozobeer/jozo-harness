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

`jzh web` を開いただけではセッションは作られない。**最初のメッセージを送ったとき**（または `New session` を押したとき）に作られ、そのセッションが使うモデルと effort は、そのとき効いている設定（`--model` / `--effort` > 設定ファイル > 行）で決まる。

設定シートの `model` は「これから開くセッション」に効く。選んで `Use for new sessions` を押すと、そのあと開くセッションはそのモデルで始まり、同時に設定ファイルにも書かれるので次の run も同じモデルで始まる。すでに開いているセッションのモデルは、そのときには変わらない（下の「モデルを選ぶ」で変える）。

### モデルを選ぶ（走っているセッションと、これから開くセッション）

composer のモデルのチップを押すと、その endpoint が持つモデルの一覧が開く。選ぶと**そのセッションの route が変わり**、同時に**この run でこれから開くセッションもその route で始まる**。効くのは次のリクエストから（turn の途中なら次の step、待っていれば次の turn）。いま効いているモデルには印が付く。

セッションをまだ開いていなければ、チップは「いま始めるとしたら使う route」を出す。最初のメッセージを送る前（や `New session` の前）に選んでおけば、そのセッションはそのモデルで始まる。

一覧は provider の `GET /models` を叩くので、**チップを押したときだけ**読む。profile にモデル一覧を返す endpoint が無ければ、選ぶ代わりに理由がページに出る。返るのは `provider/model` の形で、provider は llm の行の `baseUrl` から決まる（知っている provider ならその route、知らなければ host 名）。

席の選択はこの run の中だけのもので、**設定ファイルには書かない**。次の run に持ち越す値は設定ファイルの `model` なので、`jzh config set model <provider/model>` か、設定シートの `Use for new sessions` で書く（その選択はこの run の選択でもあるので、設定シートの `model` の行は席の選択をそのまま映す）。

### 走っているセッションの effort を切り替える

ブラウザ UI（`jzh web`）の composer には、モデルの隣に effort の選択がある。選ぶとそのセッションの effort が変わり、効くのは**次のリクエスト**から（turn の途中なら次の step、待っていれば次の turn）。`default` は「provider に任せる」に戻す。選択肢に無い語が効いているとき（`--effort max` など）は、その語も選択肢に並ぶ。

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

切り替えはそのセッションが開いている間だけ効き、**これから開くセッションには持ち越さない**（新しいセッションは run の解決から始まる）。次の run に持ち越す値は設定ファイルの `effort` なので、`jzh config set effort <level>` で書く。

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

`sandbox` 自体を外す（`sandbox: none`）と、preset に関わらず封じ込めは無くなる。`seatbelt` が使えない platform で `seatbelt` を指定した場合は、無制限に落ちずに起動が失敗する。

## 拒否された呼び出しを1回だけ通す

sandbox が断った呼び出しの結果には、断ったモードと再試行の案内が付く。

```
bash: /etc/hosts: Operation not permitted
[exit code: 1]
[sandbox: file access denied under workspace-write mode]
[sandbox: escalation available — retry this exact command once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]
```

モデルは同じ呼び出しを `sandbox_permissions`（より広いモード）と `justification`（1文の理由）付きでやり直せる。端末 UI と Web UI はそこで y/n を尋ね、`y` のときだけその1回が広いモードで走る。拒否されれば呼び出しは拒否されたままで、`safety/approval/requested` と `answered` がセッションログに残る。`write` / `edit` も同じ引数を持ち、ワークスペースの外を指すパスで同じ往復になる。

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

## コマンドを sandbox の外で走らせる

`@jozo-harness/safety` の `sandbox` は既定で `seatbelt`（macOS の `sandbox-exec`）である。コマンドは自分が走るディレクトリと一時ディレクトリにだけ書ける。それ以外の場所に書こうとすると `Operation not permitted` になる。読み取りは制限せず、`/dev/null` への書き込みは許可する。

```yaml
  - id: safety
    name: '@jozo-harness/safety'
    config:
      preset: workspace-write
      sandbox: none          # 明示的に外すときだけ
      writableRoots:         # 足したいディレクトリ（既定は cwd と一時ディレクトリ）
        - ~/work/shared
```

`seatbelt` を指定した platform で sandbox が使えないときは、無制限に切り替えず起動が失敗する。

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

子を 1 つだけ使うときは `subagent` で足りる。`model` で別の route（`provider/model`）を走らせ、`context=fresh` で親の履歴を渡さず、`task` を省くと起こしたまま idle で残せる（あとから `send_message` で仕事を渡す）。

## モデルにプラグイン行を直させる

モデルは `plugin` ツールで settings の `plugins` 行を list / add / remove / disable できる。1 回ごとに承認を求められ、効くのは**次の起動から**である（走っているプロセスの構成は変わらない）。足せるのは同梱のパッケージ名だけ。

```
plugin list                     この run が組まれた行
plugin add id=mcp name=@jozo-harness/mcp
plugin set id=mcp disabled=true
```

行が増えると構成が変わるので、そのセッションを続けるには `--allow-preset-change` が要る（[構成を変えてセッションを再開する](#構成を変えてセッションを再開する)）。

## 構成を変えてセッションを再開する

セッションは、始めたときの profile 名と tool の一覧を覚えている。違う構成で再開すると、turn を始める前に拒否され、違う点が stderr に出る。

```sh
jzh --resume <sessionId> "続き"                          # 同じ構成なら続く
jzh --resume <sessionId> --allow-preset-change "続き"     # 意図して変える（新しい構成を記録する）
```

## セッションに話しかけずに尋ねる（コマンド）

REPL・TUI・Web では、行頭が `/` の行はコマンドとしてその場で答える。モデルの turn は消費せず、`command/run` と `command/done` としてログに残る。

```
/help     使えるコマンドを並べる
/status   このセッションの居場所（モデル、cwd、turn 数、goal、schedule）
```

知らない名前は登録済みの一覧を返す。コマンドの答えは TUI と Web では会話の notice として出る。

## 過去のセッションを探して読む

```sh
jzh sessions              # 新しい順に、id・開始時刻・作業ディレクトリ
jzh sessions <sessionId>  # そのセッションの会話を読む
```

続きから走らせるには `jzh --resume <sessionId>` を使う。一覧はセッションログの置き場（既定は `~/.jzh/sessions`）を見るので、置き場を変えているときは `--config` で同じ設定を指す。

## 設定が効かないときに見る

```sh
jzh config          # 設定ファイルのパス、4キーの今の値、リストの中身
jzh --dump-config   # 行、plugin ごとのキー、フラグ、環境変数
```

`jzh config` に値が出なければ、そのキーは読まれていない。綴りは [configuration.md](configuration.md) の表と突き合わせる。`profile:` が指せるのは同梱の `base` / `headless` / `repl` だけである。
