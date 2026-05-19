# Debug Session: project-restart-error

Status: OPEN

## Symptom

用户反馈“重启项目，现在有报错”。需要重启项目并收集真实运行日志。

## Hypotheses

1. 新增多 Agent 模块存在运行时 import、服务端/客户端边界或路径解析问题。
2. Next dev 启动遇到既有 `useSearchParams()` Suspense 或预渲染相关问题。
3. 最近 SQLite/workspace/mock 数据触发 schema、JSON 结构或旧数据兼容问题。
4. 旧 dev 进程、端口占用或 `.next` 缓存导致启动异常。

## Evidence Log

- `pnpm dev` first started on port 3001 because port 3000 was occupied by an old `next-server` process.
- Old port 3000 process: PID 71160, command `next-server (v14.2.30)`.
- After stopping the old process, `pnpm dev` started successfully on `http://localhost:3000`.
- `/` and `/conversations` returned HTTP 200.
- Dev terminal showed `Fast Refresh had to perform a full reload due to a runtime error`, without a server stack trace.
- Likely browser-side compatibility issue: stale localStorage or older task result data can omit `taskResult.meta` / `taskResult.blocks`, while the new result view read these fields directly.

## Actions

- Stopped the 3001 dev process started during debugging.
- Stopped the old port 3000 Next process.
- Restarted dev server on `http://localhost:3000`.
- Added backward-compatible guards in `GenericAgentResultView` for missing `taskResult.meta` and `taskResult.blocks`.
- `pnpm exec tsc --noEmit` passed.
- `pnpm lint` passed.
- Opened preview for `http://localhost:3000/`; preview check reported no browser errors.
