import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";

const root = process.cwd();
const srcDir = path.join(root, "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = path.join(dir, entry);
    if (entry === "node_modules" || entry === ".next") return [];
    if (statSync(fullPath).isDirectory()) return walk(fullPath);
    return fullPath;
  });
}

function relative(filePath: string) {
  return path.relative(root, filePath).replaceAll(path.sep, "/");
}

function fail(message: string, matches: string[]) {
  if (matches.length === 0) return;
  console.error(message);
  matches.forEach((match) => console.error(`- ${match}`));
  process.exitCode = 1;
}

const files = walk(srcDir).filter((file) => /\.(ts|tsx)$/.test(file));
const contents = files.map((file) => ({ file, rel: relative(file), text: readFileSync(file, "utf8") }));
const productionContents = contents.filter(({ rel }) => !rel.endsWith(".spec.ts"));

fail(
  "Claude CLI spawn 只能出现在 claude/transport.ts",
  productionContents
    .filter(({ text }) => text.includes("spawn("))
    .map(({ rel }) => rel)
    .filter((rel) => rel !== "src/lib/server/claude/transport.ts"),
);

fail(
  "upsertGoalsSnapshot 只能通过 goalRuntimeService 门面调用",
  productionContents
    .filter(({ text }) => text.includes("upsertGoalsSnapshot("))
    .map(({ rel }) => rel)
    .filter((rel) => rel !== "src/lib/server/runtime/stateSnapshot.ts" && rel !== "src/lib/server/services/goalRuntimeService.ts"),
);

fail(
  "runtime job internal 写入口只能在 goalRuntimeService 或 repository 内部使用",
  contents
    .filter(({ text }) => text.includes("createQueuedRuntimeJobInternal(") || text.includes("updateRuntimeJobExecutionInternal("))
    .map(({ rel }) => rel)
    .filter(
      (rel) =>
        rel !== "src/lib/server/services/goalRuntimeService.ts" &&
        rel !== "src/lib/server/repositories/runtimeJobsRepository.ts",
    ),
);

fail(
  "RuntimeEventBridge 不允许再自动 materialize goal snapshot",
  contents
    .filter(({ rel, text }) => rel === "src/components/providers/RuntimeEventBridge.tsx" && text.includes("materializeGoalSnapshot"))
    .map(({ rel }) => rel),
);

fail(
  "前端不允许直接调用 materializeGoalSnapshot，goal 创建/确认必须走命令 API",
  contents
    .filter(({ text }) => text.includes("materializeGoalSnapshot("))
    .map(({ rel }) => rel)
    .filter((rel) => rel !== "src/lib/api/runtime-daemon.ts"),
);

fail(
  "前端组件不允许直接订阅 goalStore 用户命令 mutation",
  contents
    .filter(({ rel }) => rel.startsWith("src/components/") || rel.startsWith("src/app/"))
    .filter(({ text }) =>
      /useGoalStore\(\(state\) => state\.(updateTask|deleteTask|addTask|addSubGoal|confirmGoalPlan|requestGoalPlanRevision|syncTaskInstanceRun|completeTaskInstance|resolveTaskInstanceAwaitingUser|deleteGoalsByConversationId|generateInstance)/.test(
        text,
      ),
    )
    .map(({ rel }) => rel),
);

fail(
  "runtime job 状态事件不应继续写 instance.status_changed",
  contents
    .filter(({ rel, text }) => rel === "src/lib/server/repositories/runtimeJobsRepository.ts" && text.includes('kind: "instance.status_changed"'))
    .map(({ rel }) => rel),
);

fail(
  "goalStore 不允许再把 canonical goals 持久化到 localStorage",
  contents
    .filter(({ rel, text }) => rel === "src/stores/goalStore.ts" && /partialize:\s*\([^)]*state[^)]*\)\s*=>\s*\(\{[\s\S]*goals:\s*state\.goals/.test(text))
    .map(({ rel }) => rel),
);

fail(
  "RuntimeEventBridge 必须使用持久化 goal event cursor",
  contents
    .filter(({ rel, text }) => rel === "src/components/providers/RuntimeEventBridge.tsx" && !text.includes("readGoalEventCursors"))
    .map(({ rel }) => rel),
);

fail(
  "demo-only chatStore 不应重新引入",
  contents
    .filter(({ rel, text }) => rel === "src/stores/chatStore.ts" || text.includes("@/stores/chatStore"))
    .map(({ rel }) => rel),
);

if (!process.exitCode) {
  console.log("Architecture constraints passed.");
}
