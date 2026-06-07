import fs from "fs";
import path from "path";

const API_ROOT = path.resolve("src/app/api");
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

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

  let changed = false;
  for (const method of HTTP_METHODS) {
    const handlerName = `${method}Handler`;
    const fnPattern = new RegExp(`async function ${method}\\b`, "g");
    const exportPattern = new RegExp(`export const ${method} = withAuth\\(${method}\\);`, "g");
    if (!fnPattern.test(content) && !exportPattern.test(content)) continue;
    content = content.replace(new RegExp(`async function ${method}\\b`, "g"), `async function ${handlerName}`);
    content = content.replace(
      new RegExp(`export const ${method} = withAuth\\(${method}\\);`, "g"),
      `export const ${method} = withAuth(${handlerName});`,
    );
    changed = true;
  }

  if (!changed) return false;
  fs.writeFileSync(filePath, content);
  return true;
}

let changed = 0;
for (const file of walk(API_ROOT)) {
  if (fixFile(file)) {
    changed += 1;
  }
}
console.log(`fixed ${changed} files`);
