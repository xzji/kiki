export const TASK_RESULT_PROMPT_FRAGMENT = `
结构化产物要求（必须返回 task_result）：
1. task_result 是本任务的主结果对象，必须直接覆盖“预期结果/核心交付物”。
2. task_result.blocks 只能使用以下 kind：
   - heading：标题，字段 { kind, text, level }
   - paragraph：普通段落，字段 { kind, text }
   - markdown：富文本正文，字段 { kind, content }
   - list：清单，字段 { kind, ordered, items }
   - key_value：属性对，字段 { kind, entries: [{ label, value, emphasis }] }
   - comparison_table：对比表，字段 { kind, columns, rows, highlight }
   - decision：决策点，字段 { kind, question, options, selectedOptionId }
   - callout：提示/风险/结论，字段 { kind, tone, text }
3. 需要对比多个方案时优先用 comparison_table；需要用户选择时用 decision；风险、结论、重要提醒用 callout。
4. 不要发明新的 block kind；不确定的信息形态用 paragraph 或 markdown 兜底。
5. task_result.meta 必须写入 presentation、primaryFormat、exportableFormats；presentation 合法值包括：summary_card、visual_report、comparison_table、checklist、timeline、document、dashboard、handoff_package。信息类报告优先使用 presentation=visual_report、primaryFormat=structured_blocks、exportableFormats=["html","markdown"]。
6. task_result.blocks 是唯一主产出容器；artifacts 只能作为导出、下载或兼容镜像，不能替代 blocks。
7. 如果 artifacts 有内容，task_result.blocks 中必须能看到同等完整的用户可读产出。

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
    "presentation": "visual_report",
    "primaryFormat": "structured_blocks",
    "exportableFormats": ["html", "markdown"]
  }
}
`.trim();
