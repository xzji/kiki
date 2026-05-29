import assert from "node:assert/strict";
import { parseTaskDraftBatch } from "./blockProtocol";

function task(index: number, body = "") {
  return `<task index="${index}">
<title>
任务 ${index}
</title>
<objective>
完成目标 ${index}${body}
</objective>
<deliverable>
交付物 ${index}
</deliverable>
<acceptance>
- 标准 A
- 标准 B
</acceptance>
<user-involvement mode="none" />
</task>`;
}

export function runBlockProtocolSpecs() {
  assert.equal(parseTaskDraftBatch(task(1)).tasks[0]?.title, "任务 1");
  assert.equal(parseTaskDraftBatch(`${task(1)}\n${task(2)}`).tasks.length, 2);
  assert.equal(parseTaskDraftBatch(`<task>\n<title>无 index</title>\n<objective>目标</objective>\n<deliverable>交付</deliverable>\n<acceptance>- 标准</acceptance>\n</task>`).tasks[0]?.index, 1);
  assert.equal(parseTaskDraftBatch("```xml\n" + task(1) + "\n```").tasks.length, 1);
  assert.equal(parseTaskDraftBatch(`<task index="1">\n<title><![CDATA[包含 </title> 字面量]]></title>\n<objective>目标</objective>\n<deliverable>交付</deliverable>\n<acceptance>- 标准</acceptance>\n</task>`).tasks[0]?.title, "包含 </title> 字面量");
  assert.equal(parseTaskDraftBatch(`<task index="1">\n<title><![CDATA[第一行\n</title>\n第二行]]></title>\n<objective>目标</objective>\n<deliverable>交付</deliverable>\n<acceptance>- 标准</acceptance>\n</task>`).tasks[0]?.title, "第一行\n</title>\n第二行");
  assert.equal(parseTaskDraftBatch(`<task index="1">\n<title>缺尾标签\n<objective>目标</objective>\n<deliverable>交付</deliverable>\n<acceptance>- 标准</acceptance>\n</task>`).tasks[0]?.title, "缺尾标签");
  const mixed = parseTaskDraftBatch(`${task(1)}\n<task index="2">\n<title>坏任务</title>\n</task>\n${task(3)}`);
  assert.equal(mixed.tasks.length, 2);
  assert.deepEqual(mixed.droppedTaskIndices, [2]);
  const allInvalid = parseTaskDraftBatch(`<task index="1">\n<title>坏任务</title>\n</task>`);
  assert.equal(allInvalid.tasks.length, 0);
  assert.deepEqual(allInvalid.droppedTaskIndices, [1]);
  assert.equal(parseTaskDraftBatch(task(1, "\n保留空行\n\n结束")).tasks[0]?.objective.includes("\n\n"), true);
}
