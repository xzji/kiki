import fs from "fs";
import { NextResponse } from "next/server";

import { getArtifactById } from "@/lib/server/repositories/artifactsRepository";
import { resolveWebAppEntryPath } from "@/lib/server/workspace/artifactStorage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WEBAPP_OFFLINE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const WEBAPP_INTERNET_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline' https:",
  "img-src data: blob: https:",
  "font-src data: https:",
  "media-src data: blob: https:",
  "frame-src https:",
  "connect-src 'none'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const WEBAPP_PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), payment=()";

function webAppHeaders(csp: string) {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": csp,
    "Permissions-Policy": WEBAPP_PERMISSIONS_POLICY,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };
}

const MOCK_WEBAPP_ID = "artifact-demo-webapp-1778950506965";
const MOCK_INTERNET_WEBAPP_ID = "artifact-demo-internet-webapp-1778950506965";

function mockWebAppHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 20px; color: #1f2328; background: #fff; }
    label { display: block; margin: 12px 0 6px; font-size: 13px; color: #4b5563; }
    input { width: 100%; box-sizing: border-box; border: 1px solid #d0d7de; border-radius: 10px; padding: 10px 12px; font-size: 14px; }
    .card { border: 1px solid #dde7ff; border-radius: 16px; padding: 16px; background: #f8fbff; }
    .result { margin-top: 14px; border-radius: 12px; background: #eef6ff; padding: 12px; font-weight: 600; color: #0d47a1; }
  </style>
</head>
<body>
  <div class="card">
    <h2>预算计算器</h2>
    <label>总预算</label>
    <input id="budget" type="number" value="300000">
    <label>每月上限</label>
    <input id="monthly" type="number" value="6000">
    <div id="result" class="result"></div>
  </div>
  <script>
    (() => {
      const ARTIFACT_ID = "${MOCK_WEBAPP_ID}";
      let latestState = { budget: 300000, monthlyLimit: 6000 };
      const post = (message) => window.parent.postMessage({ source: "kiki-webapp", artifactId: ARTIFACT_ID, bridgeVersion: 1, ...message }, "*");
      window.KikiBridge = {
        ready() { post({ type: "ready" }); },
        saveState(state, event) { latestState = state || {}; post({ type: "state.replace", state: latestState, event }); },
        patchState(patch, event) { latestState = { ...latestState, ...(patch || {}) }; post({ type: "state.patch", patch, state: latestState, event }); },
        reportHeight(height) { post({ type: "height.report", height }); }
      };
      window.addEventListener("message", (event) => {
        const message = event.data;
        if (!message || message.source !== "kiki-host" || message.artifactId !== ARTIFACT_ID) return;
        if (message.type === "state.init") window.dispatchEvent(new CustomEvent("kiki:state", { detail: message.state || latestState }));
      });
      window.addEventListener("DOMContentLoaded", () => {
        window.KikiBridge.ready();
        window.KikiBridge.reportHeight(document.documentElement.scrollHeight);
      });
    })();
  </script>
  <script>
    const budget = document.getElementById("budget");
    const monthly = document.getElementById("monthly");
    const result = document.getElementById("result");
    function render() {
      const b = Number(budget.value || 0);
      const m = Number(monthly.value || 0);
      const months = m > 0 ? Math.ceil(b / m) : 0;
      result.textContent = months ? "预计 " + months + " 个月完成预算目标" : "请输入每月上限";
      window.KikiBridge.patchState({ budget: b, monthlyLimit: m, estimatedMonths: months }, { type: "budget.change", payload: { budget: b, monthlyLimit: m } });
    }
    window.addEventListener("kiki:state", (event) => {
      const state = event.detail || {};
      if (state.budget) budget.value = state.budget;
      if (state.monthlyLimit) monthly.value = state.monthlyLimit;
      render();
    });
    budget.addEventListener("input", render);
    monthly.addEventListener("input", render);
    render();
  </script>
</body>
</html>`;
}

function mockInternetWebAppHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 20px; color: #1f2328; background: #fff; }
    .card { border: 1px solid #bfdbfe; border-radius: 16px; padding: 16px; background: #f8fbff; }
    button { border: 1px solid #0d47a1; background: #0d47a1; color: white; border-radius: 10px; padding: 9px 12px; cursor: pointer; }
    pre { white-space: pre-wrap; margin-top: 12px; border-radius: 12px; background: #eef6ff; padding: 12px; color: #0d47a1; }
  </style>
</head>
<body>
  <div class="card">
    <h2>联网资料卡</h2>
    <p>点击后通过 KiKi 受控代理读取公网文本，不直接访问 KiKi API。</p>
    <button id="load">读取 example.com</button>
    <pre id="output">尚未读取</pre>
  </div>
  <script>
    (() => {
      const ARTIFACT_ID = "${MOCK_INTERNET_WEBAPP_ID}";
      const post = (message) => window.parent.postMessage({ source: "kiki-webapp", artifactId: ARTIFACT_ID, bridgeVersion: 1, ...message }, "*");
      window.KikiBridge = {
        ready() { post({ type: "ready" }); },
        patchState(patch, event) { post({ type: "state.patch", patch, event }); },
        reportHeight(height) { post({ type: "height.report", height }); },
        fetchInternet(url, options) {
          return new Promise((resolve, reject) => {
            const requestId = "internet-" + Date.now();
            const listener = (event) => {
              const message = event.data;
              if (!message || message.source !== "kiki-host" || message.artifactId !== ARTIFACT_ID || message.requestId !== requestId) return;
              if (message.type === "internet.fetch.result") { window.removeEventListener("message", listener); resolve(message.result); }
              if (message.type === "internet.fetch.error") { window.removeEventListener("message", listener); reject(new Error(message.reason || "公网请求失败")); }
            };
            window.addEventListener("message", listener);
            post({ type: "internet.fetch", requestId, url, options });
          });
        }
      };
      window.addEventListener("DOMContentLoaded", () => {
        const output = document.getElementById("output");
        document.getElementById("load").addEventListener("click", async () => {
          output.textContent = "读取中...";
          try {
            const result = await window.KikiBridge.fetchInternet("https://example.com", { responseType: "text" });
            output.textContent = String(result.body || "").slice(0, 500);
            window.KikiBridge.patchState({ lastFetchedUrl: result.url, contentType: result.contentType }, { type: "internet.fetch.demo" });
          } catch (error) {
            output.textContent = error.message || "读取失败";
          }
        });
        window.KikiBridge.ready();
        window.KikiBridge.reportHeight(document.documentElement.scrollHeight);
      });
    })();
  </script>
</body>
</html>`;
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const artifact = getArtifactById(id);
  if (!artifact) {
    if (id === MOCK_WEBAPP_ID) return new Response(mockWebAppHtml(), { headers: webAppHeaders(WEBAPP_OFFLINE_CSP) });
    if (id === MOCK_INTERNET_WEBAPP_ID) return new Response(mockInternetWebAppHtml(), { headers: webAppHeaders(WEBAPP_INTERNET_CSP) });
    return NextResponse.json({ ok: false, reason: "产物不存在" }, { status: 404 });
  }
  if (artifact.kind !== "webapp") {
    return NextResponse.json({ ok: false, reason: "产物不是可执行小应用" }, { status: 400 });
  }

  const filePath = resolveWebAppEntryPath(artifact);
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ ok: false, reason: "小应用入口文件不存在" }, { status: 404 });
  }

  return new Response(fs.readFileSync(filePath, "utf8"), {
    headers: webAppHeaders(artifact.manifest?.networkPolicy === "internet" ? WEBAPP_INTERNET_CSP : WEBAPP_OFFLINE_CSP),
  });
}
