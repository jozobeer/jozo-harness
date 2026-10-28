# jozo-harness の設定

plugin ごとの config キー、フラグ、環境変数の一覧は `jzh --dump-config` がコードから出力する。作業ごとの手順は [how-to.md](how-to.md) にある。

## 設定の層

行（plugin 1つぶんの設定）は4つの層を順に重ねる。同じ `id` の行は後ろの層が上書きし、`config` はキー単位でマージされる。

| 順 | 層 | 置き場 |
|---|---|---|
| 1 | 同梱の `base` profile | 常に読まれる |
| 2 | 選んだ profile | 同梱の `headless`（既定）または `repl` |
| 3 | 設定ファイルの `plugins` | `~/.config/jzh/config.yaml` |
| 4 | `--patch` | コマンドラインで渡すファイル（複数可） |

## 設定ファイル

既定のパスは `~/.config/jzh/config.yaml`。`--config` がパスを、`XDG_CONFIG_HOME` がディレクトリを差し替える。ファイルが無い場合、空の場合、コメントだけの場合はいずれも設定なしとして扱う。

| キー | 値 | 効果 |
|---|---|---|
| `model` | `provider/model` | 使うルート。`--model` > この値 > 行の `config.model`。ブラウザ UI の席の選択はこの run の中だけのもので、これから開くセッションもその route で始まる（設定ファイルには書かない） |
| `effort` | provider が読む語 | 推論の強さ。`--effort` > この値 > 行の `config.effort`。未設定なら provider の既定。ブラウザ UI の席は、セッションを開く前ならこの run で次に開くセッションの出発点を選び、開いた後ならそのセッションだけを切り替える（どちらも設定ファイルには書かない） |
| `profile` | profile 名 | 層2で重ねる profile。既定は `headless`。`--profile` > この値 |
| `port` | 0〜65535 の整数 | `jzh web` が listen するポート。`--port` > この値 > 0（空きポート）。`jzh web` 以外では使わない |
| `search` | `brave` / `deepseek` | `web_search` の provider。未設定は `BRAVE_API_KEY` があるときだけ brave。`deepseek` は `DEEPSEEK_API_KEY` を DeepSeek Search API に送る |
| `deepseekToolsBaseUrl` | URL | DeepSeek Search / Fetch API の base。既定は `https://api.deepseek.com/v1/tools`。provider は `/search` を足す |
| `skills` | 文字列の配列 | `<name>/SKILL.md` を持つディレクトリを追加する。```/x``` は展開する |
| `plugins` | 行の配列 | 層3として重なる |

`profile` が指せるのは同梱の `base` / `headless` / `repl` だけである。同梱に無い名前は `no bundled profile named <name>` で起動が止まる。

`skills` は追加の探索先である。`skill` tool は常に次の順で探し、同じ名前は先の根が勝つ。

| 順 | ディレクトリ |
|---|---|
| 1 | `<workspace>/.jzh/skills` |
| 2 | `skills` に書いた順 |
| 3 | `<jzh home>/skills`（既定 `~/.jzh/skills`） |
| 4 | jzh に同梱した skills（`docx` / `pptx` / `xlsx`） |

`SKILL.md` は YAML frontmatter に `name` と `description` を必ず持つ。欠けたファイルは一覧にも読込にも現れない。セッションの開始時に、見つかった skill の一覧がモデルへ届く。

`modelInvocable` と `userInvocable` は既定 `true` で、`false` と書くとモデルのカタログと `/` の候補のそれぞれから外れる。`true` / `false` として読めない値は無視して `true` に倒す。同梱 skills は探索の最後に置くので、同じ名前の自作 skill が勝つ。

探索先の直下にある symlink は、リンク先がディレクトリなら 1 段だけ辿る。壊れたリンクとファイルへのリンクは、`SKILL.md` を持たないディレクトリと同じく無視する。リンク先の中のディレクトリやリンクは辿らない。

## 行

行は profile と `--patch` の YAML に `plugins:` の配列として書く。持てるキーは4つ。

