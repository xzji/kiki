import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";

const root = process.cwd();
const srcDir = path.join(root, "src");
const scriptsDir = path.join(root, "scripts");

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

const files = [srcDir, scriptsDir].flatMap((dir) => walk(dir)).filter((file) => /\.(ts|tsx)$/.test(file));
const contents = files.map((file) => ({ file, rel: relative(file), text: readFileSync(file, "utf8") }));
const checkedContents = contents.filter(({ rel }) => rel !== "scripts/verify-architecture.ts");
const productionContents = checkedContents.filter(({ rel }) => !rel.endsWith(".spec.ts"));

const RAW_GOALS_READ_INTERNAL_FILES = new Set<string>([
  // 合成层 / 投影内部实现：必须裸读，且不要求逐调用点标注。
  "src/lib/server/runtime/stateSnapshot.ts",
  "src/lib/server/runtime/instanceComposition.ts",
  // 投影写门面 / 仓储层：裸读用于 revision 或 raw 投影写前置，不作为业务执行态判断入口。
  "src/lib/server/services/goalRuntimeService.ts",
  "src/lib/server/services/goalCommandService.ts",
  "src/lib/server/repositories/topicsRepository.ts",
  "src/lib/server/repositories/threadsRepository.ts",
]);

function rawGoalsReadViolations(entry: { rel: string; text: string }) {
  if (RAW_GOALS_READ_INTERNAL_FILES.has(entry.rel)) return [];
  const lines = entry.text.split("\n");
  const violations: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/\breadGoalsSnapshot(Meta)?\s*\(/.test(lines[index] ?? "")) continue;
    const context = lines.slice(Math.max(0, index - 2), index + 1).join("\n");
    if (context.includes("allow-raw-goals-snapshot")) continue;
    violations.push(`${entry.rel}:${index + 1}`);
  }
  return violations;
}

fail(
  "禁止裸读 goals 投影做执行态判断（status/blocker 会滞后）。执行态请用 readComposedGoalsSnapshot* / composeGoalsWithRuntimeJobs；纯结构/写路径如确需裸读，请在调用点上方 2 行内写 allow-raw-goals-snapshot 注释并说明原因。",
  productionContents.flatMap(rawGoalsReadViolations),
);

fail(
  "CLI spawn 只能出现在 claude/transport.ts 或 runtime 适配器内",
  productionContents
    .filter(({ text }) => text.includes("spawn("))
    .map(({ rel }) => rel)
    .filter((rel) => rel !== "src/lib/server/claude/transport.ts")
    .filter((rel) => !rel.startsWith("src/lib/server/runtime/adapters/")),
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
  checkedContents
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
  checkedContents
    .filter(({ rel, text }) => rel === "src/components/providers/RuntimeEventBridge.tsx" && text.includes("materializeGoalSnapshot"))
    .map(({ rel }) => rel),
);

fail(
  "前端不允许直接调用 materializeGoalSnapshot，goal 创建/确认必须走命令 API",
  checkedContents
    .filter(({ text }) => text.includes("materializeGoalSnapshot("))
    .map(({ rel }) => rel)
    .filter((rel) => rel !== "src/lib/api/runtime-daemon.ts"),
);

fail(
  "前端组件不允许直接订阅 goalStore 用户命令 mutation",
  checkedContents
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
  checkedContents
    .filter(({ rel, text }) => rel === "src/lib/server/repositories/runtimeJobsRepository.ts" && text.includes('kind: "instance.status_changed"'))
    .map(({ rel }) => rel),
);

fail(
  "goalStore 不允许再把 canonical goals 持久化到 localStorage",
  checkedContents
    .filter(({ rel, text }) => rel === "src/stores/goalStore.ts" && /partialize:\s*\([^)]*state[^)]*\)\s*=>\s*\(\{[\s\S]*goals:\s*state\.goals/.test(text))
    .map(({ rel }) => rel),
);

fail(
  "RuntimeEventBridge 必须使用持久化 goal event cursor",
  checkedContents
    .filter(({ rel, text }) => rel === "src/components/providers/RuntimeEventBridge.tsx" && !text.includes("readGoalEventCursors"))
    .map(({ rel }) => rel),
);

fail(
  "demo-only chatStore 不应重新引入",
  checkedContents
    .filter(({ rel, text }) => rel === "src/stores/chatStore.ts" || text.includes("@/stores/chatStore"))
    .map(({ rel }) => rel),
);

if (!process.exitCode) {
  console.log("Architecture constraints passed.");
}
