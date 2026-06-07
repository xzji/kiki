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

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

function shouldSkip(filePath, content) {
  if (filePath.includes(`${path.sep}api${path.sep}auth${path.sep}`)) return true;
  if (content.includes("withAuth")) return true;
  return !HTTP_METHODS.some((method) => new RegExp(`export\\s+async\\s+function\\s+${method}\\b`).test(content));
}

function wrapFile(filePath) {
  let content = fs.readFileSync(filePath, "utf8");
  if (shouldSkip(filePath, content)) return false;

  const foundMethods = HTTP_METHODS.filter((method) =>
    new RegExp(`export\\s+async\\s+function\\s+${method}\\b`).test(content),
  );
  if (foundMethods.length === 0) return false;

  for (const method of foundMethods) {
    content = content.replace(
      new RegExp(`export\\s+async\\s+function\\s+(${method})\\b`, "g"),
      "async function $1",
    );
  }

  if (!content.includes('from "@/lib/server/http/withAuth"')) {
    const importAnchor = content.match(/^import .+$/m);
    if (importAnchor) {
      const lines = content.split("\n");
      let lastImportIndex = -1;
      lines.forEach((line, index) => {
        if (line.startsWith("import ")) lastImportIndex = index;
      });
      lines.splice(lastImportIndex + 1, 0, 'import { withAuth } from "@/lib/server/http/withAuth";');
      content = lines.join("\n");
    } else {
      content = `import { withAuth } from "@/lib/server/http/withAuth";\n\n${content}`;
    }
  }

  const exportLines = foundMethods.map((method) => `export const ${method} = withAuth(${method});`).join("\n");
  content = `${content.trim()}\n\n${exportLines}\n`;

  fs.writeFileSync(filePath, content);
  return true;
}

let changed = 0;
for (const file of walk(API_ROOT)) {
  if (wrapFile(file)) {
    changed += 1;
    console.log(`wrapped ${file}`);
  }
}
console.log(`done: ${changed} files`);