| キー | 必須 | 効果 |
|---|---|---|
| `id` | はい | 層をまたぐマージの単位 |
| `name` | はい | plugin 名 |
| `config` | いいえ | plugin が受け取る設定 |
| `disabled` | いいえ | `true` でその行を外す |

YAML では plugin 名を引用する（`name: '@jozo-harness/safety'`）。`@` で始まる値はプレーンな scalar として解釈できない。

## plugin が受け取る config キー

同梱の plugin のうち `config` にキーを持つのは9つで、残りはキーを持たない。

| plugin | キー |
|---|---|
| `@jozo-harness/session-jsonl` | `root`（必須）— セッションログのディレクトリ |
| `@jozo-harness/system-prompt` | `includeHarnessIdentity` — 冒頭の harness の自己紹介（`jzh:identity`）を出すか（既定 `true`）、`includeToolGuidance` — 見える tool の使い方の行を出すか（既定 `true`）、`tmuxContext` — runtime context に `tmux: session <name>, window <index>, pane <index>` を足すか（既定 `false`）。tmux の中にいるときだけ出し、外・tmux が無い・答えないときは行を出さない。セッション名・window index・pane index が変わったときだけ新しい snapshot になる、`devContext` — `jzh web` のセッションで、サーバが配信している GUI の URL を runtime context に `gui: <url>` として足すか（既定 `true`）。`--public-url` があればその origin、無ければ listen した loopback の URL を使う。URL は起動時に決まるので、同じ run なら同じバイト列になる。system prompt と既存の user メッセージの本文には入れず、別の user 文脈として届ける。`false` で行を出さない、`persona` — 配備ごとの文章。`before` は `jzh:identity` の前、`after` はその直後（tool guidance より前）に、identity とは別の section として入る。空文字・空白だけ・未設定の側は section を作らず、前後の空白は落とす。同じ設定なら同じバイト列になる |
| `@jozo-harness/safety` | `preset`（必須）— `read-only` / `workspace-write` / `full` / `auto`。コマンドと file tool が従う sandbox モードを決める（`auto` は `workspace-write` と同じ sandbox で、副作用のある呼び出しだけを実行前にモデルへ審査させる）、`sandbox` — `none` / `auto` / `seatbelt` / `bwrap`（**既定は `auto`**。macOS では `seatbelt`、Linux では `bwrap` を選ぶ）、`writableRoots` — sandbox が書き込めるディレクトリ（既定はコマンドの cwd と一時ディレクトリ。ここに足す） |
| `@jozo-harness/llm-openai` | `baseUrl`（必須）、`apiKeyEnv`（必須）— キーを持つ環境変数の名前、`localBaseUrl` — リクエストを送る local daemon の OpenAI 互換 URL。指定すると常にそこへ送り、daemon が動いている前提になる。空文字にすると local を使わず `baseUrl` に送る。`baseUrl` は `jzh models` のモデル一覧を読む先でもある。local 経由では route のモデル名を Ollama の cloud 名（`<model>:cloud`、タグ付きなら `<model>:<tag>-cloud`）に直して送る、`streamIdleTimeoutMs` — チャンク間の無応答を許す上限（ミリ秒、既定 300000。チャンクが届くたびに測り直す）、`headers` — 毎回のリクエストにそのまま付けるヘッダ（endpoint が client の user agent や routing 用の id を求めるときに使う。`Authorization` と `Content-Type` は adapter が決める）、`reasoningEfforts` — この endpoint が受ける effort の語（UI が選択肢に並べる。既定は `low` / `medium` / `high` / `xhigh` / `max`、空配列なら選択肢を出さない） |
| `@jozo-harness/agent-loop` | `models` — ルートのモデル名（`provider/model` の model 部分）をキーに、`contextWindow` と `maxTokens` をモデルごとに持つ（同じ行の単一値より優先する）、`contextWindow` — ルートしたモデルの context window（トークン）。`models` のそのモデルの値、この値、adapter の値、128000 の順に使う、`thresholdRatio` — 推定が窓のこの割合に達したら compaction する（既定 0.8）、`headroomTokens` — 発火点と窓の間に必ず空けるトークン（既定 65536）、`maxTokens` — 1 リクエストが答えのために予約するトークン。`models` にそのモデルの値があればそちらを使う。provider へ `max_tokens` として送り、発火点から先に引く（既定は無し＝予約しない）、`retainTokens` — 末尾で内容を置き換えない範囲を、推定トークンで表した目標（既定は窓の 16%。最新の 1 件は大きさによらず残る）、`maxBytes` — これを超える text block を、保持の外でスタブに置き換える（バイト、既定 32000）、`maxParallelToolCalls` — 並列に走らせる tool call の上限（既定 10。0 以下でも 1 件ずつ）、`title` — 最初の発話からセッション名をモデルに 1 回書かせる。キーを置くと有効で、無ければ最初の発話の切り詰めが名前になる。`enabled` — `false` で書かせない（既定は有効）、`model` — 名前を書く route（既定はセッションの route）、`maxChars` — 名前の長さ（既定 60）、`timeoutMs` — 応答を待つ上限（ミリ秒、既定 5000） |
| `@jozo-harness/mcp` | `command`（必須）、`prefix` |
| `@jozo-harness/delegate` | `tools`（必須）— 委譲してよい外部 CLI の配列。各要素は `name`（tool の `command` に渡す名前）と `argv`（起動する argv。タスクは最後の引数として足す） |
| `@jozo-harness/workspace-dependencies` | `dir`（必須）— この配布が同梱するランタイムの payload ディレクトリ（絶対パス、または `~` で始める）。`dir/runtime.json` が payload からの相対パスで `python`（必須）、`node`、`pnpm` を並べる |
| `@jozo-harness/tools-tier1` | `timeLimitMs` — `ask_user` が複数の質問を待つ既定の時間（ミリ秒、1 以上）。省略すると回答があるまで待つ。呼び出しの `time_limit_ms` が優先する |

