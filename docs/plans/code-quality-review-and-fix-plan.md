# 当前项目代码质量审查与修复方案

## 背景

本次检查范围覆盖当前项目的核心执行链路、服务端 runtime/worker、Claude CLI 桥接、客户端状态同步、任务 runner 与持久化层。项目当前可以通过 `pnpm lint` 与 `pnpm build`，主要问题集中在运行时稳定性、状态一致性和模块职责边界。

## 问题清单

| 优先级 | 问题 | 影响 | 证据 | 修复方案 |
| --- | --- | --- | --- | --- |
| P0 | `streamClaudeCli` 的 `onEvent` 回调可以在异步子进程事件中抛错逃逸 | 调用方在 `onEvent` 中抛错时，可能形成未捕获异常，导致 worker 或 API stream 异常退出，且无法统一落入调用方 `try/catch` | `src/lib/server/claudeCli.ts` 直接调用 `options.onEvent`；`src/lib/server/goalTaskRunner.ts` 的调用方在 error event 中 `throw` | 在 `streamClaudeCli` 内封装安全事件分发，捕获回调异常并 reject 当前 Promise，同时终止子进程，避免吞错或进程级逃逸 |
| P0 | Worker lease 续租失败后任务仍继续执行并写回 | lease 过期或被其他 owner 接管后，旧 worker 仍可能完成任务并覆盖新 owner 的状态，造成重复执行和结果竞态 | `src/lib/server/worker/taskDispatchWorker.ts` 续租失败只写日志；完成写回没有校验 lease owner | 增加 `AbortController`，续租失败立刻中断当前任务；完成/失败写回时使用 lease owner fencing，只有当前 owner 仍持有 lease 才允许写回终态 |
| P1 | runtime state 在客户端和服务端之间整包双向覆盖 | 多标签页、旧客户端、worker 回写和本地 store 更新之间缺少版本冲突检测，容易覆盖较新的执行结果 | `RuntimeStateBridge` 直接 `replaceGoals` 并整包 POST；`/api/runtime/state/sync` 直接 upsert 整包 snapshot | 为 snapshot 增加 revision/updatedAt 元信息；客户端同步携带 `baseRevision`，服务端拒绝过期写入；客户端检测远端新 revision 后再替换 |
| P1 | `/api/runtime/state/sync` 缺少运行期结构校验 | TypeScript 类型断言不能防止畸形 JSON 写入 SQLite，损坏后续读取和 UI 展示 | `src/app/api/runtime/state/sync/route.ts` 直接信任 request body | 增加轻量数组结构校验，非法 payload 返回 400，避免写入明显错误数据 |
| P2 | 通用任务 runner 中硬编码旅行/航班/酒店/预算规则 | 通用执行器被领域策略污染，扩展其他领域时会继续堆叠正则和候选项 | `src/lib/server/goalTaskRunner.ts` 中包含出发城市、日期、预算、住宿区域等判断 | 抽出 `taskReadinessPolicy` 模块，runner 只消费标准化 readiness 结果 |
| P2 | JSON 提取/修复能力重复且不一致 | `goalTaskRunner` 使用首尾花括号截取，`goalPlanning` 有更健壮的 balanced parser，解析行为不统一 | `goalTaskRunner.ts` 的 `extractJsonObject` 与 `goalPlanning.ts` 的 balanced parser 重复 | 新增公共 `jsonExtraction` 工具，替换 runner 中的朴素 JSON 截取 |
| P3 | `goalTaskRunner.ts`、`goalPlanning.ts` 文件过大且职责混杂 | 后续修改执行、验收、交互阻塞、轨迹和 JSON 解析时回归风险高 | `goalTaskRunner.ts` 约 2000 行，`goalPlanning.ts` 约 2300 行 | 先拆 readiness 与 JSON 工具，后续再分阶段拆 `resultParser`、`acceptanceOrchestrator`、`trajectoryRecorder` |
| P3 | persist migration 直接重置为 mock 初始数据 | 未来 bump store version 时可能清空用户本地状态 | `goalStore.ts`、`conversationStore.ts` migration 返回 mock 初始状态 | 后续应按字段做兼容迁移；本轮不主动 bump 版本，避免扩大变更面 |

## 本轮修复范围

本轮直接修复以下问题：

1. P0: `streamClaudeCli` 事件回调抛错逃逸。
2. P0: Worker lease 失效后的中断与写回 fencing。
3. P1: runtime state snapshot revision 与过期写入拒绝。
4. P1: runtime state sync 运行期基础校验。
5. P2: 抽出任务 readiness policy，降低 runner 领域规则耦合。
6. P2: 抽出公共 JSON 提取工具，替换 runner 的朴素截取逻辑。

## 后续建议

1. 将 `goalTaskRunner.ts` 继续拆为 `resultParser`、`acceptanceOrchestrator`、`trajectoryRecorder` 和 `taskInteractionBuilder`。
2. 将 `goalPlanning.ts` 继续拆为 prompt builder、Claude JSON runtime、validator、repair pipeline。
3. 将 goals 的写入所有权进一步收敛到服务端，客户端只保留投影状态和乐观更新。
4. 为 runtime job lease 增加集成测试，覆盖 lease 过期、重复 worker、续租失败和终态写回冲突。
