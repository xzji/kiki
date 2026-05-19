# 任务执行统一编排重构方案 v2

## 1. 背景

当前系统中，“手动执行”和“自动调度”都在尝试启动同一类任务执行流程，但它们在 readiness 判定之后走了两套不同的编排分支：

- 两者都使用 `resolveAdmitDecision()` 做执行前准入检查。
- 自动调度在发现缺少用户信息时，会把任务落成 `awaiting_user`。
- 手动执行在发现同样的问题时，会直接返回 `409`，前端再将其当成启动失败处理。

这导致同一个任务在相同上下文下，因触发方式不同而表现出不同的状态机和 UI 行为。

典型表现：

- 自动调度：缺少用户信息 -> `awaiting_user` -> 展示补充信息交互卡片。
- 手动执行：缺少用户信息 -> 接口报错 -> 前端弹窗 -> 实例被标成 `error`。

这种差异并非业务本质差异，而是启动编排逻辑没有收口导致的实现分叉。

## 2. 目标

- 手动执行和自动调度复用同一套“启动任务执行”编排逻辑。
- 统一 readiness 判定后的 blocker 映射规则。
- 统一实例创建、状态写入、runtime job 创建和幂等判断。
- 缺少用户信息时，不再把手动执行当作错误，而是与自动调度一致地进入 `awaiting_user`。
- 让前端不再依赖 HTTP 错误码推断业务语义，而是消费标准化的启动结果。
- 为后续新增新的触发来源提供统一入口，例如按钮点击、调度器、恢复执行、外部事件等。
- 明确 pre-execution `awaiting_user` 的 blocker 合同，确保“可等待”一定“可恢复”。
- 明确第 1 阶段到第 2 阶段的实例迁移策略，避免出现双实例或错绑实例。
- 明确启动尝试的原子性与幂等语义，避免手动触发与调度器并发时创建重复 open job。
- 收口用户恢复入口，避免 `resume` / `respond` 长期并行造成协议分裂。

## 3. 不做什么

- 不重写现有任务运行器 `goalTaskRunner` 的主执行逻辑。
- 不修改当前 `awaiting_user` / `interactionRequirement` / `resume` 的核心协议语义。
- 不在本次重构中重设计所有 blocker 类型的最终产品表现。
- 不改变任务规划阶段的字段模型。
- 不把“调度器扫描候选任务”和“启动任务执行”混成一个模块。

## 4. 当前实现现状

### 4.1 已统一的部分

当前两条路径已经复用：

- `resolveAdmitDecision()`：统一生成执行上下文和 readiness 结论。
- `buildSyncReadiness()` / `buildTaskReadinessCheck()`：统一判断是否缺少用户信息。

这意味着“是否能执行”的判断本身不是问题，问题出在 readiness 之后的处理动作。

### 4.2 自动调度路径

自动调度当前流程：

1. 扫描目标和任务。
2. 调用 `resolveAdmitDecision()`。
3. 如果 `ready`，则创建任务实例并入队 runtime job。
4. 如果存在 `missing_user_input` blocker，则调用调度器自己的逻辑，把任务实例写成 `awaiting_user`。
5. 如果是 `cycle` / `config` blocker，则禁用或跳过自动运行。

特点：

- 调度器不仅“发现可运行任务”，还承担了“blocker 到实例状态”的映射职责。
- 缺少用户信息时，调度器把它当成业务等待态，而不是错误。

### 4.3 手动执行路径

手动执行当前流程：

1. 前端本地先创建一个任务实例。
2. 调用 `/api/goals/tasks/execute`。
3. 接口调用 `resolveAdmitDecision()`。
4. 如果 `ready`，创建 runtime job 并写入运行状态。
5. 如果 `blocked`，直接返回 `409`。
6. 前端把 `409` 当作启动失败抛错。
7. 本地状态把实例标成 `error`，并弹出 `alert`。

特点：

