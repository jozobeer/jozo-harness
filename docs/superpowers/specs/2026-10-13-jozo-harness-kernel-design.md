# jozo-harness 設計: 全体構成と S1 Kernel

jozo-harness は、自分が日常的に使う汎用コーディングエージェントのハーネスである。設計は [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（以下 dsh）の思想を移植し、Cordis の代わりに Effect を基盤にして、一人で全体を把握できる規模に保つ。

## 目的と前提

jozo-harness を dsh のプラグインとして作らず独自に作る理由は三つある。中身を隅々まで把握して自分の判断で育てられること、Cordis と dsh の規模に縛られない技術スタックを選べること、モデルとプロバイダを自由に選べること、である。

- 言語とランタイム: TypeScript と Bun。プロバイダ SDK や MCP SDK の層が厚く、dsh の実装と読み比べながら作れる。Rust は単一バイナリ配布で勝るが、プラグインの動的ロードに WASM か子プロセスが要る
- 実行基盤: Effect 4（`effect@4.0.3` を exact で固定する）。キャンセルの伝播、リソースの寿命、型付きの失敗、retry と timeout、schema を Effect に任せる
- 最初のモデル接続先: Ollama Cloud の OpenAI 互換 API（`https://ollama.com/v1`、`Authorization: Bearer $OLLAMA_API_KEY`）。Anthropic adapter は S1 の後に追加する
- 開発環境: macOS。sandbox backend は最終的に macOS・Linux・Windows に対応するが、v1 では macOS だけを実装する

未決の事項は dsh に準拠する。

## 全体の分割

v1 は、dsh の base bundle と同等のツールセットを日常のコーディングで評価できる状態を指す。v1 は S1 から S6 で構成し、各サブプロジェクトが独立に spec・計画・実装のサイクルを持つ。

| ID | 範囲 |
|---|---|
| S1 Kernel | プラグイン機構、session log、agent loop、LLM seam と OpenAI 互換 adapter、tool registry と実行 pipeline、system prompt の組み立て、最小の Headless CLI |
| S2 Safety | approval、sandbox seam と macOS Seatbelt provider、sandbox policy、permission preset、escalation |
| S3 Tier 0 | `read` / `write` / `edit` / `glob` / `grep` / `bash` |
| S4 Tier 1 | compaction、spill、tool call timeout、`todo_write`、AGENTS.md の読み込み |
| S5 Tier 2 | skill、web（search と fetch）、MCP、ask-user、plan-mode、`read_image` |
| S6 Tier 3 | subagent（fork / fresh / route 指名を含む）、jobs、goal、workflow（PTC）、team（roster と board）、schedule、コマンド、plugin、working-directory |
| S7 TUI | S1 のイベントを描画する端末 UI。行単位の REPL は S7 までの足場で、S7 で置き換える |
| S8 Web UI | S1 をローカルサーバー越しに操作するブラウザ UI |

依存は S2 以降から S1 への一方向である。S1 は、S2 から S6 の機能を agent loop の変更なしに載せられる拡張点を揃える。S7 と S8 は v1 の後に作る（2026-10-14 追記: どちらも実装済み。受け入れの記録は [S7/S8 受け入れ記録](../../notes/2026-10-14-s7-s8-acceptance.md)、その後の差の記録は [dsh のギャップ表](../../notes/2026-10-14-dsh-gap-backlog.md) にある。新しい提示は web を先に作り、TUI は同じ view を読んで追随する — [S7 の追記](2026-10-13-jozo-harness-tui-design.md) を参照）。

UI と核の間は、プロセス境界を越えられる形に保つ。核の公開面は直列化できるイベントストリームとコマンドに限り、UI に関数やクロージャを渡さない。こうすると S7 は同一プロセスで、S8 は WebSocket 越しに、同じプロトコルで核を使える。

## dsh から外すもの

| 外すもの | 理由 |
|---|---|
| Cordis | service の DI を `Layer`、登録の寿命を `Scope` で置き換え、waterfall などの hook だけを自作する（[カーネル](#カーネル)）。Cordis の部分集合を自作する案は、キャンセルと teardown の正しさを dsh と同じく規約と防御的なコードで守ることになるため退けた。イベントソーシングを核にする案は、承認待ちやストリーミングのような時間をまたぐ介入を純粋関数で書くのが不自然なため退けた |
| HMR と実行中の load / unload | 依存先が実行中に現れたり消えたりしないので、Layer は起動時に一度組み立てて終了時に一度閉じればよい。登録はすべて Scope に結びつくので、後から HMR を足すときは plugin ごとの Scope を作り直せばよい |
| Desktop、Python SDK、ACP | v1 の UI は CLI だけである。S7 と S8 の後で再検討する |
| 二言語ドキュメント | 個人の基盤には不要 |
| OpenTelemetry、credentials と authorization の各サービス | API キーは環境変数で足りる。**2026-10-14 追記（D5）**: 方針は変えない——credential サービスも OTLP も匿名 id も持たない（記録はセッションログが担い、キーは 1 行で足りる）。代わりに**優先順位を 1 か所に固定して見えるようにした**: 設定値はフラグ > `config.yaml` > 既定、資格情報はシェル > 近い `.env` > `secrets.env` で、解決は `apps/cli/src/settings.ts` が行い、`jzh --dump-config` が値と出どころを並べる。走行時の値と表示が同じ関数から出るので食い違わない |
| plugin-manager、typert | **2026-10-14 改訂**: 「Layer は起動時に一度組み立てる」方針はそのまま（HMR の行と同じ理由。実行中の mount / unmount はしない）。ただし dsh の plugin-manager に当たる「モデルが承認下で自分のプラグインを入れ替える」は、**宣言を編集する `plugin` ツール**として採る。モデルは settings の `plugins` 行を list / add / remove / disable でき、変更は 1 回ごとの承認を要し、**次の起動から**効く。すでに走っているプロセスの Layer は変えない（C6 の「セッションは始めた構成を覚える」とも整合する）。dsh の bundle install（npm から取ってきて build script を走らせる）は持たない: jozo-harness の plugin は同梱のパッケージで、行が指せるのはこの build が持っている名前だけである。typert は持たない |
| session format の世代 migration | **2026-10-14 改訂**: [dsh のギャップ表](../../notes/2026-10-14-dsh-gap-backlog.md)の D4 が「古いログを捨てずに読める」ことを求めるので、**読み手が寛容になり、世代の表を持つ**。header の `formatVersion` が現在以下なら表を通して現在の形に上げ、**現在より新しい**ものだけを拒否する（意味を知らないものは読めない）。表の最初の段は v0 = 「header が世代を言わない」で、`formatVersion: 1` を足し、`createdAt` はファイルの mtime（ディスクにある事実）で埋め、`cwd` は `'(not recorded)'` にする（書かれた場所を後から知る手立ては無く、ありそうな道をでっち上げると runtime context が嘘を繰り返す）。くわえて**切れた末尾の修復**を入れる: 最終行が途中で切れていたら、そこまでを読み、末尾を切り落として `session/repaired` を残す（圧縮・lease・export・全文検索は、この項目の受け入れ線の外にある別の能力なので持たない） |
| SurfaceOp / SurfaceIntent / `sourceEventSeqs`、`prepareCall` の capability フェーズ | dsh ではプロンプトキャッシュを保ったまま surface を差分更新するための仕組みである。**2026-10-19 追記**: Ollama Cloud の OpenAI 互換 API に明示的なキャッシュ制御が無いことは、暗黙の prefix cache が無いことを意味しない。local daemon は同じモデルを暗黙の prefix cache 付きで返す。この行の除外理由は「明示 API が無い」ことであり、「キャッシュ効果が無い」ことではない。効果は `cacheReadTokens` で測る。Anthropic adapter を足すときに必要性を再判断する。`request/header` に組み立て済みの tool schema と series を記録するのはこれに含めない（キャッシュ差分ではなく、送った内容をログから再構成するため。2026-10-14 追記） |
| `request/context` | **2026-10-19 追記**: 記録形式が不要である。送ったメッセージ列はイベント列から `deriveMessages` で再構成でき、同じ内容を二重に持つ必要が無い。キャッシュ効果の有無を理由にしない（明示 API が無くても暗黙 cache は効く）。 |
| `ToolDefinition.projectContent` | S1 から S3 のツールは `output.render` で足りる。`read_image`（S5）で必要になったときに足す |
| パッケージのファイルごとに 100% のカバレッジ gate | Bun の coverage がファイル単位の閾値を持つかは未確認である。主な証拠は replay snapshot と contract テストが担う。coverage report は出力する |

**2026-10-19 追記（監査の軸）**: 監査の軸と正規化の記録方法は [DSH パリティ監査の軸](../../notes/2026-10-19-parity-audit-axes.md) に固定した。除外理由は「明示 API が無い」と「暗黙の挙動が無い」を分けて書き、後者を確かめずに除外しない。cache は明示制御が無くても local daemon で効くので、その効果を除外の理由にしない。

**2026-10-14 追記（ギャップ表の「除外した基盤」）**: 除外は変えない。telemetry（OTLP）・identity（匿名 id）・credentials サービスは D5 の理由（記録はセッションログ、キーは環境変数 1 行）のままである。settings UI は持たない——設定は `jzh config`（ファイル編集）と `jzh --dump-config`（実効値と出どころ）で見え、モデルは `plugin` ツール（承認つき）で行を変えられる。画面で設定を編集する UI は「どの設定をどの順で見せるか」の判断を増やし、v1 の範囲を超える。見直すのは、設定項目が増えて「今どの値が効いているか」を CLI の 1 画面で追えなくなったときである。

## dsh にあって jozo-harness が持たないツール（2026-10-14 追記）

[dsh のギャップ表](../../notes/2026-10-14-dsh-gap-backlog.md)の B6 にあるツールを、S1〜S8 の範囲表と突き合わせた結果である。「採用」は jozo-harness の設計に載るので実装する、「除外」は jozo-harness の設計が意図的に持たない、「他所」は別の項目が引き受ける。

| dsh のツール | 判定 |
|---|---|
| `pwsh` | 除外。jozo-harness の sandbox は macOS Seatbelt（S2）で、対象は POSIX シェルだけである |
| `job_list` | 採用。S6 の jobs。`JobsShape.list` が既にあり、走っている背景仕事をモデルが見る手段が要る |
| subagent 制御（`send_message` / `interrupt_agent` / `list_agents` / `wait_agent`） | 採用。S6 の subagent。子に話しかけ、止め、終わるのを待つ |
| `subagent_fork` | 対応済み。S6 の範囲表の「fork を含む」は、`subagent` が `forkSeed` で親のログから子を起こすことで満たしている（証拠は `apps/cli/tests/subagent-fork-e2e.test.ts`）。**2026-10-14 改訂**: fork しない子も選べるようにした（`context: 'fresh'` で種を空にする）。あわせて `model` で子の route を呼び出しごとに指名でき、`task` を省くと子を起こして待たせる（idle のまま残し、`send_message` で続ける）。 |
| `list_subagent_models` | 除外。jozo-harness はモデルを起動時の `route` で選び、model registry を持たない。**2026-10-14 追記**: 子の route は呼び出しごとに `model` で指名できるが、列挙できる registry は無いのでこの道具は依然として持たない |
| `exit_plan_mode` | 採用。S5 の plan-mode。制限を解く出口をモデルに与える |
| `present` | 除外。カードを描く client を持たない v1 では、成果物はファイルのパスで示す。UI への提示は S7 / S8 と `presentCall` / `presentResult` の領分である。**2026-10-14 追記**: `presentCall` / `presentResult` は pipeline に実配線し、要約をログに記録するようにした（S1 の追記を参照）。`present` tool そのもの（client へカードを渡す経路）は持たないままである |
| `lsp` | 除外。言語サーバの管理はどの S の範囲にも無い |
| `workflow` | 採用（2026-10-14 改訂）。S6 の決定 4 を改訂し、データで書く扇状実行のツールとして持つ。dsh のスクリプト engine は持たない（[S6 の決定 4](2026-10-13-jozo-harness-tier3-design.md)） |
| MCP resources | 除外。S5 の MCP は「ツール一覧の取り込みと実行だけ」と決めている |
| session query 5 種 | 採用済み（2026-10-14）。`jzh sessions` の一覧・閲覧と `--search` が担い、索引は JSONL の隣に置く（D4） |
| schedule 4 種 | 採用済み。`schedule` ツール 1 つが create / list / update / delete を担う（C2） |
| `terminal` 6 種（PTY） | 除外。jozo-harness に端末セッションの概念は無く、`bash` と `job_*` がその役目を負う |
| `computer` / browser use | 除外。画面を操作する client を持たない |
| `plugin_manager` | 除外。上の表の「plugin-manager、typert」と同じ理由である |
| `str_replace_editor` | 対応済み。jozo-harness の `edit` が同じ操作で、名前だけが違う |
| `ralph` | **2026-10-18 改訂**: 採用。dsh 同様、round ごとに親の会話を seed しない子を起こす。既定の tier1 に登録し、通常の長い仕事は引き続き `goal`（C1）が担う |
| `create_worktree` | **2026-10-18 改訂**: 採用。新しい branch の worktree を作り、session の cwd とワークスペースの根をそこへ移す（issue #157）。削除・マージ・subagent ごとの自動分割は持たない |
| `team_*` | **2026-10-14 改訂**: 採用。[dsh のギャップ表](../../notes/2026-10-14-dsh-gap-backlog.md)の C8 が roster・task board・inbox を求めるので、名前つきの子（roster）と共有の task board を 1 つの `team` ツールで持つ。メッセージ（inbox）は既存の `send_message` / `list_agents` / `wait_agent` / `interrupt_agent` が担う。dsh の Lead / teammate の権限制御（team:policy）と compare-and-set の remote 面は持たない（jozo-harness は 1 親とその子だけで、board の revision はログから導出する） |

**2026-10-14 追記（ギャップ表の「除外したツールの方針変更」）**: 除外は変えない。再検討したのは 2 つで、どちらも v1 では持たない: `present` は提示層の判断（[S8 の追記](2026-10-13-jozo-harness-web-design.md)）と同じで、カードを描く client 契約を v1 は持たない。`terminal`（PTY）は `bash` と `job_*` が日常の用を足しており、端末セッションを持つと画面状態・再描画・入力の所有が増える。`lsp`・`computer` / browser・`pwsh`・MCP resources・`plugin_manager` は当初の理由のままである（`plugin_manager` の代わりは承認つきの `plugin` ツール）。

**2026-10-18 追記（Issue #157）**: `create_worktree` の除外を反転する。partial clone の repo で作成時の lazy fetch を止めるため、`git worktree add` には `GIT_NO_LAZY_FETCH=1` を渡す。作成はワークスペースの外へ書くので、`workspace-write` では既存の escalation（`sandbox_permissions` + `justification` と承認）を通す。移動は `session/cwd/changed` に `root` を足して表し、`working_directory` と以降の bash / write / edit は新しい根に従う。

**2026-10-18 追記（Issue #143）**: `ralph` の除外を反転する。tier1 行がある run の既定ツールとして登録し、round worker は `subagent` の fresh 起動経路（`seed: []`）を使う。worker が受け取るのは immutable な objective と前 round の構造化 handoff だけで、完了・blocker は worker の自己報告として返す。通常の長い仕事を同じ session で続ける `goal` の役割は変えない。

## S1 の設計

### リポジトリ構成

Bun workspaces の monorepo とし、UI を `apps/<app>/` に、それ以外のパッケージを `packages/<group>/<pkg>/` に置く。`packages/` は `apps/` に依存しない。パッケージ名は `@jozo-harness/<pkg>`、CLI 名は `jzh` である。

```
apps/
  cli                  Headless 一発実行と REPL（profile runner）
packages/
  kernel/kernel        Plugin 定義・hook registry・loader（YAML から Layer を組み立てる）
  core/session         SessionEventMap・append-only log・deriveMessages
  core/session-jsonl   JSONL 永続化 provider、observation と FTS5 の読み出し
  core/tools           tool registry と実行 pipeline
  core/system-prompt   prompt section と tool schema の組み立て
  core/agent           Agent interface・registry・agent/* イベント
  core/agent-loop      turn/step driver（プラグイン）
  core/scope           Agent 単位の Scope と、親の登録を継承して上書きする scoped registry
  llm/llm              StreamChunk・LlmFailure・adapter seam
  llm/llm-openai       OpenAI 互換 adapter
  bundle/base          既定の plugin 行（YAML）
  test-support/replay  録画 fixture の再生と、テスト専用ツール
```

### カーネル

カーネルは Effect の上に、plugin 定義、hook registry、loader だけを足す。service は `Context.Service` で定義し、実装を `Layer` として提供する。実行中の load と unload は持たない。

```ts
class Tools extends Context.Service<Tools, ToolRuntime>()("jozo-harness/Tools") {}
const ToolsLive = Layer.effect(Tools, Effect.gen(function* () {
  const sessions = yield* Sessions   // 依存は Layer の要求型に現れる
  // ...
}))

interface Plugin<C, P, R> {
  name: string
  config: Schema.Schema<C>
  provides: ReadonlyArray<Context.Key<P>>
  requires: ReadonlyArray<Context.Key<R>>
  layer: (config: C) => Layer.Layer<P, PluginError, R>
}
```

plugin は提供する service と要求する service を、`layer` の型と、`provides` / `requires` の実行時メタデータの両方で宣言する。YAML による組み立ては実行時に行われ、型情報が残らないので、loader は実行時メタデータで依存を解決する。`layer` の型引数と `provides` / `requires` の要素型が一致しない plugin はコンパイルできない。

**セッションは始めた構成を覚える（2026-10-14 追記）**: 起動時に「どの profile 文書から来たか（name）」と「登録された tool の一覧」を `preset/selected`（log-only）としてセッションに書く。これは制限（plan mode など）をかける**前**に取る。すでに記録があるセッションを再開するとき、tool が増えただけなら新しい構成を記録してそのまま続ける（既定の tool が増えても過去のセッションが開けなくならないように）。tool が消えた場合と profile が変わった場合は **turn を始める前に拒否**し、違う点を stderr に出す。人間が意図して変えるときは `--allow-preset-change` を渡し、そのときは新しい構成を記録し直す。dsh のように agent ごとに構成を mount し直す registry は持たない（jozo-harness の構成はプロセスの profile と patch が決めるので、記録と固定だけを行う）。

loader は dsh と同じ行形式 `{ id, name, config, disabled }` の YAML を、bundle、profile patch、home patch、`--patch` の順に id 単位で重ねる。次に `provides` と `requires` から依存をトポロジカルソートし、`Layer.provide` でつないだ一つの Layer を作る。循環や存在しない service があれば起動を失敗させる。Layer の構築が途中で失敗すると、構築済みの部分は Layer の Scope が逆順に解放する。`--dump-config` は最終的なツリーを表示する。

hook は dsh の Cordis イベントに相当し、Effect に対応する仕組みが無いので自作する。

```ts
// 宣言マージで拡張する。dispatch mode を hook の型に埋め込む
interface HookMap {
  'agent/pre-step': Waterfall<(input: PreStepInput) => Effect.Effect<PreStepDecision>>
  'agent/created':  Serial<(agent: Agent) => Effect.Effect<void, AgentInitError>>
  'session/event':  Emit<(ev: SessionEvent) => void>
}

hooks.on(name, listener, { prepend })  // Effect<void, never, Scope>。Scope が閉じると登録が外れる
hooks.emit / serial / parallel / bail / waterfall(name, ...args)
```

dispatch mode は emit、serial、parallel、bail、waterfall の五つで、意味は dsh の Cordis primer と同じである。waterfall の listener は `(...args, next)` を受け、`next()` を呼べば次へ委譲し、呼ばずに返せば short-circuit する。単一の決定を返す hook では short-circuit が正規の使い方である。dsh は mode を JSDoc の `@mode` で宣言し、gate で dispatch 箇所と照合する。jozo-harness は mode を `Waterfall<F>` などの型に埋め込み、mode と異なる dispatch 関数ではその hook を呼べないようにする。listener も Effect なので、呼び出し元の Fiber が interrupt されると listener の処理も interrupt される。

登録の寿命は `Scope` で管理する。plugin の登録はアプリケーションの Scope に、Agent に限定した登録はその Agent の子 Scope に結びつく。Agent の Scope を閉じると、その Agent の hook、tool、prompt section が外れる。

config、tool の引数と出力、session event のデコードは Effect Schema で書く。tool の JSON Schema は `Schema.toJsonSchemaDocument()`（draft 2020-12）で同じ定義から生成する。プロセス内の失敗は `Data.TaggedError` で表し、ログに残す失敗（`LlmFailure` など）は Schema で定義して encode してから書き込む。

Effect のモジュールは安定度が分かれている。`effect@4.0.3` の型定義の `@stability` では、`Effect`、`Layer`、`Scope`、`Context`、`Schedule`、`Fiber`、`PubSub`、`JsonSchema` が stable、`Stream` と `Schema` は大半が stable、`effect/ai`、`effect/process`、`effect/rpc`、`effect/cli` が unstable である。unstable なモジュールは jozo-harness の seam の内側でだけ使い（`effect/process` は subprocess provider の中、`effect/rpc` は S8 の transport の中）、minor の更新で壊れたときに直す場所を 1 パッケージに限る。`effect/ai` は使わない。その `LanguageModel` は unstable であるうえ、生の chunk と adapter 所有の replay 状態をログに残す [LLM seam](#llm-seam) の契約より高い抽象で、ログから request と response を再構成できることを jozo-harness が保証できなくなるからである。

デプロイによって変わる値は、plugin の config として YAML から変更できる形にする。`DEFAULT_*` 定数を plugin に埋め込まない。プロトコル定数とセキュリティ上の不変条件は固定する。

### Session log

session log は append-only で、model に渡す history はすべてログから導く。model に見える入力は必ずログに残り、ログに無いものは model に見えない。resume、fork、transcript、replay テストはこの不変条件に依存する。

```ts
type SessionEvent = { [K in keyof SessionEventMap]: {
  seq: SessionSeq; time: number; type: K; data: SessionEventMap[K]; ignorable?: true
} }[keyof SessionEventMap]
```

`type` による判別 union なので、`switch (ev.type)` で `ev.data` が cast なしに絞り込まれる。`SessionEventMap` は宣言マージで拡張する。

| イベント | 内容 |
|---|---|
| `session/header` | `formatVersion`、作成時刻、cwd。ログの最初の 1 件 |
| `turn/start` / `turn/end` | `turn/end.reason` は宣言マージで拡張できる `TurnEndReasonMap`（`completed`、`cancelled`、`error` など） |
| `step/start` / `step/end` | 1 回の model request と、その request が呼ぶ tool をまとめた単位 |
| `request/header` | provider、model、リクエストパラメータ、組み立て済みの tool schema、series 番号、書いた理由。route・パラメータ・tool schema がすべて前回と同じなら書かない（request series ごとに 1 件）。これで「ある request にどの tool schema が渡ったか」をログから復元できる（2026-10-14 追記） |
| `system/message` | system prompt。request series の先頭で 1 件 |
| `user/message` | `source` で、人の入力・`agent.inject()`・runtime context を区別する |
| `assistant/message` | 組み立てた content、usage、`replayState`、タイムスタンプ付きの生 stream |
| `assistant/attempt` | 失敗・retry・cancel した試行。history に入らない |
| `tool/call` / `tool/result` | `tool/call` は実行前に記録する。引数は生の JSON 文字列のまま。`tool/result` は `edit` / `write` が実行時に計算した `diffs`（前後の行と行番号）を optional に持ち、Changes ペインはこれを優先して描く。失敗した call は `error`（`name`・`code`・`reason?`）も持ち、timeout・denied・invalid-arguments を本文の文字列を読まずに区別できる。`diffs` と `error` は model history に入らない |

`approval/*`、`sandbox/mode`、`compaction/*`、`todo/write` などは、担当するプラグインが S2 以降で宣言マージによって追加する。

`assistant/message` と `assistant/attempt` に埋め込む stream は、dsh の compact assistant stream と同じく、同じ block の連続する delta を一つのレコードにまとめ、元のタイムスタンプを保つ。replay テストはこの stream を adapter の出力として再生するので、ストリーミング途中の chunk の分割まで再現される。

`deriveMessages(events, projections)` はイベント列を畳み込んで model history を作る純粋関数である。プラグインは message projection を登録できる。S4 の compaction は「`compaction/summary` より前の範囲を要約に置き換える」projection を登録する。live の Agent とファイルから読んだセッションは同じ projection 定義を使う。

永続化の seam は `SessionPersistence`（`create` / `open` / `stat` / `list`）で、S1 の provider は JSONL（`~/.jzh/sessions/<id>/session.v1.jsonl`、1 行 1 イベント）である。`append` は data が JSON に直列化できるかを検査し、できないイベントはログに入れない。flush は step と turn の終わりで行う。未知のイベント型は、`ignorable: true` が付いていない限り読み込みエラーにする。

### LLM seam

LLM seam の Definition は `llm/llm`（`ContentBlock`、`StreamChunk`、`LlmFailure`、`LlmAdapter`）、Provider は `llm/llm-openai`、Consumer は agent loop と S4 の compaction である。

`StreamChunk` は dsh と同じ閉じた union で、`block-start`、`text-delta`、`reasoning-delta`、`tool-call-delta`、`block-end`、`usage`、`finish` の 7 種である。switch は `assertNever` で閉じる。adapter の `stream(request)` は `Stream.Stream<StreamChunk, LlmFailure>` を返す。

adapter は次の契約を守る。

1. `usage` は `finish` より前に出し、`finish` の後には何も出さない
2. tool の引数は生の JSON 文字列のまま流す
3. 失敗は stream のエラーチャネルか `finish{kind:'error'}` のどちらかで返し、どちらも `LlmFailure` に正規化する
4. 1 回の adapter 呼び出しは provider への 1 回の試行とし、adapter の内部で retry しない。adapter は provider の SDK を使わず `HttpClient` で直接呼ぶ。内部で retry すると、失敗した試行が `assistant/attempt` に残らない
5. 応答の無い時間を transport で打ち切る（`streamIdleTimeoutMs`、config で変更でき、既定 5 分）。打ち切りは `TIMEOUT`、呼び出し元による interrupt は `ABORTED` として区別する
6. content の無い完了は `EMPTY_RESPONSE` として、retry できるエラーにする
7. コンテキスト長の超過は `CONTEXT_WINDOW_EXCEEDED` に正規化する。consumer は provider の文面ではなく `code` で分岐する

dsh に無い追加として、adapter は自分が対応する機能を静的に宣言する。

```ts
interface LlmCapabilities {
  toolChoice: boolean                        // Ollama Cloud: false
  reasoningEffort: readonly string[] | null
  images: 'base64' | 'none'
  promptCacheControl: boolean                // Anthropic: true
}
```

Ollama Cloud の OpenAI 互換 API は `tool_choice` を受け付けない。`toolChoice: false` の adapter では、ツールの強制や禁止をプロンプトと `tools/pre-execute` で担う。loop とプラグインは capabilities を見て振る舞いを分け、特定の provider の機能を前提にしない。

route は `provider/model` 形式の文字列（例: `ollama-cloud/qwen3-coder:480b`）で指定する。provider ごとの `baseURL`、API キーの環境変数名、capabilities、retry policy は bundle の YAML に置く。retry は `llm-retry` プラグインが `agent/request-error` waterfall で担い、`retryableCodes` と backoff（`Schedule` で表す）に従って `{ kind: 'retry' }` を返す。

### Tool registry と実行 pipeline

```ts
interface ToolDefinition<A, V> {
  name: string
  description: string
  parameters: Schema.Schema<A>
  output: { schema: Schema.Schema<V>; render(args: A, value: V): ContentBlock[] }
  execute(args: A, exec: ToolRunContext): Effect.Effect<V, ToolError>
  isConcurrencySafe?(args: A): boolean
  timeoutMs?: number
  finalizeContent?(exec: ToolExecution, result: ToolExecutionResult): ContentBlock[] | undefined
  presentCall?(args: A): ToolCallView
  presentResult?(args: A, result: ToolResultView): ToolResultView
}
```

`schemas()` は `name`、`description`、`parameters` だけを allowlist で取り出して model に渡す。tool 本体は正規の JSON 値を返し、`output.render` がそれを model 向けの content に変換する。S6 の workflow（PTC）は、コードから tool を呼んで構造化された値を受け取るので、この分離を前提にする。`presentCall` と `presentResult` は引数と結果だけに依存する純粋関数で、live 描画と replay で同じ結果を返す。キャンセルは `execute` の Fiber への interrupt として届くので、`ToolRunContext` は `AbortSignal` を持たない。tool が起動した子 Fiber と subprocess は、Scope によって interrupt と同時に後始末される。

1 回の tool call は次の順に処理する。

```
tool/call（ログ）
  → tools/pre-execute  waterfall   allow / deny / ask
      ask → approval service（S2）→ allowed-once 以外は deny
  → monotonic guards               deny か abstain だけを返す
  → tools/execute      waterfall   timeout・計測などの around 処理
      → execute() 本体
  → tools/post-execute waterfall   結果の置換・追加 context
  → finalizeContent
  → tools/result       emit        確定した結果の通知
tool/result（ログ）
```

waterfall は `prepend` で順序が変わるので、後から登録したプラグインが policy を迂回できる。どの組み合わせでも破られてはならない拒否（plan-mode での書き込み禁止など）は monotonic guard に置く。

**guard に何を置くか（2026-10-14 追記）**: 出荷構成に guard は 1 本も登録しない。plan-mode の禁止は restriction、承認は `agent/pre-step` の decision で足りており、いま veto が要る対象は無い。dsh の repeat-tool-reminder に当たる「同じ呼び出しの繰り返し」の検出も **advisory** にする（guard ではなく `agent/pre-step` で次リクエストにリマインダを注入する）。拒否にすると `job_output` の polling のような正当な繰り返しを壊すためで、dsh も同じ判断をしている。閾値は 3/5/8、同じ呼び出しの連続数も配布済みのリマインダ数もログから導出するので、状態を持たず、再開したセッションでも二重に注入しない。

pipeline の途中で起きた失敗と defect は `isError` の結果に正規化し、model にエラーとして返す。連続する `isConcurrencySafe` の call は並列に実行し、結果は call の順にログへ記録する。ToolRestriction は scope（Agent）ごとに継承したツールを絞り込むフィルタで、plan-mode（S5）と subagent（S6）が使う。

### Agent と agent loop

```ts
interface Agent {
  readonly id: SessionId
  readonly session: Session
  readonly options: AgentOptions   // route、model、reasoning effort など
  readonly inbox: Inbox            // nextTurn と nextStep の 2 キュー。永続化する
  readonly status: AgentStatus     // idle | running | cancelling | disposed
  readonly scope: Scope.Scope      // Agent に限定した登録の寿命。閉じると配下の登録が外れる
  followup(m: UserMessage): Effect.Effect<void>  // 次の turn に積む
  steer(m: UserMessage): Effect.Effect<void>     // 次の step 境界で取り込む
  inject(m: UserMessage): Effect.Effect<void>    // Agent を起こさず、次の request に同梱する
  cancel(cause: AgentCancelCause): Effect.Effect<void>
  whenIdle: Effect.Effect<void>
}
agents.create({ seed?, options, preset?, meta? })
```

`followup`、`steer`、`inject` は、UI からの入力、jobs の完了通知、AGENTS.md の追加読み込みにそれぞれ対応する。

1 turn は次の順に進む。

```
turn/start
  inbox から input を claim
  → agent/pre-step  waterfall  reject | enter(messages, startsRequestSeries?)
  step/start
  → system prompt と tool schema を組み立て、system/message と user/message を記録
  → agent/request   waterfall  route 切り替えなど request の最終調整
  → 必要なら request/header を記録し、deriveMessages() で history を確定
  → llm stream → agent/assistant-stream（emit、live 描画用）
    assistant/message か assistant/attempt を記録
    失敗時は agent/request-error waterfall。{ kind: 'retry' } なら再試行
  → tool/call* → 実行 pipeline → tool/result*
  step/end
  tool の結果を model に返す必要があるか steer が届いていれば、次の step へ
  → agent/turn-stopping  serial
turn/end
```

agent loop は次の不変条件を守る。

1. すべての `tool/call` に対応する `tool/result` を記録する。step が失敗またはキャンセルされたら、欠けた分を合成したエラー結果で埋める。埋める処理は `Effect.onExit` に置き、interrupt でも実行されるようにする。埋めないと、次の request で provider が応答の無い tool call を理由に要求を拒否する
2. `cancel(cause)` は turn の Fiber を interrupt する。原因は `AgentCancelCause`（`user`、`shutdown`、`parent-cancelled` など）で表し、`turn/end.reason` に記録する
3. retry は確定済みの request を再送し、prompt の組み立てと `agent/pre-step` をやり直さない
4. `agent/created` は serial で await してから最初の作業に入り、失敗したら初期化を巻き戻す

S6 はこれらの拡張点を使う。subagent は親が `agents.create()` で子を作り、子の `agent.scope` に結びつけて ToolRestriction を登録する。親が cancel されると、子の turn の Fiber も interrupt される。子の approval は親の answerer に委譲するか `never` に固定する。fork は `seed` に turn 境界までのイベント列を渡す。goal は `agent/turn-stopping` で継続を指示する。jobs は Agent の外の service とし、完了を `inject` で通知する。

### System prompt

```ts
interface PromptSection {
  name: string          // 重複登録は失敗する
  order: number         // 昇順に連結し、同順位は name の code-unit 順
  text: string | ((c: AssembleContext) => string)  // {{var}} は後段で補間する
  complete?: boolean    // この section だけで prompt 全体を置き換える
}
systemPrompt.section(s, { agent? })  // Effect<void, never, Scope>。agent を指定するとその Agent だけに効く
```

tool schema は、登録済みのツールのうち scope の ToolRestriction を通ったものから作る。

approval policy、sandbox mode、cwd、日付のように変わる事実は、system prompt に入れず、runtime context の snapshot として `user/message{ source: 'runtime-context' }` に記録する。値が変わったら、既存の history の後ろに新しい snapshot を足す。system prompt が変わらないので prefix が安定し、model が各時点で何を知っていたかがログから分かる。AGENTS.md（S4）、skill の一覧（S5）、plan-mode の指示（S5）は section か `inject` で入れ、agent loop を変更しない。

### エラー処理

失敗はそれぞれ担当が決まっており、担当が保証を持つ。

| 失敗 | 担当 | 保証 |
|---|---|---|
| plugin の config や依存の不備 | loader | 起動を失敗させ、構築済みの Layer を逆順に解放する |
| tool 本体と pipeline の失敗・defect | tool registry | `isError` の結果にして model に返し、loop は続ける |
| approval の answerer の不在・例外 | approval（S2） | `unavailable` を返す。呼び出し側は拒否する |
| sandbox backend の不在 | sandbox（S2） | `SANDBOX_UNAVAILABLE` で失敗する。制限なしでの実行に切り替えない |
| LLM の失敗 | adapter と agent loop | `LlmFailure` に正規化し、retry するか `turn/end{ reason: 'error' }` で閉じる |
| ログの append・永続化の失敗 | session | その Agent を止める |
| `session/event` の observer の例外 | session | 隔離して報告し、append の成否に影響させない |

ログの append に失敗した Agent を止めるのは、記録されない状態で作業を続けると、model に見えたものとログが食い違うからである。observer の例外を隔離するのは、observer がログの下流にあり、その失敗がログの正しさに影響しないからである。

**ログは読み手が寛容になる（2026-10-14 追記）**: `formatVersion` を完全一致で要求すると、形が 1 つ進んだだけで過去のログが開けなくなる。世代の表（`upgradeHeader`）を通して現在の形に上げ、現在より新しい世代だけを「この jozo-harness より新しい」として拒否する。壊れた（途中で切れた）末尾は、そこまでを読んで切り落とし、`session/repaired` としてログに残す——黙って捨てるのではなく、捨てた事実をログ自身に書く。

**sandbox は既定で効く（2026-10-14 追記）**: S2 の sandbox provider は当初 `sandbox ?? 'none'` で、同梱 profile もキーを書かなかったため既定は無制限だった。いまは `sandbox ?? 'seatbelt'` とし、`bundle/base` も `sandbox: seatbelt` を明示する。書き込めるのは**コマンドが走るディレクトリと一時ディレクトリ**、それに `writableRoots` の追加分だけである。プロファイルは `(allow default)` で読み取りを開き、`(deny file-write*)` で書き込みだけを閉じる。`/dev/null` への書き込みは明示的に許可する。読み取りを許可制にすると、ログインシェルが `~/.profile` を読めず、git が `/dev/null` を開けず、日常のコマンドが sandbox の拒否と昇格要求につながる。bash と background job は `bash -c`（非ログイン）で起動し、`~/.profile` を読む経路を持たない。ネットワークは開けたままにする: 呼び出しが外へ出てよいかを決めるのは `preset` と承認であり、sandbox の仕事はファイルシステムの封じ込めである。`seatbelt` が使えない platform では、無制限に落とさず loader を失敗させる（`PluginError{ code: 'unavailable' }`）。無制限は `sandbox: none` の明示的な選択になる。

**approval の不在をどう拒否にするか（2026-10-14 追記）**: 表の「不在・例外 → 拒否」は当初 `Approval.request` が実装しておらず、answerer が無いと `Deferred.await` で永久に待っていた（同梱 profile は `denyApproval` を配線していたので CLI では表面化しない）。いまは**待つことを opt-in** にした: 誰かが `listen()` して初めて `request` は待ち、それ以外は**その場で false を返す**。answerer の例外は bridge が `catchCause` で false に正規化し、呼び出しは拒否になる（開いたままにはならない）。承認は 1 call 幅で、記憶しない（`answer` は保留を消すだけ。dsh の「1 回限りの escalation」に当たる）。

失敗は Effect のエラーチャネルに `_tag` か `code` を持つ判別 union として流し、consumer は文面ではなく `_tag` か `code` で分岐する。想定外の例外（defect）は、担当の境界で上の表の保証に従って変換する。ユーザーへの報告は、起きたことと次に取る行動を一文ずつ書く。

### Headless CLI

```
jzh "task"                      一発実行（headless profile）
jozo-harness                             REPL（repl profile、TTY が必要）
jzh --profile <name> --patch <file.yml>... --dump-config
jzh --resume <sessionId>        ログから復元して続ける
jzh sessions                    ログの一覧（新しい順）
jzh sessions <sessionId>        1 つのログを会話として読む
jzh sessions --search <text>    全文索引でセッションを探す
jzh --json "task"               session/event を JSONL で stdout に出す
```

アプリケーションの起動経路は `jzh` の profile だけとし、テストと demo も同じ経路で起動する。

**1 行の要約は pipeline が描いてログに残す（2026-10-14 追記、E1）**: 当初 `presentCall` / `presentResult` は registry にあるだけで、走行経路は生の `arguments` と結果本文をログに書き、TUI と Web が 200 字で切って表示していた。いまは tool を呼んだその場所（runner）が要約をレンダリングし、`tool/call` / `tool/result` の `summary` として**イベントに記録する**。UI はログから同じ 1 行を読むだけなので、TUI・Web・replay が同じ見た目になり、古いログ（summary が無い）は view 側の既定（引数の 1 行・結果の 1 行を 200 字で切る）に落ちる。presenter を持たない tool も `@jozo-harness/tools` の既定（`callSummary` / `resultSummary`）で同じ形の 1 行を持つ。行の中身は tool が決める: bash は `bash <command>` / `exit 3`、read は `read <path>:10-40`、edit は `edit <path> lines: 2 → 3`、write は `write <path>`、glob / grep はパターン、web_fetch は URL。dsh の presenters・ノードレジストリ・locale 所有の文言は持たない（カードや差分の描画はクライアントの領分で、jozo-harness は 1 行に畳む）。

S1 が出荷する profile は `headless` と `repl` の二つで、どちらも `bundle/base` を第一層にする。CLI は `agent/assistant-stream` の chunk を stdout に流し、tool call を `presentCall` の 1 行要約で示す。S2 で approval が入ると、`repl` profile は TTY の y/n answerer を登録し、`headless` profile は answerer を登録しないので承認を要する操作が拒否される。全面的な許可は S2 の permission preset を `--permission danger-full-access` で明示して選ぶ。終了コードは completed が 0、error が 1、SIGINT が 130 である。SIGINT を受けたら `cancel({ kind: 'user' })` を呼び、`turn/end` を記録してから終了する。

### テスト

| 層 | 内容 |
|---|---|
| Unit（`bun test`） | 各パッケージの `tests/**`。すべての registry に、plugin を dispose すると登録が消えることを確かめるテストを書く。agent loop には contract-regression テストを置く |
| Replay snapshot | **2026-10-14 実装（E3）**: `packages/test-support/replay/src/scenario.ts` が 1 つの記録を「使い捨ての作業ディレクトリ + 記録された stream + 走らせる関数」として再生し、出てきたログと workspace を 1 つのテキストに正規化する（`time` / `timeN` / `dt` / `createdAt` は 0、uuid は `<uuid>`、一時パスは `<workspace>` / `<logs>` / `<tmp>` / `<tmpdir>`）。`apps/cli/tests/snapshot.test.ts` が**出荷構成のまま**（`bundle/base` の profile + 実物の registry・pipeline・JSONL。差し替えるのは Llm を記録にすることと session の置き場だけ）で走らせ、`apps/cli/tests/snapshots/<case>.txt` と行単位で比べる。差分は「recorded / replayed」の行として出る。記録を更新するのは `UPDATE_SNAPSHOTS=1 bun test snapshot` で、差分はレビューしてからコミットする。いまの case は tool call のある 1 ターンと、実記録 `ollama-cloud-tool-call.sse` の再生の 2 本 |
| Real-API e2e | `OLLAMA_API_KEY` が無ければ skip する。profile を起動してプロンプトを送り、書き込まれたファイルなど外部の状態を確かめる。agent 自身の出力の文言では判定しない |
| 録画 | `bun run snapshot:record` が API キーを使って fixture を作り直す。差分はレビューしてからコミットする。**2026-10-14 追記**: この script はまだ無い。実記録は `packages/llm/llm-openai/fixtures/` に手で置き、`bun run snapshot:record` を足すのは API キーで記録を更新する運用を始めるときにする |

mock は LLM の境界だけに置き、その下流は実物を使う。

## 未確認の事項

次の四点は Ollama Cloud のドキュメントに記載が無く、S1 の実装の初めに API キーで録画して確定する。録画は adapter の単体テストの fixture にする。

- reasoning の delta が `reasoning` と `reasoning_content` のどちらのフィールドで届くか
- 並列の tool call の delta がどう分割されて届くか
- `stream_options.include_usage` を指定したとき、usage がどの chunk に付くか
- `Schema.toJsonSchemaDocument()` が出力する draft 2020-12 の JSON Schema を、Ollama Cloud の tools パラメータがそのまま受け付けるか

`@effect/platform-bun` の安定度は、依存に加えるときに型定義の `@stability` で確かめる。

## S1 の完了条件

1. `jzh --profile headless "…"` が Ollama Cloud に対して、テスト専用ツール（`test-support` の `echo` と `fail`）の呼び出しを含む複数 step の turn を完了する
2. そのセッションを `--resume` で再開した 2 turn 目が、ログから再構成した history の上で動く
3. tool の例外、LLM の retry、SIGINT による cancel のそれぞれで、`tool/call` と `tool/result` が対になり、`turn/end.reason` が正しく記録される
4. 1 から 3 が replay snapshot として API キーなしで再生できる
5. [未確認の事項](#未確認の事項)の四点を録画で確定し、adapter のテストに反映する
6. `--dump-config` が最終的なツリーを表示し、存在しない service を `requires` に持つ行があると起動が失敗する