`@jozo-harness/artifact` はキーを持たない。行を足すと、そのセッションのモデルに `artifact` tool が渡り、モデルは 1 枚の HTML ページを session root の隣の `artifacts/<sessionId>/<name>.html` に書ける。`deliverable: { path, title? }` を渡したときはページを書かず、cwd 内の既存ファイルを成果物として宣言して `deliverable: <path>` の 1 行を返す（cwd 外・不在・ディレクトリは `invalid-arguments`）。ページは `images` に渡した png / jpeg / webp / gif のパスを data URL に畳んだ 1 ファイルで（1 枚 2MB・合計 10MB まで）、`http://` / `https://` / `//` の外部サブリソースを参照する HTML は保存時に拒否する。preset が `read-only` の run では書かず、`denied` を返す。配信は jzh web の `/artifact/<sessionId>/<name>` が行う。同梱 profile に入れていないのは、ページを書かないセッションの tool 一覧を太らせないためである（既定では入らない）。

`@jozo-harness/lsp` もキーを持たない。行を足すと `lsp` tool が渡り、モデルは `action`（`definition` / `references` / `implementation` / `hover`）と 1 始まりの `line` / `column` でファイルの位置を聞ける。この版はまだ言語サーバを起動しないため、どの拡張子でも呼び出しは `unavailable` と「その拡張子の言語サーバがこの run に無い」を返す。既定で入れていないのは、`artifact` と同じく全セッションの tool 一覧を太らせないためである。

`@jozo-harness/computer-use` もキーを持たない。行を足すと `computer_click` / `computer_type` / `computer_key` の 3 tool が渡り、モデルはクリック（`x` / `y`）、文字入力（`text`）、キー送信（`key`。`return` や `cmd+s`）を頼める。操作は macOS の `osascript` から System Events に渡し、run の sandbox で wrap して走らせる。各呼び出しは実行前に `ask` で人間の承認を取り、拒否されたら子プロセスを起動せず `denied` を返す。Linux と Windows、`osascript` が PATH に無い macOS では `unavailable` を返す。結果の値には action、対象、終了コード、stderr の短い要約が入り、セッションログに残る。macOS ではアクセシビリティの許可が要る（`docs/how-to.md`）。既定の tool を増やさないため、同梱 profile には入れていない。

