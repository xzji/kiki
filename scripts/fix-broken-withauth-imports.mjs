import fs from "fs";
import path from "path";

const API_ROOT = path.resolve("src/app/api");

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.name === "route.ts") files.push(full);
  }
  return files;
}

function fixFile(filePath) {
  let content = fs.readFileSync(filePath, "utf8");
  if (!content.includes("withAuth")) return false;

  content = content.replace(/\nimport \{ withAuth \} from "@\/lib\/server\/http\/withAuth";\n/g, "\n");
  content = content.replace(/^import \{ withAuth \} from "@\/lib\/server\/http\/withAuth";\n\n/gm, "");

  if (!content.includes('from "@/lib/server/http/withAuth"')) {
    const lines = content.split("\n");
    let lastImportIndex = -1;
    lines.forEach((line, index) => {
      if (line.startsWith("import ")) lastImportIndex = index;
    });
    if (lastImportIndex >= 0) {
      lines.splice(lastImportIndex + 1, 0, 'import { withAuth } from "@/lib/server/http/withAuth";');
      content = lines.join("\n");
    } else {
      content = `import { withAuth } from "@/lib/server/http/withAuth";\n\n${content}`;
    }
  }

  fs.writeFileSync(filePath, content);
  return true;
}

let fixed = 0;
for (const file of walk(API_ROOT)) {
  if (fixFile(file)) fixed += 1;
}
console.log(`fixed imports in ${fixed} files`);
