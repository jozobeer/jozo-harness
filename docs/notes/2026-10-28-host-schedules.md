# 予定をホスト全体に持つ（#348）

## 決めたこと

- 予定の保存域は `~/.config/jzh/schedules.json`（`XDG_CONFIG_HOME` で移る）にした。セッションのログは会話の記録であり、プロセスをまたいで時計が読むには置き場が違う。各予定は `sessionId` を持ち、届け先はそのセッションである。
- 時計は `jzh web` のサーバが 1 本だけ持つ。1 秒ごとに保存域を見て、期限が来た予定を `sessionId` のセッションに届ける。届けられない（セッションが閉じている）ときは `lastFiredAt` を書かずに残し、次にそのセッションが開いたときの tick で届ける。
- CLI の 1 回の run は、Web ではないので自分で時計を持つ（`hostClock`）。再開したセッションが、離れている間に来た予定を受け取る従来の挙動を残すためである。Web が開いている間はセッションごとの時計を止め、サーバの 1 本に任せる。
- 規則は `daily` / `weekly` / `cron` に IANA の `timeZone` を任意で持たせた。省略時はホストの帯。`Intl.DateTimeFormat` でその帯の壁時計を出し、壁時計から instant へ戻すときに複数の offset 候補を試す。春に消える時刻は飛ばし、秋に二度来る時刻は早い方を選ぶ。
- `at` はオフセット付き ISO 8601 だけを受ける。オフセットの無い時刻は帯が決まらないので拒否する。`after` は作成時刻から数える。どちらも一度きりで、過去の `at` は作成時に拒否する。
- 止めるは削除ではなく `paused`。再開すると `lastFiredAt` から続く。Web とモデルのツールは `scheduleRuleOf` / `scheduleTitleOf` / `scheduleViewOf` を共有する。
- 古いログの予定は、そのセッションを開いたとき・ツールが一覧したときに保存域へ引き継ぐ（`adoptLegacy`）。id はそのまま。ログの `schedule/created` などは消さない。

## 検証

- `vp test packages/core/tools-tier1/tests/schedule-time.test.ts` 18 passed（America/New_York の春・秋、Auckland の週次、無い帯）。
- `vp test packages/core/tools-tier1/tests/schedule.test.ts packages/core/tools-tier1/tests/schedule-store.test.ts packages/core/tools-tier1/tests/host-schedule-runs.test.ts packages/core/tools-tier1/tests/schedule-runs.test.ts` で保存・移行・時計・ツールを確認。
- `vp test apps/cli/tests/schedule-e2e.test.ts` 1 passed（再開時に期限切れの予定が届く）。
- `vp test apps/web/tests/server.test.ts -t "creates, stops, and removes a schedule"` 1 passed（Web から作成・停止・削除、来ない cron の拒否）。
- `pnpm run build:web` 成功。

## 残り

- 二つの `jzh web` を同じ保存域で同時に走らせると、最後に書いた方が勝つ。1 ホスト 1 サーバを前提にした。必要ならファイルロックを足す。
- Web の作成フォームは規則を 1 つずつ選ぶ最小の形で、weekly の曜日はカンマ区切りの入力である。
