# Changelog

Every entry says what changed and, where it matters, what is still not true.
That is the same rule the README and the honesty test suite hold each other to
(`packages/daemon/test/claims-honesty.test.ts`): a release note that oversells
is a red build here, not a marketing choice.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.12.1] — 2026-09-10

### Fixed

- **The five bundled job templates never shipped inside the app.**
  `tools/stage-bundle.mjs` staged `resources/skill-pack` and not
  `resources/templates`, so `GET /templates/bundled` answered
  `{"templates":[]}` on a real install of 0.12.0 while 0.12.0's own notes said
  the five were reachable. The omission could not be seen from inside the
  repository: the daemon resolves those trees relative to its own compiled
  location, so a source checkout finds them and only the shipped app does not.
  The composer carries its own copy of the five, so they were always bookable —
  it was the claim that was wrong, not the button.
- **The published Homebrew tap served 0.11.0** while the current release was
  0.12.0, pinning a checksum that appeared in no current release — so
  `brew install --cask clockwork` fetched a build two releases old. The cause
  was never the automation's permissions, as 0.12.0's notes assumed: it was the
  wrong GitHub account being active locally. The tap now serves 0.12.1 with an
  `arm:`/`intel:` digest pair, and the nightly drift check agrees.

## [0.12.0] — 2026-09-10

### Fixed

- **Quiet hours deferred forever.** The deferral pre-claimed a `pending` ledger
  row at the resume instant, and `schedule_occurrences` is keyed
  `(schedule_id, occurrence_at)` — so the tick at that instant lost its own
  claim, returned before enqueueing, and the schedule stuck there and never
  fired again. A `once` schedule was worse: dropped outright rather than
  delayed. ADR-038 described this exact hazard as the reason *office hours*
  must not pre-claim; the reasoning was written for the branch built second and
  never carried back. ADR-030, which would have argued for the original
  mechanism, had never been written at all. Both branches now follow one rule.
- **A fresh install could not save its own retention window.** The free-tier cap
  was 30 days while the seeded default is 90, and free is the only tier any
  install runs at — so `PUT /retention` answered **402** for the value it had
  just handed you, and the setter could shorten retention and never restore it.
- **`/runs` sorted a booking for next week above everything that had happened.**
  Printed as history it read "your last run was next Tuesday". Wider than that
  symptom: every insert path writes a non-null `scheduled_for`, so two
  *finished* runs were ordered by when they were booked rather than by when
  they finished.
- **`CLOCKWORK_HOME` did not isolate worktrees or scratch.** Four sites resolved
  them from `$HOME` directly, so a second daemon — how tests, CI and
  side-by-side debugging run it — wrote into the primary install's tree.
- **The accent colour never met WCAG AA in light mode, on any surface** — 3.87:1
  on plain white, while carrying a comment claiming it had been darkened for
  exactly that. `--dim` had the same shape of error in both themes.
- **Two accessibility audits could not fail.** Both exited 0 unconditionally,
  and one was scoped to a CSS class the app had stopped using, so it "passed"
  by matching zero elements.
- **The live run tail existed and lost every line it was given.** `run.log` was
  broadcast, forwarded to SSE and rendered by `LiveTail` — but `App.tsx` bumps
  `dataVersion` on every SSE frame, which set `loading = true`, which returned
  the report pane's spinner, which unmounted the tail. Once per line, losing the
  line that caused it. The feature shipped, was documented as working, and had
  no test. Log frames now coalesce on a 100 ms trailing edge with a synchronous
  final flush before the terminal state, and `GET /runs/:id/events?since=` lets a
  tab opened mid-run catch up instead of starting blank.
- **A refused execute booking stranded its plan→execute pair.** Approving a plan
  commits the verdict first and books second; when the booking was refused the
  pair sat at `approved` with no run and nothing could re-book it. A second
  approval on that exact shape is now read as a retry of the booking, carrying
  the approved plan into the prompt. The verdict is not re-taken, and a pair
  nobody approved still refuses.
- **A hazardous recurrence saved before the guard existed could wedge the
  daemon.** `guardSchedule` has refused `FREQ=HOURLY;INTERVAL=2;BYHOUR=3` at task
  save for weeks, but the tick path is deliberately unguarded, so older rows
  still hung. A one-time sweep at startup disables each one, names the rule and
  the fix in an inbox item, and lets the daemon boot.
