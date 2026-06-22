import { spawn, type ChildProcess } from "child_process";
import readline from "readline";

import { killChildTree } from "@/lib/server/claude/transport";
import { buildCursorEnv } from "@/lib/server/cursorEnv";
import type { RuntimePermissionMode } from "@/types/runtime";

export type CursorAcpJsonRpcMessage = {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

export type CursorAcpSessionPromptResult = {
  stopReason?: string;
};

export type CursorAcpNotificationHandler = (message: CursorAcpJsonRpcMessage) => void | Promise<void>;

export type CursorAcpConnectionOptions = {
  cliPath: string;
  cwd: string;
  onNotification?: CursorAcpNotificationHandler;
  onStderr?: (chunk: string) => void;
  onNotificationError?: (error: unknown, message: CursorAcpJsonRpcMessage) => void;
  signal?: AbortSignal;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const PROMPT_REQUEST_TIMEOUT_MS = 600_000;

export function mapPermissionModeToAcpMode(permissionMode: RuntimePermissionMode) {
  return permissionMode === "readonly" ? "ask" : "agent";
}

export function buildCursorAcpArgs() {
  return ["agent", "acp"] as const;
}

export class CursorAcpConnection {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly child: ChildProcess;
  private readonly notificationChain: Promise<void>[] = [];
  private readonly lineReader: readline.Interface;
  private closed = false;

  constructor(
    child: ChildProcess,
    private readonly options: CursorAcpConnectionOptions,
  ) {
    this.child = child;
    const stdout = child.stdout;
    if (!stdout) {
      throw new Error("Cursor ACP stdout is unavailable");
    }
    this.lineReader = readline.createInterface({ input: stdout });
    this.lineReader.on("line", (line) => {
      void this.handleLine(line);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      options.onStderr?.(chunk.toString("utf8"));
    });
    options.signal?.addEventListener("abort", () => this.close("aborted"), { once: true });
  }

  static connect(options: CursorAcpConnectionOptions) {
    const child = spawn(options.cliPath, [...buildCursorAcpArgs()], {
      cwd: options.cwd,
      env: buildCursorEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    return new CursorAcpConnection(child, options);
  }

  get process() {
    return this.child;
  }

  respond(id: number, result: unknown) {
    this.writeMessage({ jsonrpc: "2.0", id, result });
  }

  async bootstrap() {
    await this.sendRequest("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "kiki", version: "0.1.0" },
    });
    await this.sendRequest("authenticate", { methodId: "cursor_login" });
  }

  async openSession(input: { cwd: string; resumeSessionId?: string }) {
    if (input.resumeSessionId) {
      await this.sendRequest("session/load", {
        sessionId: input.resumeSessionId,
        cwd: input.cwd,
        mcpServers: [],
      });
      return input.resumeSessionId;
    }
    const created = (await this.sendRequest("session/new", {
      cwd: input.cwd,
      mcpServers: [],
    })) as { sessionId?: string };
    if (!created.sessionId) {
      throw new Error("Cursor ACP session/new 未返回 sessionId");
    }
    return created.sessionId;
  }

  async setMode(sessionId: string, permissionMode: RuntimePermissionMode) {
    await this.sendRequest("session/set_mode", {
      sessionId,
      modeId: mapPermissionModeToAcpMode(permissionMode),
    });
  }

  async prompt(sessionId: string, text: string) {
    return (await this.sendRequest(
      "session/prompt",
      {
        sessionId,
        prompt: [{ type: "text", text }],
      },
      PROMPT_REQUEST_TIMEOUT_MS,
    )) as CursorAcpSessionPromptResult;
  }

  async cancel(sessionId: string) {
    try {
      await this.sendRequest("session/cancel", { sessionId }, 15_000);
    } catch {
      // session may already be finished
    }
  }

  request(method: string, params: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    return this.sendRequest(method, params, timeoutMs);
  }

  close(reason?: string) {
    if (this.closed) return;
    this.closed = true;
    this.lineReader.close();
    this.pending.forEach((waiter) => {
      clearTimeout(waiter.timer);
      waiter.reject(new DOMException(reason ?? "Cursor ACP 连接已关闭", "AbortError"));
    });
    this.pending.clear();
    killChildTree(this.child);
  }

  private writeMessage(message: CursorAcpJsonRpcMessage) {
    if (!this.child.stdin?.writable) {
      throw new Error("Cursor ACP stdin is not writable");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private sendRequest(method: string, params: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    if (this.closed) {
      return Promise.reject(new DOMException("Cursor ACP 连接已关闭", "AbortError"));
    }
    const id = this.nextId++;
    this.writeMessage({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiter = this.pending.get(id);
        if (!waiter) return;
        this.pending.delete(id);
        reject(new Error(`Cursor ACP 请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        timer,
      });
    });
  }

  private settleRequest(id: number, result: unknown, error?: CursorAcpJsonRpcMessage["error"]) {
    const waiter = this.pending.get(id);
    if (!waiter) return;
    this.pending.delete(id);
    clearTimeout(waiter.timer);
    if (error) {
      const message = typeof error.message === "string" ? error.message : "Cursor ACP JSON-RPC error";
      waiter.reject(new Error(message));
      return;
    }
    waiter.resolve(result);
  }

  private async handleLine(line: string) {
    let message: CursorAcpJsonRpcMessage;
    try {
      message = JSON.parse(line) as CursorAcpJsonRpcMessage;
    } catch {
      return;
    }

    if (typeof message.id === "number" && (message.result !== undefined || message.error !== undefined)) {
      this.settleRequest(message.id, message.result, message.error);
      return;
    }

    if (!message.method) return;
    const handler = this.options.onNotification;
    if (!handler) return;
    const task = Promise.resolve(handler(message)).catch((error) => {
      this.options.onNotificationError?.(error, message);
      this.options.onStderr?.(
        `Cursor ACP notification failed (${message.method}): ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
    this.notificationChain.push(task);
  }

  async waitForNotifications() {
    await Promise.all(this.notificationChain.splice(0));
  }
}