- 路由层承担了 readiness 之后的部分启动编排。
- 缺少用户信息时，被当成启动失败而不是等待补充信息。

### 4.4 当前问题总结

- 同一 blocker 在不同触发来源下被映射为不同状态。
- 手动执行和自动调度各自维护一套启动后编排分支。
- 前端被迫通过 HTTP 错误码推断业务语义。
- 未来新增 blocker 或修改状态机时，需要双份修改，容易漏改。
- 用户心智被破坏：同一个任务有时是“等我补充”，有时却变成“执行失败”。

## 5. 核心判断

手动执行和自动调度的本质差别，只应该是“触发来源不同”，而不应该是“启动编排逻辑不同”。

也就是说：

- 自动调度和手动执行都只是“发起一次任务启动尝试”。
- 两者都应进入同一个后端用例。
- 该用例根据最新 snapshot、readiness、blocker、现有 job 状态来决定统一的结果。

合理的分层应该是：

```text
触发层
  -> 手动按钮
  -> 自动调度器
  -> 未来其他入口

统一启动编排层
  -> 读取最新快照
  -> readiness 检查
  -> blocker 映射
  -> 实例创建/复用
  -> runtime job 创建/复用
  -> 返回标准化结果

展示与交互层
  -> UI 根据标准化结果展示 queued / awaiting_user / blocked_config / already_running
```

## 6. 重构目标架构

### 6.1 新增统一启动用例

新增统一服务模块：

```text
src/lib/server/taskExecution/startTaskAttempt.ts
```

该模块作为唯一的“任务启动编排入口”，负责完成：

- 读取最新 goal/task/subGoal snapshot。
- 解析或创建目标 task instance。
- 执行 `resolveAdmitDecision()`。
- 统一处理 readiness.blockers。
- 统一做 runtime job 幂等判断。
- 统一写入 snapshot。
- 统一创建或更新 runtime job。
- 返回标准化结果。

### 6.2 触发层只传入来源

手动执行和自动调度的差异只体现在：

- `triggerSource = "user"`
- `triggerSource = "scheduler"`

不再允许上层自行决定：

- readiness 失败时要不要创建 `awaiting_user`
- 是否直接返回错误
- 是否创建新实例
- 是否创建 runtime job

## 7. 统一返回模型

建议定义标准化启动结果：

```ts
export type StartTaskAttemptResult =
  | {
      schemaVersion: 1;
      outcome: "queued";
      requestId: string;
      taskInstanceId: string;
      createdNewInstance: boolean;
    }
  | {
      schemaVersion: 1;
      outcome: "awaiting_user";
      taskInstanceId: string;
      createdNewInstance: boolean;
      reason: string;
      blocker: ContextBlocker;
      readiness: TaskExecutionContext["readiness"];
    }
  | {
      schemaVersion: 1;
      outcome: "already_running";
      requestId: string;
      taskInstanceId: string;
    }
  | {
      schemaVersion: 1;
      outcome: "blocked_config";
      taskInstanceId?: string;
      reason: string;
      readiness: TaskExecutionContext["readiness"];
    };
```

设计要点：

- `missing_user_input` 不再通过异常或 `409` 表达。
- 只有真正的系统故障才抛异常或返回 5xx。
- 业务阻塞态一律用 `outcome` 表达。
- 返回体加入 `schemaVersion`，避免前端和未来调用方依赖不稳定字段形态。

## 8. 统一启动流程

### 8.1 输入

统一服务输入建议为：

```ts
type StartTaskAttemptInput = {
  goalId: string;
  subGoalId: string;
  taskId: string;
  instanceId?: string;
  runtimeEnv: RuntimeEnvironment;
  triggerSource: "user" | "scheduler";
  requestId?: string;
};
```

原则：

- 不再信任上层传入的完整 `goal/subGoal/task` 快照作为最终执行依据。
- 上层只传 identity，统一服务自己读取最新 snapshot。

