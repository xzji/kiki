import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import {
  parseTailLineCount,
  readLastLogLines,
  runDaemonLogMode,
  type DaemonLogPaths,
} from "./logMode";

function makeWriteSink() {
  const chunks: string[] = [];
  return {
    chunks,
    stream: {
      write(chunk: string | Buffer) {
        chunks.push(String(chunk));
        return true;
      },
    } as NodeJS.WriteStream,
  };
}

export async function runDaemonLogModeSpecs() {
  assert.equal(parseTailLineCount(undefined), 200);
  assert.equal(parseTailLineCount("3"), 3);
  assert.equal(parseTailLineCount("0"), 200);
  assert.equal(parseTailLineCount("20000"), 10_000);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kiki-daemon-log-mode-"));
  try {
    const paths: DaemonLogPaths = {
      logsDir: root,
      daemonLog: path.join(root, "daemon.log"),
      stdoutLog: path.join(root, "daemon.stdout.log"),
      stderrLog: path.join(root, "daemon.stderr.log"),
    };
    fs.writeFileSync(paths.daemonLog, "one\ntwo\nthree\n", "utf8");

    assert.equal(readLastLogLines(paths.daemonLog, 2), "two\nthree\n");
    assert.equal(readLastLogLines(path.join(root, "missing.log"), 2), "");

    const output = makeWriteSink();
    await runDaemonLogMode({
      paths,
      lines: 1,
      follow: false,
      output: output.stream,
      errorOutput: makeWriteSink().stream,
    });

    const text = output.chunks.join("");
    assert.ok(text.includes("进入 kiki-daemon log 模式"));
    assert.ok(text.includes(paths.daemonLog));
    assert.ok(text.includes("three\n"));
    assert.ok(!text.includes("two\n"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