`@jozo-harness/screen-capture` もキーを持たない。行を足すと `screen_capture` tool が渡り、モデルは引数 `display`（任意。macOS の display 番号で 0 始まり。省略すると全 display を 1 枚に撮る）でいまの画面を png として撮れる。macOS は `screencapture -x -t png`（`display` を渡したときは `-D`）、Linux は `grim`、無ければ ImageMagick の `import -window root` を使う。撮影コマンドは run の sandbox で wrap して走らせ、一時ディレクトリに書いた png を読んだあとディレクトリごと消す。結果は base64 と image block で、`read_image` と同じ形でモデルに渡る。sandbox が拒否したとき、撮影プログラムが無いとき、画面収録の許可が無く画像が書かれなかったときは `unavailable` と理由を返す。既定の tool を増やさないため、同梱 profile には入れていない。

`@jozo-harness/browser` もキーを持たない。行を足すと `browser` / `browser_open` / `browser_snapshot` / `browser_click` / `browser_type` の 5 tool が渡る。`browser` は `url`（http(s) のみ）を 1 回読み、run の sandbox で `chrome --headless --dump-dom` を走らせて DOM の本文を返す。残る 4 tool はセッションが所有する headless chrome を共有する。`browser_open` は `url` を開いて可視テキストと操作可能な要素（CSS selector 付き）を返し、`browser_snapshot` は現在のページを同じ形で返す。`browser_click` は selector の要素を `element.click()` でクリックし、`browser_type` は selector の入力欄に `text` を value setter と `input` / `change` event で入れる。selector に合う要素が無いときは `execution` を返す。

セッション用ブラウザは最初の `browser_open` で 1 つだけ起動し、以降は使い回す。`--user-data-dir` はセッションごとの一時ディレクトリで、セッションが終わるとプロセスを kill してディレクトリも消す。人間がサイドバーで開くブラウザとはプロファイルもプロセスも別で、履歴は残らない。起動待ちは 10 秒、各 CDP 呼び出しは 10 秒、ページの読み込みは 15 秒で打ち切る。この起動は run の sandbox を通さない。Chrome 自身の sandbox と外側の seatbelt が二重になると macOS では起動できず、jzh 自身が別の sandbox の中にいる場合も同じである。Chrome が見つからないとき、起動に失敗したとき、CDP が応答しないときは `unavailable` と理由を返す。既定の tool を増やさないため、同梱 profile には入れていない。

`@jozo-harness/delegate` は `tools` を持つ。行を足すと `delegate` tool が渡り、モデルは `command`（設定の `tools[].name` のどれか）、`task`、任意の `cwd` で外部のエージェント CLI に仕事を渡せる。`task` と `cwd` は `subagent` と同じ意味で、`cwd` の既定は run の作業ディレクトリである。`subagent` の `model` / `context` / `preset` はプロセス内の子だけの引数なので、外部 CLI には渡さず、指定しても効かない。設定に無い名前は `invalid-arguments`、CLI が PATH に無いときは `unavailable` と探したコマンド名を返す。コマンドは run の sandbox で wrap して走らせ、timeout は 10 分、stdout は最大 100,000 文字、stderr は最大 10,000 文字で切る（超えた分は切り、`truncated` / `stderrTruncated` を立てる）。結果には終了コードと両方の stream が入り、セッションログから子の入出力を辿れる。終了コードが 0 でないとき、signal で死んだとき、起動できないとき、timeout したとき、sandbox が拒否したときは、その呼び出しだけが `unavailable`（timeout は `timeout`）になり、親の turn は続く。既定の tool を増やさないため、同梱 profile には入れていない。