### 8.2 流程步骤

统一启动流程：

```text
1. 根据 goalId / subGoalId / taskId 读取最新 snapshot
2. 确定目标 instance
   - 传入 instanceId 则复用
   - 未传入则根据规则创建新实例
3. 调用 resolveAdmitDecision()
4. 根据 readiness/blockers 计算 outcome
5. 检查已有 runtime job 是否已经 queued/running/awaiting_user
6. 根据 outcome 写入 snapshot / runtime job
7. 返回标准化结果
```

### 8.3 pre-execution awaiting_user 合同

统一服务如果把一个任务映射为 `awaiting_user`，必须同时满足“可展示”和“可恢复”两类约束，不能只把实例状态改成 `awaiting_user`。

必须产出的最小字段集合：

```ts
type PreExecutionAwaitingUserContract = {
  taskInstanceId: string;
  awaitingUser: {
    reason: string;
    interactionRequirement: InteractionRequirement;
    blocker: ExecutionBlocker;
    suggestedActions?: string[];
  };
  result: {
    structuredOutput: {
      taskReadiness: TaskReadinessCheck;
    };
    interactionRequirement: InteractionRequirement;
  };
  runtimeJob: {
    status: "awaiting_user";
    blocker: ExecutionBlocker;
  };
};
```

其中 `ExecutionBlocker` 必须包含：

- `resumeToken`
- `interactionRequirement`
- `status = "waiting"`
- `resumeStrategy`
- `createdAt`

其中 `InteractionRequirement` 至少要包含：

- `type = "provide_context"` 或其他明确交互类型
- `timing = "before_execution"`
- `reason`
- `question`
- `options` / `suggestedActions`（如果可提供）

其中 `structuredOutput.taskReadiness` 必须保留完整 `missing_user` 列表，供前端渲染多个缺项输入。

这项约束的核心原则是：

- 不是所有 `awaiting_user` 都来自运行器。
- 但所有 `awaiting_user` 都必须与运行器生成的等待态在前端看来“等价可恢复”。

### 8.4 blocker 生成来源

统一服务需要新增一层“readiness -> blocker”适配，而不是直接沿用调度器当前只写 reason 的轻量实现。

建议新增：

```text
src/lib/server/taskExecution/preExecutionBlocker.ts
```

职责：

- 把 `TaskReadinessCheck` 中的 `missingUserInfo` 转换成可恢复的 `ExecutionBlocker`
- 生成 `resumeToken`
- 生成 `interactionRequirement`
- 生成 `structuredOutput.taskReadiness`
- 统一 pre-execution 等待态和运行器等待态的数据结构

### 8.5 blocker 映射规则

首阶段建议统一以下映射：

| blocker 类型 | 统一 outcome | 说明 |
|---|---|---|
| `missing_user_input` | `awaiting_user` | 缺少用户信息时进入等待补充，而不是报错 |
| `cycle` | `blocked_config` | 配置错误，不应排队 |
| `config` | `blocked_config` | 配置错误，不应排队 |
| 无 blocker | `queued` | 进入运行队列 |

说明：

- 本期先收口最关键的 `missing_user_input`。
- 依赖类 blocker 是否也应映射为等待态，可作为第二阶段扩展。

## 9. 实例与 runtime job 策略

### 9.1 实例创建策略

当前系统里：

- 手动执行偏向由前端先创建实例。
- 自动调度偏向由调度器创建实例。

重构后建议：

- 实例创建统一下沉到后端统一服务。
- 上层只声明“是否指定复用已有实例”。

理由：

- 避免前端和调度器各自生成实例，造成语义不一致。
- 避免出现“接口拒绝启动，但前端已经创建了一个错误实例”的问题。

### 9.2 分阶段迁移策略

为了降低改造风险，本方案不建议一步切换到“后端独占实例创建”，而是采用两阶段迁移：

#### 阶段 1：兼容前端现有实例

