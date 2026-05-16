# 项目文档索引

本目录汇总项目层面的方案规划、设计演示稿与排障笔记，供团队成员阅读与协作。

> 说明：`.trae/documents/` 仅保留 Agent 工作上下文相关材料；面向"人"的方案性文档统一沉淀在本目录。

## 目录结构

```
docs/
├── plans/      # 方案规划：产品/架构/重构方案
├── designs/    # 设计稿与演示稿：HTML demo、截图等
└── debug/      # 排障笔记：性能、并发、刷新等问题的现场记录
```

## plans/ ｜ 方案规划

| 文档 | 主题 |
|---|---|
| [00-agent-execution-evolution-roadmap.md](./plans/00-agent-execution-evolution-roadmap.md) | KiKi Agent 执行体系演进总规划：结构化产物、可观测执行、可恢复任务、Capability 与 Forge 的分阶段路线 |
| [01-presentation-block-renderer.md](./plans/01-presentation-block-renderer.md) | 呈现层方案：Block JSON + Artifact 沙箱，用通用渲染原语承载任务产物 |
| [02-execution-agent-runner.md](./plans/02-execution-agent-runner.md) | 执行层方案：Capability + Plan-Act-Reflect，升级任务执行循环与副作用治理 |
| [03-evolution-capability-forge.md](./plans/03-evolution-capability-forge.md) | 进化层方案：Capability Forge，通过能力缺口发现与锻造机制扩展 Agent 能力 |
| [task-collaboration-requirements-refactor-plan.md](./plans/task-collaboration-requirements-refactor-plan.md) | 任务协作要求（TaskCollaborationRequirements）重构方案：明确 Agent / 用户职责分工与介入类型 |
| [result-notification-judge-plan.md](./plans/result-notification-judge-plan.md) | 结果通知门禁逻辑：按 interaction type 决定何时推送会话卡片 |
| [task-acceptance-repair-plan.md](./plans/task-acceptance-repair-plan.md) | 任务验收与补齐闭环：本地硬校验、独立验收员、定向修复与内容补齐 |
| [goal-agent-autonomous-execution-plan.md](./plans/goal-agent-autonomous-execution-plan.md) | 长程目标 Agent 自主执行链路设计 |
| [goal-info-monitoring-product-plan.md](./plans/goal-info-monitoring-product-plan.md) | 目标信息监控产品方案 |
| [kiki-slash-goal-mode-plan.md](./plans/kiki-slash-goal-mode-plan.md) | KiKi `/goal` 命令模式与长程目标工作流 |
| [claude-code-local-runtime-integration-plan.md](./plans/claude-code-local-runtime-integration-plan.md) | 本地 Claude CLI Runtime 集成方案 |
| [local-runtime-24h-daemon-product-plan.md](./plans/local-runtime-24h-daemon-product-plan.md) | 本地 Runtime 24h 守护进程（LaunchAgent）产品方案 |
| [server-persistence-and-sync-architecture-plan.md](./plans/server-persistence-and-sync-architecture-plan.md) | 服务端持久化与前后端状态同步架构 |
| [schedule-page-v1-and-v2-plan.md](./plans/schedule-page-v1-and-v2-plan.md) | 日程页 v1 / v2 设计与演进 |
| [project-prompts-inventory.md](./plans/project-prompts-inventory.md) | 项目 Prompt 集中清单：Claude 会话、目标规划、任务执行与结构化产物要求 |

## designs/ ｜ 设计与演示稿

| 文档 | 用途 |
|---|---|
| [目标拆解规划-demo-v2.html](./designs/目标拆解规划-demo-v2.html) | 目标拆解规划交互形态的 HTML 静态演示稿 |

## debug/ ｜ 排障笔记

| 文档 | 关注问题 |
|---|---|
| [debug-auto-refresh.md](./debug/debug-auto-refresh.md) | 3000 端口网页自动刷新问题排查 |
| [debug-goal-cli-concurrency.md](./debug/debug-goal-cli-concurrency.md) | 目标规划 / 任务执行的 Claude CLI 并发问题排查 |
| [debug-goal-planning-latency.md](./debug/debug-goal-planning-latency.md) | 目标规划阶段延迟问题排查 |

## 写作约定

- 文件名统一使用小写短横线分隔，后缀语义建议：
  - `*-plan.md`：产品 / 架构方案
  - `*-refactor-plan.md`：重构方案
  - `debug-*.md`：排障笔记
- 新增方案时，请在本 README 对应分组追加一行链接，保持索引最新。