`@jozo-harness/workspace-dependencies` は `dir` を持つ。行を足すと `workspace_dependencies` tool が渡り、モデルは payload の `runtime.json` が指す Python / Node / pnpm の絶対パスを受け取る。payload が持たないランタイムは `missing` に並ぶ。`runtime.json` が無い、JSON でない、`python` を欠く、指したファイルが無い・実行できない、payload の外を指す（symlink の解決先も含む）ときは `unavailable` と理由を返す。返すパスは payload の中だけなので、モデルはそのまま bash から起動できる。PATH も package manager の設定も変えない。既定の tool を増やさないため、同梱 profile には入れていない。

`@jozo-harness/session-search` もキーを持たない。行を足すと `session_search` / `session_trace` / `session_event_read` の 3 tool が渡る。`session_search` は `query`（と任意の `limit`、既定 10・最大 50）で過去セッションのログを全文検索し、セッション id と一致した抜粋を得る。検索は `jzh sessions --search` と同じ index を使う。`session_trace` は `sessionId`（と任意の `limit`、既定 20・最大 200）で直近のイベントを古い順に seq / type / 短い要約で返す。`session_event_read` は `sessionId` と `seq`（と任意の `before` / `after`、既定 3・最大 20）で、そのイベントと前後のイベントを本文つきで返す。3 tool とも、セッションの header が記録した cwd がこの run の cwd と一致するものだけを扱うので、別のワークスペースで走ったログは返らない。存在しないセッションや seq は `invalid-arguments` になる。既定の tool を増やさないため、同梱 profile には入れていない。

同梱の `base` profile は `root` に `~/.jzh/sessions`、`preset` に `workspace-write`、`baseUrl` に `https://ollama.com/v1`、`localBaseUrl` に `http://127.0.0.1:11434/v1`、`apiKeyEnv` に `OLLAMA_API_KEY` を置いている。`localBaseUrl` があるので送信は常に local daemon へ行き、`baseUrl` は `jzh models` の一覧取得に使う。`agent-loop` 行は既定ルート `deepseek-v4.1-flash` の窓を 1048576、出力予約を 393216 とし、発火点を 589824 にする。`models` のキーは route の model 名であり、local daemon へ送るときだけ付く `:cloud` は含めない。route に local daemon の名前（`deepseek-v4.1-flash:cloud`）を明示した場合のために、同じ値を持つキーも置いている。

発火点は `min(窓 × thresholdRatio, 窓 − maxTokens − headroomTokens)` である。既定ルートでは 1M の窓から 589824 になり、60k 程度のセッションは compaction しない。`--model` で別のモデルに変えたときは `models` のそのモデルの値を使い、名前が無ければ単一の `contextWindow` と `maxTokens` に落ちる。窓が分からないモデルでは 128000 を使う。

`preset` は sandbox モードを決める。モードはコマンドの書き込み範囲と、`write` / `edit` が触れる範囲の両方を決める。`read-only` は書き込み不可、`workspace-write` はコマンドの cwd と一時ディレクトリと `writableRoots` に書き込み可（`write` / `edit` は cwd の中だけ）、`full` は封じ込めなしである。`auto` は `workspace-write` と同じ sandbox で走り、境界は緩めない。その代わり、読み取り専用と宣言した tool（`read` / `glob` / `grep` / `read_image` / `web_search`）以外の呼び出しを、実行する前にモデルへ 1 往復させて可否を取る。拒否は `safety/auto/reviewed` としてセッションログに残り、呼び出しは `denied` になって実行されない。審査が答えない・失敗する・30 秒を超えるときも拒否する。答える者がいない実行で審査を飛ばして走らせるより、その step を止める方が安全だからである。`run_code` の中の入れ子呼び出しは外側の呼び出しで決めるので審査しない。`sandbox` の既定は `auto` で、macOS では `seatbelt`（`sandbox-exec`）、Linux では `bwrap`（bubblewrap）を選ぶ。`auto` で使える backend が無いとき、または明示した backend がその platform で動かないときは、黙って無制限にするのではなく起動が失敗する。Linux の `bwrap` は `bwrap --version` と最小実行の probe を通ったときだけ使う（未導入や、user namespace を作れない環境では起動しない）。macOS では起動時に一度だけ `sandbox-exec` へ最小の profile を適用する probe を走らせ、適用できない（入れ子の sandbox の中にいる）ときは stderr に 1 行出す。モードは変えないので、コマンドは拒否されたままである。Landlock の fallback は未実装である。`sandbox: none` は封じ込めを外す明示的な選択である。sandbox は読み取りを制限せず、書き込みだけを閉じる（`/dev/null` への書き込みは許可する）。

