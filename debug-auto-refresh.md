[OPEN] auto-refresh

# 背景

- 症状：当前 `http://localhost:3000` 网页出现自动刷新。
- 目标：确认刷新来自 Next dev HMR/服务重启、代码显式 reload、路由跳转、轮询异常，还是外部浏览器环境。

# 可证伪假设

1. Next.js dev server 正在反复重编译或进程重启，浏览器通过 HMR/WebSocket 自动刷新。
2. 项目代码中存在 `window.location.reload()`、`router.refresh()` 或类似显式刷新逻辑被周期性触发。
3. 某个全局轮询接口持续报错，Next dev overlay 或客户端错误恢复触发页面刷新。
4. Runtime/state 同步逻辑持续写入导致页面关键状态变化，被误认为整页刷新。
5. 浏览器插件、Trae 预览容器或外部环境在检测到 dev server 变化后自动 reload。

# 计划

- 检查 dev server 当前日志是否出现重复编译、Fast Refresh 或重启。
- 搜索显式刷新/重载代码。
- 检查高频轮询接口和客户端错误入口。
- 根据证据判断是否需要最小埋点。