规则：

- 手动执行继续由前端先创建实例并传入 `instanceId`
- `startTaskAttempt()` 在手动触发场景下必须复用该 `instanceId`
- 此阶段后端不得为同一次手动触发再创建第二个 canonical instance

约束：

- 如果输入中已带 `instanceId`，统一服务只允许“复用或拒绝”，不允许偷偷新建
- 返回结果中的 `taskInstanceId` 必须等于输入 `instanceId`

目的：

- 先把“启动编排逻辑”统一掉
- 不在第一阶段同时引入前端大规模状态同步改造

#### 阶段 2：实例创建完全下沉到后端

规则：

- 前端不再预创建实例
- `/execute` 或统一启动接口返回 canonical `taskInstanceId`
- 前端根据返回结果插入/替换本地实例卡片

要求：

- 前端 `runTaskExecutionAction()` 需支持“拿到后端返回的新实例后再开始轮询”
- 调度器和手动执行在实例创建职责上彻底一致

只有在阶段 1 稳定后，才进入阶段 2。

### 9.3 awaiting_user 是否创建 runtime job

建议统一策略：

- 当 outcome 为 `awaiting_user` 时，也创建或维护一个 `awaiting_user` runtime job。

理由：

- 这样 `resume` / `respond` 不需要区分任务最初是手动触发还是调度触发。
- 后续恢复执行时可以直接依赖 runtime job 上的 blocker / resumeToken / payload。
- 状态机更完整，避免出现 snapshot 已等待用户、但后台没有可恢复对象的情况。

### 9.4 already_running 语义

统一服务必须在 readiness 之后、真正创建 job 之前检查：

- 是否已有 `queued` job
- 是否已有 `running` job
- 是否已有 `awaiting_user` job

如果已有，则返回：

```ts
{ outcome: "already_running", ... }
```

而不是重复创建实例或重复排队。

## 10. 启动原子性与幂等

这是本次方案必须补上的核心约束。

当前如果仅靠“先查是否已有 job，再决定创建”，仍然存在并发窗口：

- 调度器扫描命中任务
- 用户同时手动点击执行
- 两边都通过 readiness
- 两边都在检查时未发现已有 open job
- 最终各自创建 instance / runtime job

因此 `startTaskAttempt()` 必须具备原子去重能力。

### 10.1 幂等键建议

建议定义启动幂等范围：

- 手动执行：
  - `Idempotency-Key = start_task:user:${instanceId}`
- 自动调度：
  - `Idempotency-Key = start_task:scheduler:${taskId}:${scheduleTickOrWindow}`

如果统一服务最终以 instance 为主键，则也可以约束：

- 同一 `instanceId` 在 `queued/running/awaiting_user` 期间只能存在一个 open runtime job

### 10.2 原子约束建议

建议至少满足其一：

- 使用数据库事务，把“查重 + 写入 instance/job”包在同一事务内
- 或在 `runtime_jobs` 上增加唯一约束，防止同一逻辑 open job 重复创建

推荐约束方向：

- 同一 `task_instance_id` 在 `status IN ('queued', 'running', 'awaiting_user')` 下只能存在一个 open job

### 10.3 统一服务的原子语义

`startTaskAttempt()` 应保证：

- 要么返回已存在的 open job / awaiting 状态
- 要么成功创建唯一的新 open job / awaiting job
- 不允许返回“看起来成功”，但实际 snapshot 与 runtime job 没有一致写入

## 11. 恢复入口统一策略

当前系统中同时存在：

- `/api/goals/tasks/resume`
- `/api/goals/instances/[instanceId]/respond`

两条路径都在做“用户提交后继续执行”的事情，但协议不同。

这会导致统一启动后，恢复路径仍然分裂。

### 11.1 建议目标

统一后，`awaiting_user` 的唯一恢复入口应明确为一条：

- 推荐保留 `/api/goals/tasks/resume`

原因：