tool が宣言する能力（`exec` や `network`）では承認を求めない。境界を越えようとした呼び出しは sandbox が拒否し、結果に `[sandbox: file access denied under <mode> mode]` と、1回だけ許される再試行の案内が付く。`bash` / `write` / `edit` の `sandbox_permissions`（より広いモード）と `justification`（1文の理由）を付けて同じ呼び出しをやり直すと、人間に1回だけ確認が出る。拒否されれば呼び出しは拒否されたままで、その往復はセッションログに残る。答える者がいない実行は拒否される。

`@jozo-harness/mcp` の行は MCP サーバを起動し、その tool を `prefix`（既定 `mcp__`）を頭に付けて登録する。

### OpenCode Console に向ける

Console の chat completions は OpenAI 互換で、endpoint は `https://opencode.ai/inference/openai/v1` である。行の `baseUrl` と `apiKeyEnv` をそこへ向けると、その route で turn が走る。

```yaml
plugins:
  - id: llm
    name: '@jozo-harness/llm-openai'
    config:
      baseUrl: https://opencode.ai/inference/openai/v1
      apiKeyEnv: OPENCODE_API_KEY
      headers:
        User-Agent: jzh/1.0
```

route は `opencode/<model>`、wire に送る model は `<model>` そのものである。Console の chat completions 一覧にある id（`deepseek-v4.1-flash` など）をそのまま書く。GPT / Claude / Gemini の family は別の API を話すので、この adapter では扱えない。

キーは `OPENCODE_API_KEY` に置く。`jzh auth add` はまだ OpenCode を知らないため、シェル、`.env`、`secrets.env` のいずれかに置く。`headers` は静的な値なので、会話ごとに変える `x-opencode-session` はまだ組み立てられない。

`jzh models` は `baseUrl + /models` を読む。Console ではこれが 404 になり、一覧は `https://opencode.ai/inference/v1/models` にある。今は一覧を取れないので、モデル名は手で指定する。

無料 tier のモデルを OpenCode 本体以外から呼ぶと 403 の `FreeTierError` になる。adapter はこれを `AUTH` として扱い、provider の本文をメッセージに残す。OpenCode Go は client の user agent と会話ごとに安定した `x-opencode-session` を求める。`headers` で user agent は送れる。

## plugin の schema に無い行キー

次の4つは plugin の schema ではなく CLI が行から直接読む。`model`、`effort`、`maxSpillBytes` は複数の行に書いた場合に最初の行が勝ち、`planMode` は1つの行でも `true` なら効く。

| キー | 置ける行 | 効果 |
|---|---|---|
| `model` | どの行でも | `provider/model`。`--model` と設定ファイルの `model` が無いときにルートになる |
| `effort` | どの行でも | provider に渡す reasoning effort。`--effort` と設定ファイルの `effort` が無いときに効く |
| `maxSpillBytes` | どの行でも | tool の出力がこの大きさを超えたら、ファイルに退避して参照と要点だけをモデルに返す。退避先は jzh home の `spill/<sessionId>/`（0700、7日で掃除）、jzh home が無ければ一時ディレクトリ。`read` の結果は対象外で、注記のパスを `read` の offset/limit で読み直せる |
| `planMode` | `@jozo-harness/safety` の行 | `true` でワークスペースを変える tool を外す。モデルは `exit_plan_mode` で計画を出し、ユーザーが承認したときだけ解除される。解除は `plan/mode` としてログに残るので、`--resume` したセッションは解除済みで始まる |

## コマンドライン

