# jozo-harness 設計: S6 Tier 3

範囲は設計文書の分割表に従う: subagent（fork を含む）、jobs、goal、workflow（PTC）、working-directory。schedule は分割表に無いが、[dsh のギャップ表](../../notes/2026-10-14-dsh-gap-backlog.md)の C2 が求めるので、2026-10-14 にこの段へ足した。

## 前提（S1 から S5 までで使えるもの）

- ツールは ToolDefinition で宣言し、依存（sandbox や Ask など）は構築時に注入する。
- 子 agent は Agents.create で作れる。親子はセッションの並置で表す（subagent ツールで実装済み）。
- 承認と質問は session に残るイベント（safety/approval/*, interaction/ask/*）と Deferred で扱う。
- ログは JSONL。イベント型は SessionEventMap への宣言マージと registerSessionEventSchemas で足す。

## 決定

1. **working-directory はイベントで表す。** session/cwd の変更を session/cwd/changed として記録し、agent loop は「最後の変更、無ければ session/header」を現在の cwd として使う。ツール context の cwd もそれに従う。ツール側は working_directory ツール（needs: []）で、変更先がワークスペース外なら拒否する。
2. **jobs はセッションに紐づくプロセスの表。** 起動は bash の非同期版（needs: exec、承認は bash と同じ）。出力は退避と同じくファイルに書き、job_id で引く。プロセスは Scope に結びつけ、セッション終了で止める。
3. **goal は目標の記録で、継続ラウンドを持つ（2026-10-14 改訂）。** 当初は「自動再開は v1 では持たない」と決めていたが、[dsh のギャップ表](../../notes/2026-10-14-dsh-gap-backlog.md)の C1 が「目標がセッションをまたいで持続し、自動で次のラウンドが走る」を受け入れ条件にしているので、方針を変える。
   - 目標は session のイベント `goal/updated`（log-only）として残す。`currentGoal(events)` が最新の 1 件を畳むので、再開したセッションでも目標は生きている。ラウンド数はログの `user/message`（source = `goal-round`）の数から導出し、別の状態を持たない。上限は `maxGoalRounds`（既定 256）。
   - 自動再開は `startGoalRound(agent)` が担い、CLI が `agent/turn-stopping` に登録する。turn が閉じる**前に**次のラウンドの指示を `goal-round` 来源の user/message として `followup` するので、run が途中で idle になって終わることがない。上限に達していれば、システムの判断として blocked（round-limit）にする。ラウンドの判断は自分（`wire` された agent）の turn だけを見る。`goal-round` は `USER_MESSAGE_SOURCES` に足す。
   - モデルは `goal` ツールの action（create / edit / pause / resume / complete / blocked）で目標を動かす。blocked は理由を要求し、直近の user/message が `goal-round`（＝自動ラウンドの中）なら 3 ラウンド未満では拒否する。
4. **workflow はデータで書く扇状実行にする（2026-10-14 改訂）。** 当初は「同じ turn で複数のツールを並べるだけ」と決めていたが、[dsh のギャップ表](../../notes/2026-10-14-dsh-gap-backlog.md)の C3 が、子エージェントを扇状に走らせ・結果を検証し・失敗項目を null に落とす workflow を求めているので、ツールを 1 つ足す。
   - 入力はデータ（task の配列）にする。dsh のように JavaScript のオーケストレーションスクリプトを解釈する engine は持たない（jozo-harness には script を走らせる sandbox と interpreter が無く、その分のコストが v1 の規模を超える）。ループ・分岐・逐次依存は、モデルが workflow を何回か呼ぶことで表す。
   - 扇状実行そのものは S6 の並列ツール呼び出し（isConcurrencySafe）と同じ仕組みで行う。1 つの task が失敗してもその項目だけが null になり、他の task と run 全体は生き残る。
   - 結果の検証は「task が expect: json を宣言していれば JSON として読む」に留める。dsh は結果を schema で検証して分岐に使うが、その schema 言語は持たない。
   - **2026-10-14 追記（ギャップ表の「workflow の編成」）**: 前段の出力を後段に渡すパイプライン（dsh の `pipeline` hook）は要らない、と決める。理由は 3 つ。(1) その hook は dsh の JavaScript オーケストレーション engine の一部で、engine を持たない決定と一体である。(2) 段を跨ぐ依存は、モデルが workflow をもう一度呼ぶことで表せる。このとき後段の子は親のログから fork するので、前段の結果（親の `tool/result`）は子の履歴に最初から入っている——`forkSeed`（`jzh:packages/core/session/src/fork.ts`）が落とすのは最後の `user/message` だけである。値をもう一度書かせる必要はない。(3) 段ごとの往復は増えるが、そのコストは「同一タスクの A/B」（ギャップ表の 6 章）で測る対象であり、測る前に engine を足さない。往復が支配的だと数値が示したら、この決定を見直す。
   - **2026-10-18 追記（PTC / run_code、issue #155）**: モデルが書いたコードを harness が実行する点は方針の変更なので、ここに記録する。ただし変えるのは「tool 呼び出しを束ねるプログラム」だけで、子 agent を回すオーケストレーション engine を持たない決定はそのままである。tier1 の `run_code` が `await tools.name(args)` の呼び出しを JSON 行で親に返し、親は同じ registry の `call` に渡す。実行は呼び出しごとの子プロセスで、bash と同じ sandbox で wrap する。persistent-in-memory・Python・型宣言の描画は後続の issue に分ける。
    - **2026-10-28 追記（issue #346）**: 実行は呼び出しごとではなくセッションごとの子プロセスになった。プログラムが `globalThis`（python は名前空間）に置いた値を次の呼び出しが読め、セッションの scope が閉じると子ごと消える。時間切れの子は捨てる。コードは TypeScript として受け取り、`stripTypeScriptTypes` で型注釈を外してから走らせる。
5. **subagent の fork は、親の履歴を子に渡す形で表す。** 子のセッションを親のイベントから派生させて作り、cwd と route を引き継ぐ。**2026-10-14 改訂（[dsh のギャップ表](../../notes/2026-10-14-dsh-gap-backlog.md) C9）**: 引き継ぐのは既定であって唯一の形ではない。呼び出しは (a) `model` で子の route を `provider/model` として指名できる（形はツールが検査し、通らなければ子を起こす前に拒否する）、(b) `context: 'fresh'` で種を空にできる（親の履歴を渡さない）、(c) `task` を省くと子を起こして何も走らせない（idle のまま残り、`send_message` で仕事を渡せる）。route は Agent ごとの `options.route` に載り、runner がそれを `request/header` の provider / model にするので、子は自分の route で走る。
6. **schedule はログのイベントで表し、時計は 1 本の fiber が持つ（2026-10-14 追加）。** 予定は `schedule/created` / `schedule/updated` / `schedule/deleted` としてログに残し、`currentSchedules(events)` が最新の状態を畳む（goal と同じ方針）。期限到達は `schedule/fired` として記録し、発火の判定は「ルールから計算した次の時刻」と「最後に発火した時刻」の比較だけで行う。時計は起動時に一度だけ立てる scoped fiber が持ち、次の期限まで `Effect.sleep` して `followup` する。したがって予定はプロセスをまたいで生き、再開したセッションでも期限が来ていれば発火する。
   - 種別は every（秒）・daily（ローカル時刻）・weekly（曜日 + ローカル時刻）・cron（5 フィールド）。
   - 時間帯はプロセスのローカル 1 つだけを使う。dsh は予定ごとに IANA の zone を持つが、jozo-harness の v1 は持たない（差分として記録する）。

## 進め方

1 は S1 の拡張（イベント 1 種と loop の cwd 解決）で済むため最初にやる。次に 4（並列実行）、3（goal）、2（jobs）、最後に 5（fork）。

## fork の種をどこで入れるか（2026-10-13 の調査）

- makeAgent は「すでに組み立てられた Session」を受け取る（packages/core/agent/src/agent.ts の MakeAgentOptions）。Session には sink が無い（sink は OpenedSession 側の内部）。
- したがって種を入れる場所は Sessions.create の側。案: Sessions.create({ cwd, seed }) とし、persistence.create で得た OpenedSession の sink に、session/header 以外の種のイベントを順に append してから Session を組み立てる。
- subagent ツールは forkSeed(親の session.events()) を create に渡す。親の最後の user/message は forkSeed が落とすので、子には自分のタスクだけが残る。

7. **team は名前つきの子と task board（2026-10-14 追加）。** `team` ツールが roster（name / role / sessionId）と board（id / title / state / owner / revision）を持ち、どちらも session のイベント（`team/spawned` / `team/task/created` / `team/task/updated`）としてログに残る。revision はタスクの更新回数から導出し、update は最新 revision を渡されたときだけ通す（compare-and-set）。inbox は新しいものを作らず、既存の `send_message`（idle なら次の turn、実行中なら次の step）が担う。子は subagent と同じく親のログから fork して起きる。

## 実装の記録

- subagent: packages/core/tools-tier1/src/subagent.ts（makeSubagentTool(agents, route)）。CLI は subagents: true のとき登録する。引数は task / cwd / model / context（2026-10-14 に model と context を足した）。