- 它已显式依赖 `resumeToken`
- 与 `ExecutionBlocker` 模型天然配套
- 更适合承接 pre-execution 与 in-execution 两类阻塞点

### 11.2 对 `/respond` 的处理建议

建议在 v2 方案中明确：

- `/respond` 不再作为任务运行恢复的主入口
- 它可保留为“消息流写事件”的兼容接口
- 但如果命中任务 blocker，应内部转发到统一恢复逻辑，而不是保留第二套状态变更实现

也就是说：

- 外部可继续调用 `/respond`
- 内部必须收口到统一 resume service

### 11.3 恢复入口的协议要求

统一恢复入口必须同时支持：

- pre-execution blocker 恢复
- 运行中 blocker 恢复
- 多字段 `missing_user` 一次性补齐
- 非阻塞反馈型 blocker 的完成态更新

并且必须保证：

- `resumeToken` 是唯一恢复凭证
- 已恢复的 blocker 不能重复提交
- 恢复后 runtime job、goal snapshot、workspace snapshot 同步更新

## 12. 模块改造建议

### 10.1 新增模块

建议新增：

```text
src/lib/server/taskExecution/startTaskAttempt.ts
src/lib/server/taskExecution/startTaskAttempt.types.ts
src/lib/server/taskExecution/startTaskAttempt.snapshot.ts
src/lib/server/taskExecution/startTaskAttempt.persistence.ts
src/lib/server/taskExecution/preExecutionBlocker.ts
```

职责划分：

- `startTaskAttempt.types.ts`
  - 定义输入输出模型
- `startTaskAttempt.snapshot.ts`
  - 读取和定位 canonical snapshot
- `startTaskAttempt.persistence.ts`
  - 负责实例写入、job 写入、状态更新
- `preExecutionBlocker.ts`
  - 把 readiness 缺项转换成 `ExecutionBlocker + InteractionRequirement + taskReadiness`
- `startTaskAttempt.ts`
  - 编排主流程

### 10.2 修改 `/api/goals/tasks/execute`

当前问题：

- 路由自己实现了一部分启动编排。
- readiness blocked 时直接返回 `409`。

改造后：

- 路由仅作为 transport adapter。
- 调用 `startTaskAttempt({ triggerSource: "user" })`。
- 返回 `outcome` 驱动的标准结果。

建议返回：

- `queued` -> `200`
- `awaiting_user` -> `200`
- `already_running` -> `200`
- `blocked_config` -> `409` 或 `200`

更推荐：

- 业务态全部 `200`
- 仅系统异常返回 4xx/5xx

### 10.3 修改 `goalSchedulerEngine.ts`

当前问题：

- 调度器不仅负责扫描候选任务，还自己处理 blocker 和状态写入。

改造后：

- 调度器只负责：
  - 扫描候选任务
  - 优先级排序
  - 限流
  - 调用 `startTaskAttempt({ triggerSource: "scheduler" })`

删除或下沉以下逻辑：

- `markTaskAwaitingFromScheduler()`
- 调度器内直接创建 runtime job
- 调度器内直接创建 instance
- 调度器内直接处理 `missing_user_input`

### 10.4 修改前端启动逻辑

当前问题：

- 前端把“业务阻塞”当成“启动失败”。
- `409` 会导致本地实例被标成 `error`。

改造后：

- `startTaskRun()` 需要识别 `outcome`。
- `runTaskExecutionAction()` 对不同 outcome 做不同处理：
  - `queued` -> 正常进入轮询
  - `awaiting_user` -> 同步实例为 `awaiting_user`
  - `already_running` -> 复用当前运行/等待状态
  - `blocked_config` -> 展示配置阻塞信息

前端不再因为缺少用户信息而弹错误弹窗。

### 10.5 补充需要纳入改造范围的模块

除了前文列出的 4 个主要文件，本次重构还需要明确评估或改造以下模块：