| フラグ | 効果 |
|---|---|
| `--model <provider/model>` | ルートを決める |
| `--effort <level>` | provider に渡す reasoning effort を決める |
| `--profile <name>` | 層2の profile |
| `--patch <file.yml>` | 層4の行。複数回で複数ファイル |
| `--config <file.yml>` | 設定ファイルのパス |
| `--resume <sessionId>` | 過去のセッションを開く |
| `--allow-preset-change` | tool の減少や profile の変更があっても再開する（C6） |
| `--port <N>` | `jzh web` のポート。設定ファイルの `port` より優先する。0 は空きポート |
| `--public-url <https origin>` | `jzh web` を proxy 越しに公開する origin。許可する Host / Origin と起動メッセージの URL を決める。`jzh web` 以外ではエラー |
| `--json` | セッションイベントを JSON 行で出す |
| `--tui` | パイプ越しでも端末 UI を開く |
| `--dump-config` | 設定面を出力して終わる |
| `--help` | 使い方を出力して終わる |

サブコマンドは `models`（provider のモデル一覧）、`web`（ブラウザ UI）、`acp`（エディタ向けの ACP サーバ）、`sessions`（ログの一覧と 1 つの読み戻し）、`config`（設定の表示と書き込み）、`auth`（秘密の保存）である。それ以外の位置引数は1 turn のタスクになる。

`jzh config` は引数なしで今の設定を表示する。書き込みは次の通りで、いずれも書く前に schema で検証し、ファイルのコメントと他のキーは残す。

| 書き方 | 効果 |
|---|---|
| `jzh config set model <provider/model>` | `model` を書く。`effort` と `profile` も同じ形 |
| `jzh config set plugins.<id>.<key> <value>` | その行のキーを書く。同梱 profile の行を指すと差分の行を作る。`disabled` は行の項目として書く |
| `jzh config add skills <dir>` | `skills` にディレクトリを足す |
| `jzh config add plugins <name>` | 行を足す。`id` は名前から作り（`@jozo-harness/mcp` → `mcp`）、`--id` で決められる |
| `jzh config remove skills <dir>` | `skills` から外す |
| `jzh config remove plugins <id>` | 設定ファイルの行を外す。同梱 profile の行は外せない |
| `jzh config init` | 全キーをコメントで並べたファイルを作る |

値は YAML として読む。配列を書くときは flow 形式（`'["npx", "-y", "server"]'`）で1つの引数として渡す。

## 環境変数

| 変数 | 効果 |
|---|---|
| `OLLAMA_API_KEY` / `OPENAI_API_KEY` | provider のキー。名前は行の `apiKeyEnv` が決める |
| `OPENCODE_API_KEY` | OpenCode Console のキー。`apiKeyEnv` にこの名前を置く |
| `BRAVE_API_KEY` | あると既定の `web_search` provider が付く |
| `DEEPSEEK_API_KEY` | `search: deepseek` のとき `web_search` が DeepSeek Search API を呼ぶ。無い場合は tool error が `jzh auth add deepseek` を案内する |
| `XDG_CONFIG_HOME` | `config.yaml` と `secrets.env` を置くディレクトリ |

優先順位はシェル環境、作業ディレクトリに近い `.env`、`secrets.env` の順である。先に値がある場所が勝ち、後ろは空いているキーだけを埋める。どのファイルがそのキーを埋めたかは `jzh --dump-config` の `in effect for a run from here:` に出る。

設定値そのものの優先順位は、コマンドラインのフラグ、`config.yaml`、コマンドラインの既定（`--profile` 省略時の `headless` など）の順で、同じく `--dump-config` が値と出どころを並べる。解決は 1 か所（`apps/cli/src/settings.ts`）で行うので、走行時の値と表示が食い違わない。

## ファイルの置き場

