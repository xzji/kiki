# 目标模式命令胶囊计划

## Summary

将当前输入框里以普通文本形式出现的 `/goal ` 改为独立的“命令模式”胶囊。用户从斜杠菜单选择“长程目标任务”后，输入框左侧显示一个 `/goal` 标签，后续文字只作为目标内容输入；提交时仍向现有业务链路传递 `/goal ${内容}`，保持 `parseSlashCommand()`、目标规划生成流程和调用方兼容。删除行为为：当命令胶囊存在且光标位于目标内容最开头时，按 Backspace 一次删除整个 `/goal` 胶囊。

## Current State Analysis

- `src/components/layout/AssistantComposer.tsx` 是普通会话和 KiKi 右侧边栏共用的输入框组件。
- 当前 `selectCommand()` 在选择命令后执行 `setValue(\`/${command.name} \`)`，直接把 `/goal ` 写入 `textarea`，因此删除只能按字符逐个删除。
- 当前提交逻辑 `submit()` 对 `value.trim()` 做非空校验，并直接调用 `onSubmit(next, quotedMessage)`。
- 当前斜杠菜单展示由 `getSlashCommandSuggestions(value)` 驱动，只在输入以 `/` 开头且未包含空格时出现。
- `src/lib/slashCommands.ts` 目前只有一个命令：`SlashCommandName = "goal"`，`parseSlashCommand()` 依赖提交文本以 `/goal` 开头来进入目标模式。
- `AssistantComposer` 被 `src/components/conversation/ConversationView.tsx` 和 `src/components/layout/AssistantSidebar.tsx` 调用，目标模式流程最终仍依赖调用方收到 `/goal ...`。

## Proposed Changes

### `src/components/layout/AssistantComposer.tsx`

- 新增状态：
  - `selectedCommand: SlashCommand | null`，表示当前是否处于命令模式。
  - `value` 在命令模式下只保存用户输入的目标内容，不再包含 `/goal ` 前缀。
- 调整 `selectCommand(index)`：
  - 选择 `/goal` 后设置 `selectedCommand` 为对应命令。
  - 清空或保留合理 payload：本次选择来自菜单时设置 `value` 为空。
  - 隐藏命令菜单并聚焦 `textarea`，光标置于正文开头。
- 调整 `submit()`：
  - 若存在 `selectedCommand`，提交值拼成 `/${selectedCommand.name} ${value.trim()}`。
  - 命令模式下仍要求 `value.trim()` 非空，避免只提交 `/goal` 空 payload。
  - 提交成功后同时清空 `value`、`selectedCommand`、附件等临时状态。
  - 非命令模式保持现有纯文本提交逻辑。
- 调整空态和发送按钮：
  - `isEmpty` 改为基于最终可提交 payload 判断。
  - 命令模式下只有正文为空时禁用发送按钮。
- 调整 `onChange`：
  - 普通模式保持现状，输入 `/` 时继续触发斜杠菜单。
  - 命令模式下只更新正文，不再调用 `getSlashCommandSuggestions()` 展示命令菜单。
- 调整 `onKeyDown`：
  - 保留命令菜单的上下键、回车选择、Esc 关闭逻辑。
  - 新增 Backspace 整体删除规则：当 `selectedCommand` 存在、`textarea.selectionStart === 0`、`textarea.selectionEnd === 0` 且按下 Backspace 时，`preventDefault()` 并设置 `selectedCommand = null`。
  - 删除胶囊后正文保留不变，用户可继续作为普通文本编辑；如果正文为空，回到普通空输入状态。
- 调整 UI：
  - 将 `textarea` 外层改成横向 flex 容器，在输入区第一行左侧渲染命令胶囊。
  - 胶囊样式参考现有菜单里的黑底 `/goal` 标签：圆角、深色背景、白色等宽文本，视觉体现“命令模式”。
  - 胶囊不提供 X 删除按钮，因为用户已确认只需要 Backspace 整体删除。
  - `textarea` 在胶囊右侧自适应，占据剩余宽度；移动端或窄宽度下允许换行但保持阅读清晰。
- 调整 placeholder：
  - 非命令模式使用现有 placeholder。
  - 命令模式下使用 `selectedCommand.placeholder` 的正文版提示，例如“描述一个长期目标，例如三个月内托福达到 110 分”，避免重复出现 `/goal`。

### `src/lib/slashCommands.ts`

- 保持 `SlashCommandName = "goal"` 和 `parseSlashCommand()` 不变，避免影响目标模式业务链路。
- 可选新增一个轻量 helper，例如 `getCommandPayloadPlaceholder(command)`，用于从命令 placeholder 中移除 `/goal` 前缀；也可以在 `AssistantComposer` 内部局部处理，优先选择局部处理以减少公共 API 变更。

## Assumptions & Decisions

- 命令胶囊显示文本固定为 `/goal`，不显示 `/plan`。
- 删除行为只实现“光标在正文最前面按 Backspace 时整体删除胶囊”，不增加 X 按钮。
- 提交流程仍复用现有 `/goal ${payload}` 字符串协议，避免改动 `assistantStore.ts`、`ConversationView.tsx` 和 `parseSlashCommand()` 的目标模式分支。
- 用户手动输入 `/goal 托福考试110` 时暂不强制转换成胶囊；本次只处理“从斜杠菜单选中目标模式后”的体验。
- 命令模式下正文为空时不允许发送，避免触发空目标规划。
- 不引入 `contentEditable`，继续基于当前 `textarea` 实现，降低输入法、换行和可访问性风险。

## Edge Cases

- 选择 `/goal` 后立即按 Backspace：删除胶囊，输入框恢复普通空态。
- 选择 `/goal` 后输入内容，再将光标移动到正文开头按 Backspace：删除胶囊但保留正文。
- 选择 `/goal` 后在正文中间或末尾按 Backspace：只删除正文字符，不影响胶囊。
- 命令菜单打开时按 Enter：仍选择命令；命令模式已激活后按 Enter：提交目标内容。
- `disabled` 状态下不允许选择命令、编辑正文或删除胶囊。

## Verification Steps

- 手动验证：在普通会话输入框输入 `/`，菜单出现“长程目标任务”。
- 手动验证：选择该命令后，输入框出现 `/goal` 胶囊，正文区域为空且聚焦。
- 手动验证：输入“托福考试110”，输入框视觉为 `/goal` 胶囊 + `托福考试110`，而不是普通文本 `/goal 托福考试110`。
- 手动验证：正文开头按 Backspace 后，`/goal` 胶囊一次性消失。
- 手动验证：正文中间/末尾按 Backspace 只删除正文字符。
- 手动验证：命令模式输入内容后发送，现有目标规划流程仍被触发。
- 手动验证：KiKi 右侧边栏里的 `AssistantComposer` 同样具备该行为。
- 静态验证：运行 `pnpm lint`，确保无 ESLint 报错。