- `src/app/api/goals/tasks/resume/route.ts`
  - 承接统一后的 blocker 恢复协议
- `src/app/api/goals/instances/[instanceId]/respond/route.ts`
  - 兼容或转发到统一恢复入口
- `src/app/api/goals/tasks/progress/route.ts`
  - 保证 pre-execution `awaiting_user` 也能正确返回等待原因和进度视图
- `src/lib/server/worker/taskDispatchWorker.ts`
  - 校验 `awaiting_user` job 的 worker 写回语义与 open job 生命周期是否一致

这些模块不一定都要在第 1 阶段修改大量代码，但必须被纳入设计和回归范围，否则统一方案仍可能在“启动后展示”和“恢复继续执行”两个环节重新分叉。

## 13. 推荐实施步骤

### 第 1 阶段：统一缺少用户信息场景

目标：

- 先解决最明显的不一致。

范围：

- 抽出 `startTaskAttempt()`
- 接管 `missing_user_input -> awaiting_user`
- 增加 readiness -> pre-execution blocker 的转换层
- 接入手动执行 API
- 前端支持消费 `awaiting_user` outcome
- 明确此阶段继续复用前端已创建的 `instanceId`

验收标准：

- 手动执行缺少出发城市时，不再报错。
- 手动执行和自动调度都进入 `awaiting_user`。
- `AwaitingUserResumePanel` 可正常承接补信息流程。
- `resume` 能基于 pre-execution blocker 正常恢复执行。

### 第 2 阶段：接管自动调度

目标：

- 让调度器彻底变成“扫描器 + 调用方”。

范围：

- 调度器调用统一服务
- 删除调度器中重复的 blocker 处理和实例/job 写入逻辑
- 若第 1 阶段验证通过，可开始推动实例创建逐步下沉到后端

验收标准：

- 调度器不再维护自己的启动状态机分支。
- 自动调度结果与手动执行完全一致。

### 第 3 阶段：收口 blocker 语义

目标：

- 统一其他 blocker 的后续表现。

范围：

- 依赖 blocker
- 配置 blocker
- 循环依赖 blocker
- 已有 open job 的幂等返回
- `/respond` 与 `/resume` 的统一恢复入口收口

验收标准：

- 所有 blocker 都通过统一服务映射为标准 outcome。
- 上层调用方不再自行判断 blocker 类型做分支。

## 14. 测试与验证方案

### 12.1 单元测试

建议覆盖：

- `ready` -> `queued`
- `missing_user_input` -> `awaiting_user`
- 已有 `queued/running/awaiting_user` job -> `already_running`
- `cycle/config` -> `blocked_config`
- 指定 `instanceId` 时正确复用
- 未指定 `instanceId` 时正确创建新实例

### 12.2 集成测试

关键场景：

1. 手动执行缺少用户信息
- 触发“往返机票方案对比与预订”
- 上下文中无出发城市
- 结果应为 `awaiting_user`
- 不应出现错误弹窗

2. 自动调度缺少用户信息
- 调度器扫描到同一任务
- 结果也应为 `awaiting_user`
- 与手动执行生成同构状态

3. 用户补充信息后恢复执行
- 通过现有 `resume` 或 `respond` 路径提交补充信息
- 任务应恢复到 `queued/running`
- 继续完成任务

4. 已有 open job 时再次触发
- 不应重复创建 instance 或 runtime job
- 应返回 `already_running`

5. 手动触发与调度器并发命中
- 同一任务在同一时间由用户和调度器同时发起启动尝试
- 最终只能保留一个 open runtime job
- goal snapshot 中不能出现两个语义重复的 open instance

6. pre-execution awaiting_user 恢复
- 统一服务生成的 `awaiting_user` 必须包含 blocker、resumeToken、taskReadiness
- 用户补充信息后可从 `/resume` 正常恢复
- 恢复后 blocker 状态更新为 resolved 或进入 queued/running

### 12.3 回归关注点

