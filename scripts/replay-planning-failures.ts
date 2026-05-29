import fs from "node:fs";
import path from "node:path";

import { parseTaskDraftBatch } from "../src/lib/server/goalPlanning/blockProtocol";

const root = path.join(process.cwd(), "data", "workspaces", "conversations");
const samples = ["conv-new-1779883996052", "conv-new-1779892704115"];

for (const sample of samples) {
  const dir = path.join(root, sample);
  if (!fs.existsSync(dir)) {
    console.log(`${sample}: skipped (not found)`);
    continue;
  }
  const files: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.json$|\.txt$|\.md$/.test(entry.name)) files.push(full);
    }
  };
  walk(dir);
  const text = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  try {
    const parsed = parseTaskDraftBatch(text);
    console.log(`${sample}: parsed=${parsed.tasks.length}, dropped=${parsed.droppedTaskIndices?.length ?? 0}`);
  } catch (error) {
    console.log(`${sample}: block parse unavailable (${error instanceof Error ? error.message : "unknown"})`);
  }
}
