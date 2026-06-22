import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseReclaimSqliteArgs, pathForUserDatabase } from "../../../../scripts/reclaim-sqlite";

export function runStorageMaintenanceScriptArgsSpecs() {
  const cwd = "/repo";

  assert.deepEqual(pathForUserDatabase("user-1", {}, cwd), path.join("/repo", "data", "users", "user-1", "kiki.db"));
  assert.deepEqual(
    pathForUserDatabase("user-1", { KIKI_DATA_DIR: " /var/kiki " }, cwd),
    path.join("/var/kiki", "users", "user-1", "kiki.db"),
  );

  assert.deepEqual(parseReclaimSqliteArgs(["--user", "user-1"], {}, cwd), {
    ok: true,
    apply: false,
    userId: "user-1",
    dbPath: path.join("/repo", "data", "users", "user-1", "kiki.db"),
  });

  assert.deepEqual(parseReclaimSqliteArgs(["--path", "data/users/user-1/kiki.db", "--apply"], {}, cwd), {
    ok: true,
    apply: true,
    dbPath: path.join("/repo", "data", "users", "user-1", "kiki.db"),
  });

  assert.equal(parseReclaimSqliteArgs([], {}, cwd).ok, false);
  assert.equal(parseReclaimSqliteArgs(["--user", "user-1", "--path", "kiki.db"], {}, cwd).ok, false);
  assert.equal(parseReclaimSqliteArgs(["--user"], {}, cwd).ok, false);
  assert.equal(parseReclaimSqliteArgs(["--bogus"], {}, cwd).ok, false);

  console.log("storageMaintenanceScriptArgs specs passed");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStorageMaintenanceScriptArgsSpecs();
}