- **The calendar called a truncated answer complete.** `bookingsTotal` counted
  only what came back, so `truncated` read `false` on a cut list. It now reports
  a floor and says so.
- **The calendar's projection walk was unbounded.** `rule.between()` was called
  bare, so rrule materialised every occurrence and the limit trimmed only the
  result: `FREQ=MINUTELY` over a year is 525,601 dates and ~1 s, identical at
  `limit=62` and `limit=5000`. Bounded inside the iterator, the same probe takes
  10.9 ms.
- **The calendar read path had no schedule guard**, so a legacy hazardous row
  could hang it. Refused schedules are now counted and reported separately from
  truncated ones — a refusal is a missing job, not a short list.
- **A run report always claimed the Mac had not slept.** `sleptThroughKeepAwake`
  was a hardcoded `false`. It is now measured.
- **`(machine slept)` was inferred from `ranLateMs`**, which a queue, a repo
  mutex or a daemon restart all produce. Removed; it asserted a sleep with no
  evidence.

### Added

- **One-button first run.** Press *Run a sample job now* and Clockwork points
  the read-only Code Reviewer at a repository it already knows about, caps it at
  $0.50, starts it, and opens the live view. It cannot change anything: `plan`
  mode frozen into the job spec, a throwaway worktree, and a sandbox profile
  that mounts the repo read-only — three reasons, none of them a prompt.
- **A menu-bar item**, so a waiting approval is visible with the window shut.
- **A morning digest** in the Inbox when runs are unread, and next actions in
  the report — check out the branch, read the diff, open a PR, run it again,
  and the verdict inline.
- **Manual check-for-updates**, from the tray and from Settings. A click, never
  a timer. The four outcomes are stated and a failed check never reports "up to
  date". This closes the gap where a shipped security fix could not reach an
  installed user; there is still no automatic or signed update path.
- **Template export**, through the same security preview an imported file gets.
- **Five bookable job templates** — Monday dependency triage, flaky-test sweep,
  Friday docs-drift check, morning repo-health digest, pre-release changelog
  draft — offered as quick-fill cards in the composer. The first three match
  `dogfood/DOGFOOD.md` exactly, so the jobs we run on ourselves and the jobs we
  ship cannot disagree.
- **The tasks list reads like a schedule.** Grouped Recurring → One-off →
  Finished, with last outcome, next fire in words, and a cost trend. A repo-less
  task now says "no repo — scratch task" instead of the internal word `scratch`.
  Delete moved behind an overflow menu; Run now stays the primary action.
- **The report says when the Mac slept**, in words, with a duration.
  `sleptDuringRunMs` is absent rather than `false` when nobody could know — off
  macOS, or for a run recovered after a daemon restart. The report declines to
  answer instead of answering "no".
- **A Playwright smoke job in CI.** It books a task, watches it reach a terminal
  state, opens the report and drives the command palette, against a real served
  daemon with the mock engine. CI previously ran vitest and a `/health` curl.
- **A nightly Homebrew tap-drift check.** It compares the live tap's version and
  checksums against the release we actually published.
- **Four new honesty tripwires** — one macOS version floor across six files, no
  claim of a capability with no transport, no Known-limit the code already
  closed, and no OS claimed as supported without a green capability-matrix row
  and a CI job on that OS.

### Changed

- The calendar projects every enabled recurring job across the visible range as
  dashed ghosts, bounded per view (week 168, month grid 1,008, year capped at the
  5,000-row ceiling) and divided across schedules so one per-minute job cannot
  spend the whole budget.

### Known issues

- **Builds are still unsigned and un-notarized.** No Apple Developer certificate
  exists for this project.
- **The Settings *Check for updates* button needs an IPC grant to work at all.**
  The window loads the daemon's own origin, which Tauri treats as remote, so
  custom commands are ACL-rejected. A capability now grants exactly that one
  command to exactly that origin — no `core:default`, and `local` off. Nobody
  has clicked it in a GUI session; the capability and its resolved permission
  table are tested, the click is not.
- **Intel Macs.** GitHub retired the `macos-13` runner and every remaining x64
  image is a Larger Runner restricted to Team and Enterprise Cloud
  organisations, so the Intel DMG is cross-compiled from the arm64 runner.
