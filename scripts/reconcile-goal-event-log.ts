import { getDatabase } from "../src/lib/server/db/client";

type CountRow = { count: number };
type FirstEventRow = { created_at: string } | undefined;

function count(sql: string, params: string[] = []) {
  const row = getDatabase().prepare(sql).get(...params) as CountRow | undefined;
  return row?.count ?? 0;
}

const firstEvent = getDatabase()
  .prepare(`SELECT created_at FROM goal_event_log ORDER BY id ASC LIMIT 1`)
  .get() as FirstEventRow;

if (!firstEvent) {
  console.log("goal_event_log is empty; nothing to reconcile yet.");
  process.exit(0);
}

const queuedJobsWithoutCreatedEvent = count(`
  SELECT COUNT(*) AS count
  FROM runtime_jobs job
  WHERE job.task_instance_id IS NOT NULL
    AND job.created_at >= ?
    AND NOT EXISTS (
      SELECT 1
      FROM goal_event_log event
      WHERE event.instance_id = job.task_instance_id
        AND event.kind = 'instance.created'
    )
`, [firstEvent.created_at]);

const terminalJobsWithoutStatusEvent = count(`
  SELECT COUNT(*) AS count
  FROM runtime_jobs job
  WHERE job.task_instance_id IS NOT NULL
    AND job.created_at >= ?
    AND job.status IN ('completed', 'failed', 'cancelled', 'awaiting_user')
    AND NOT EXISTS (
      SELECT 1
      FROM goal_event_log event
      WHERE event.instance_id = job.task_instance_id
        AND event.kind = 'instance.status_changed'
    )
`, [firstEvent.created_at]);

const malformedEvents = count(`
  SELECT COUNT(*) AS count
  FROM goal_event_log
  WHERE goal_id IS NULL
    OR goal_id = ''
    OR kind IS NULL
    OR kind = ''
    OR payload_json IS NULL
    OR payload_json = ''
`);

const failures = [
  ["queuedJobsWithoutCreatedEvent", queuedJobsWithoutCreatedEvent],
  ["terminalJobsWithoutStatusEvent", terminalJobsWithoutStatusEvent],
  ["malformedEvents", malformedEvents],
] as const;

for (const [name, value] of failures) {
  console.log(`${name}: ${value}`);
}

const failed = failures.some(([, value]) => value > 0);
if (failed) {
  process.exitCode = 1;
}