- `AwaitingUserResumePanel` 是否仍能读取 `interactionRequirement`
- `goalStateSnapshot` 中 `awaiting_user` 状态是否完整
- `runtimeJobsRepository` 中 `awaiting_user` job 是否可恢复
- 通知系统是否正确识别新的等待态
- 手动执行按钮是否仍支持 rerun / resume / pause
- `progress` 路由是否能正确返回 pre-execution waitingReason
- `/respond` 是否会与 `/resume` 重复推进同一 blocker

## 15. 风险与注意事项

### 13.1 前端提前创建实例的历史包袱

当前前端会在调用接口前创建实例，这与“后端统一创建实例”的方向冲突。

风险：

- 可能产生重复实例
- 可能留下被拒绝启动的脏实例

建议：

- 在第 1 阶段先兼容现有实例创建方式
- 第 2 阶段再将实例创建完全下沉到后端
- 在第 1 阶段必须把“手动触发时服务端不得创建第二实例”写成硬约束

### 13.2 awaiting_user runtime job 一致性

如果统一决定 `awaiting_user` 也保留 runtime job，就必须确保：

- `resume`
- `respond`
- daemon 恢复
- 状态同步

都使用一致的数据源。

额外要求：

- `awaiting_user` 不能只是 snapshot 状态
- 必须有可恢复 blocker 和一致的 runtime job 记录

### 13.3 业务态与错误态解耦

这是本次重构的关键：

- `missing_user_input` 不是错误
- `dependency waiting` 通常也不是错误
- 只有系统故障、数据损坏、配置缺失才是真错误

如果前端仍按旧思路把非 `queued` 一律当异常处理，则重构无法真正收敛。

### 13.4 两套恢复入口长期并存的风险

如果方案只统一启动入口，却不统一恢复入口，则会出现新的分叉：

- pre-execution blocker 用 `resume`
- 消息流交互继续用 `respond`
- 某些场景两者都能推进同一个任务

这会让 blocker 生命周期、事件日志、runtime job 状态再次不一致。

因此本次方案必须把“恢复入口收口”列为明确目标，而不是后续可选项。

## 16. 建议落地文件

建议新增：

- `src/lib/server/taskExecution/startTaskAttempt.ts`
- `src/lib/server/taskExecution/startTaskAttempt.types.ts`
- `src/lib/server/taskExecution/startTaskAttempt.snapshot.ts`
- `src/lib/server/taskExecution/startTaskAttempt.persistence.ts`
- `src/lib/server/taskExecution/preExecutionBlocker.ts`

建议修改：

- `src/app/api/goals/tasks/execute/route.ts`
- `src/lib/server/worker/goalSchedulerEngine.ts`
- `src/lib/api/taskRuns.ts`
- `src/lib/taskExecution.ts`
- `src/app/api/goals/tasks/resume/route.ts`
- `src/app/api/goals/instances/[instanceId]/respond/route.ts`
- `src/app/api/goals/tasks/progress/route.ts`
- `src/lib/server/worker/taskDispatchWorker.ts`

## 17. 最终结论

本次重构的核心，不是再优化一次 readiness 规则，而是把“启动任务”抽象成统一的后端用例。

统一后：

- 手动执行和自动调度只在触发来源上不同。
- readiness 之后的编排逻辑完全复用。
- `missing_user_input` 一律进入 `awaiting_user`，不再被误判为启动失败。
- 前端消费统一的 `outcome`，而不是依赖错误码猜业务语义。
- pre-execution `awaiting_user` 与运行器产出的等待态拥有同构 blocker 合同，可直接恢复。
- 手动触发与调度器并发命中时，统一服务负责原子去重，避免重复 open job。
- 恢复入口最终收口为统一协议，不再长期维持两套平行状态机。

这将把当前“前半段统一、后半段分叉”的实现，收敛为真正单一、可维护、可扩展的任务启动状态机。
