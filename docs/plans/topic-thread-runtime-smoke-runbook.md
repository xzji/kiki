# Topic / Thread Runtime Smoke Runbook

This runbook closes the manual boundary of `Topic_Thread_代码实现计划_v1.md` §13. It complements `pnpm test:planning` and must be run before merging the Topic / Thread runtime changes.

## 1. Automated Gate

Run from the repository root:

```bash
pnpm test:planning
pnpm exec tsc --noEmit
```

Required pass conditions:

- Planning specs pass, including schema, resume manager, thread loop, DevPanel data, route compatibility, and middleware compatibility specs.
- TypeScript completes without errors.
- No source grep hit for legacy deadline fallback literals under `src/`.
- No canonical Topic UI link points back to `/goals`.
- No `/api/goals/*` handler uses browser redirect semantics.

## 2. Fresh DB Smoke

Use an isolated data directory so the smoke does not mutate local production data:

```bash
export KIKI_DATA_DIR="$(mktemp -d /tmp/kiki-topic-thread-smoke.XXXXXX)"
echo "$KIKI_DATA_DIR"
pnpm dev
```

In a second terminal:

```bash
export KIKI_DATA_DIR="<same path printed above>"
pnpm daemon
```

Required pass conditions:

- App starts on a fresh DB without migration errors.
- Daemon logs `threadLoopDaemon: started`.
- Creating a Topic such as `持续跟踪 NVDA 投资机会` without deadline succeeds.
- Persisted Topic has no deadline field or has `deadline === null`.

## 3. DevPanel Smoke

Open the app and inspect `/dev/runtime`.

Required pass conditions:

- Topic init saga shows the five role timeline in order: `interviewer`, `planner`, `critic`, `refiner`, `presenter`.
- Thread tick runs show under the `thread` group as `thread_runner`.
- Existing task orchestration runs still show under the `task_orchestration` group.
- No role name collision appears across the three scopes: `topic_saga`, `thread`, `task_orchestration`.

## 4. Daemon Restart Smoke

Keep the isolated app running, then restart only the daemon:

```bash
pkill -f kiki-runtime-daemon || true
pnpm daemon
```

Required pass conditions:

- `awaiting_user` saga state remains stable across restart.
- Resuming an awaiting saga appends new agent events without duplicate sequence numbers.
- Active Threads continue ticking after restart.
- Paused Threads or Threads at the failure threshold do not tick again.

## 5. Failure Threshold Smoke

Use a test Topic with at least two active Threads. Force the ThreadRunner invoke path to fail for one Thread until the threshold is reached.

Required pass conditions:

- The failing Thread's `failureCount` increases monotonically to the threshold.
- The failing Thread changes to `paused`.
- Agent events end with `error` followed by `thread_paused`.
- Inbox shows exactly one warning alert for the paused Thread.
- Other active Threads continue ticking.

## 6. Production DB Copy Dry Run

Never run this against the live DB path directly. Create a consistent SQLite backup first. The app uses WAL mode, so copying only `kiki.db` can miss uncheckpointed rows from `kiki.db-wal`.

```bash
export PROD_DB="/path/to/prod/kiki.db"
export KIKI_DATA_DIR="$(mktemp -d /tmp/kiki-topic-thread-prod-copy.XXXXXX)"
sqlite3 "$PROD_DB" ".backup '$KIKI_DATA_DIR/kiki.db'"
pnpm daemon
```

If `sqlite3` is unavailable, stop the app and daemon first, then copy the full SQLite file set (`kiki.db`, `kiki.db-wal`, `kiki.db-shm`) into `KIKI_DATA_DIR`.

Stop the daemon with `Ctrl+C` after the startup log and migration checks complete.

Required pass conditions:

- v11/v12 migration completes on the copied DB without mutating the live DB.
- Bootstrap schema parity remains green.
- `runtime_jobs.goal_id` backfill leaves no row with `topic_id IS NULL AND goal_id IS NOT NULL`.
- Runtime state snapshots contain equivalent legacy `goals` and canonical `topics` envelopes during the compatibility window.

## 7. Rollback Readiness

Before enabling the changes outside dev:

- Confirm a DB backup exists with a timestamped filename.
- Confirm `USE_TOPIC_INIT_SAGA`, `USE_THREAD_LOOP_DAEMON`, `USE_DEV_RUNTIME_PANEL`, and `USE_LEGACY_GOAL_REDIRECT` can be toggled in the target environment.
- Confirm the rollback owner knows the §13.5 RTO targets and recovery command sequence.
