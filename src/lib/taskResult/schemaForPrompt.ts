export const TASK_RESULT_PROMPT_FRAGMENT = `
双区域结果呈现要求（必须返回 task_result）：
1. 任务结果可以包含两个区域：交互渲染区 interactive_render_area 与文件区域 file_area。
2. 交互渲染区用于页面内渲染；当 interactiveSurfaceKind=blocks 时通过 task_result.blocks 表达，当 interactiveSurfaceKind=webapp 时通过顶层 webapp 对象表达，blocks 只作为降级摘要。
3. 文件区域用于文件下载、预览和归档，当前通过 files 数组表达，系统会转成 task_result.artifactRefs。
4. 是否需要交互渲染区、文件区域，取决于任务的“结果呈现区域”要求；不要因为返回 files 就省略任务要求中的页面内可视化或交互内容，也不要因为返回 blocks 就省略任务明确要求的文件。
5. task_result.blocks 只能使用以下 kind：
   - heading：标题，字段 { kind, text, level }
   - paragraph：普通段落，字段 { kind, text }
   - markdown：富文本正文，字段 { kind, content }
   - list：清单，字段 { kind, ordered, items }
   - key_value：属性对，字段 { kind, entries: [{ label, value, emphasis }] }
   - comparison_table：对比表，字段 { kind, columns, rows, highlight }
   - decision：决策点，字段 { kind, question, options, selectedOptionId }
   - callout：提示/风险/结论，字段 { kind, tone, text }
6. 需要对比多个方案时优先用 comparison_table；需要用户选择时用 decision；风险、结论、重要提醒用 callout。
7. 不要发明新的 block kind；不确定的信息形态用 paragraph 或 markdown 兜底。
8. task_result.meta 必须写入 surfaces、interactiveSurfaceKind、presentation、primaryFormat、exportableFormats；presentation 合法值包括：summary_card、visual_report、comparison_table、checklist、timeline、document、dashboard、handoff_package。

task_result 示例：
{
  "schemaVersion": 1,
  "taskId": "当前任务 ID",
  "instanceId": "当前实例 ID",
  "title": "产物标题",
  "status": "done",
  "blocks": [
    { "kind": "heading", "text": "核心结论", "level": 2 },
    { "kind": "paragraph", "text": "这里写直接可验收的结论。" },
    {
      "kind": "comparison_table",
      "columns": ["方案", "优点", "风险", "建议"],
      "rows": [
        { "方案": "A", "优点": "成本低", "风险": "维护成本高", "建议": { "text": "谨慎", "tone": "warn" } }
      ]
    }
  ],
  "meta": {
    "producedAt": "ISO 时间",
    "surfaces": ["interactive"],
    "interactiveSurfaceKind": "blocks",
    "presentation": "visual_report",
    "primaryFormat": "structured_blocks",
    "exportableFormats": ["html", "markdown"]
  }
}
`.trim();

export const FILE_ARTIFACT_PROMPT_FRAGMENT = `
文件区域要求：
1. 如果结果呈现区域包含 files，必须返回 files 数组；如果不包含 files，不要额外返回 files。
2. files 每一项字段固定为 { filename, mime, content }。
3. filename 必须是简单相对文件名，只允许 .md / .txt / .csv / .json 后缀。
4. content 必须是 UTF-8 文本正文；不要返回本地路径，不要返回二进制内容。
5. 如果任务只要求文件区域，可以没有 task_result.blocks，但 summary / final_message 必须说明文件内容和用途。
6. 如果任务同时要求交互渲染区和文件区域，必须同时返回 task_result.blocks 和 files。

files 示例：
[
  {
    "filename": "research-report.md",
    "mime": "text/markdown; charset=utf-8",
    "content": "# 调研报告\\n\\n这里写完整正文。"
  }
]
`.trim();

export const WEBAPP_ARTIFACT_PROMPT_FRAGMENT = `
可执行小应用区域要求：
1. 如果结果呈现区域包含 interactive 且 interactiveSurface.kind 为 webapp，必须返回顶层 webapp 对象。
2. webapp 字段固定为 { title, description, html, initialState }。
3. webapp 可选字段 networkPolicy，合法值为 "offline" 或 "internet"；默认 offline。
4. html 必须是完整单文件 HTML，内联 CSS/JS，不要引用远程 script，不要依赖 npm install 或构建。
5. 当 networkPolicy="internet" 时，可加载公网 HTTPS 图片、音视频和 iframe；不要直接 fetch('/api/...') 或 fetch('https://...')。
6. 当需要公网 JSON/text 数据时，必须使用 window.KikiBridge.fetchInternet(url, { responseType })，由宿主受控代理请求。
7. 用户关键输入、选择、拖拽、计算结果必须通过 window.KikiBridge.patchState(...) 或 window.KikiBridge.saveState(...) 保存。
8. 小应用应监听 window 的 kiki:state 事件或宿主 state.init 消息，用于恢复已保存状态。
9. task_result.meta.interactiveSurfaceKind 必须为 "webapp"；task_result.blocks 可以提供降级摘要，但不是主交互区。

webapp 示例：
{
  "title": "预算计算器",
  "description": "用户可输入预算参数并保存方案",
  "networkPolicy": "offline",
  "html": "<!doctype html><html><head><style>body{font-family:sans-serif}</style></head><body><input id=\\"budget\\" type=\\"number\\"><script>const input=document.getElementById('budget');input.addEventListener('input',()=>window.KikiBridge.patchState({budget:Number(input.value)},{type:'field.change',payload:{field:'budget'}}));window.addEventListener('kiki:state',(event)=>{if(event.detail.budget) input.value=event.detail.budget;});</script></body></html>",
  "initialState": {
    "budget": 300000
  }
}
`.trim();

export const EXTERNAL_EMBED_PROMPT_FRAGMENT = `
外部嵌入区域要求：
1. 如果交互渲染区需要嵌入 YouTube、公开网页、地图、在线文档等外部内容，可以返回顶层 external_embed 对象。
2. external_embed 字段固定为 { title, description, url, provider }。
3. url 必须是 https:// 公网地址；不要使用 localhost、内网 IP、data:、javascript:、file:。
4. provider 合法值为 "youtube" 或 "generic"；YouTube 普通 watch 链接可直接返回，系统会转为官方 embed URL。
5. 外部 iframe 的内部播放进度、第三方站点内部点击等状态第一版无法保证保存；需要保存的用户输入应使用 webapp + KikiBridge。
6. task_result.meta.interactiveSurfaceKind 必须为 "webapp"；task_result.blocks 可以提供降级摘要。

external_embed 示例：
{
  "title": "讲解视频",
  "description": "嵌入 YouTube 官方播放器",
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "provider": "youtube"
}
`.trim();