| 何 | どこ | 変え方 |
|---|---|---|
| 設定 | `~/.config/jzh/config.yaml` | `--config`、`XDG_CONFIG_HOME` |
| 秘密 | `~/.config/jzh/secrets.env`（モード 600） | `jzh auth add` / `set` / `remove` / `list` |
| セッションログ | `~/.jzh/sessions/<id>/session.v1.jsonl` | `@jozo-harness/session-jsonl` 行の `root` |
| 添付ファイル | session root の隣の `attachments/<sha256>`（既定は `~/.jzh/attachments/...`） | `@jozo-harness/session-jsonl` 行の `root` を変えると一緒に移る。内容のハッシュが名前なので、同じ内容は 1 ファイル |
| 予定 | `~/.config/jzh/schedules.json` | `XDG_CONFIG_HOME`。キーは無い |
| 公開ページ | session root の隣の `artifacts/<sessionId>/<name>.html`（既定は `~/.jzh/artifacts/...`） | `@jozo-harness/artifact` 行を足す（キーは無い）。`session-jsonl` 行の `root` を変えると一緒に移る |
| Web UI | `127.0.0.1`。Tailscale を検出したときは tailnet IPv4 でも同じポートを listen する（`0.0.0.0` / `::` では受けない） | `--port`、設定ファイルの `port`。公開は `--public-url` |

公開ページはセッションのログの隣に置く。セッションを削除するとページも `artifacts/<id>/` ごと消える（#291 の時点では残った）。ページだけを消したいときは `artifacts/<id>/` から消す。

composer から添えたファイルもログの隣の `attachments/` に置く。保存名は本文の sha256 で、同じ内容は何度添っても同じ 1 ファイルを指す。1 メッセージ 8 件、画像 1 枚 10MB、テキスト 1 件 2MB、合計 20MB までで、テキストは先頭 32,000 文字をモデルに渡し、残りは保存域のパスと `read` の読み方を添える。対応しない種類、バイナリ、上限超えは保存せず、理由を返す。保存域を別に指定するキーは無く、`session-jsonl` 行の `root` に従う。

`jzh web` は同じディレクトリを `GET /artifacts/<sessionId>` でも読める。返すのは HTML ページの配列で、各要素は `name`（`.html` を除いた名前）、`path`（`/artifact/<sessionId>/<name>`）、`bytes`（ファイルの大きさ）、`updatedAt`（mtime の ISO 8601）を持つ。並びは `name` の昇順で、ディレクトリが無ければ `[]` になる。`GET` 以外は 405、`Origin` を載せた要求は許可した origin 以外なら 403、cookie か起動 URL の token / code が無ければ 401 になる。画面はまだこの経路を呼ばず、Run ペインの `pages` はログの `page:` 行から組み立てる。

## 設定できないもの

- provider の能力（tool の強制なし、画像なし、prompt cache 制御なし）は adapter に固定されている。reasoning effort は `effort` / `--effort` で指定でき、adapter は `reasoning_effort` としてそのまま渡す（endpoint がその語を受け付けるかは検証しない）
- Web UI の bind 先は `127.0.0.1` と、起動時に検出したこのマシンの tailnet IPv4 に限る（`0.0.0.0` / `::` では受けない）。tailnet の MagicDNS は listen ポート付きの `http://` で届く。ポート無しの https は `--public-url` と `tailscale serve` で公開する
- セッションログの形式は `session.v1.jsonl` に固定されている
- tool ごとの実行時間の上限は tool の定義側にある

## 読み込みの失敗

| 起きること | いつ | 結果 |
|---|---|---|
| 知らないキー | 設定ファイル、行の `config` | 無視される |
| どの層にも `model` が無い | 実行 | 起動が止まる（`no model is set`） |
| YAML が壊れている | 設定ファイル、profile、`--patch` | 起動が止まる（`settings are not valid YAML` など） |
| 知らない plugin 名 | 行の `name` | 起動が止まる（`unknown-plugin`） |
| 必須キーが無い | 行の `config` | 起動が止まる（`config`） |
| 1つの service を2つの行が提供する | 行の `provides` | 起動が止まる（`duplicate-provider`） |
| 依存が循環する | 行の `requires` | 起動が止まる（`dependency-cycle`） |

`--dump-config` は行を読み込んで検証しないので、未登録の plugin 名や必須キーの欠落は実行して初めて分かる。`jzh config set` は書き込む前に plugin の schema で値を検証するので、起動時に無視される行の `config` の知らないキーも、ここでは拒否される。