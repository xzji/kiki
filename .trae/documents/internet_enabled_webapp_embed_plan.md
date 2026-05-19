# 小应用联网与外部嵌入支持规划

## v1.1 Review Update：遗漏问题复查

本次复查发现：原方案方向正确，但有几个关键遗漏必须补齐，否则会出现“表面允许互联网，实际破坏隔离边界”的问题。

### 1. 最大遗漏：`connect-src https:` 不能直接代表“任意互联网”

原方案里建议联网 webapp 使用：

```http
connect-src https:
```

这存在冲突：

- 它会允许访问所有 HTTPS 地址。
- 如果 KiKi 生产环境本身也是 HTTPS，那么 KiKi 自己的 `/api/...` 也属于 HTTPS。
- 这和“不能直接访问 KiKi 内部 API”的目标冲突。

即使 iframe 没有 `allow-same-origin`，脚本仍可能发起请求。浏览器的 CORS 可能阻止读取响应，但请求本身仍可能到达服务端。对某些副作用接口，这仍然是不合适的。

修正决策：

第一版不要让生成 HTML 直接拥有任意 `fetch` 能力。

拆成两条路径：

```txt
外部展示类资源
  -> 允许 iframe/img/video/audio 加载 HTTPS 公网资源
  -> 用 CSP 控制 frame-src/img-src/media-src

数据请求类资源
  -> 不直接开放 connect-src https:
  -> 通过宿主提供 KikiBridge.fetchInternet 或后端代理 API
  -> 代理层阻断 KiKi origin、localhost、内网 IP、file/data/javascript 等危险目标
```

也就是说：

- YouTube、公开网页 iframe、远程图片、远程音视频：可以直接嵌入或加载。
- 小应用要请求公网 JSON/API：走受控代理。
- 小应用仍不能直接 `fetch('/api/runtime/state')` 或 `fetch('https://kiki.example.com/api/...')`。

### 2. “任意互联网信息”不能等同于“任意网页都能 iframe”

系统可以尝试嵌入任意 HTTPS URL，但不能保证成功。

目标站点可能禁止：

- `X-Frame-Options: DENY`
- `X-Frame-Options: SAMEORIGIN`
- `Content-Security-Policy: frame-ancestors 'none'`
- 登录态、反机器人、地区限制

修正决策：

UI 和 prompt 都要明确：

```txt
KiKi 支持尝试嵌入公网内容；如果目标网站禁止嵌入，则降级为外部打开。
```

不能承诺“任何网页都能嵌入显示”。

### 3. 远程脚本不应第一版默认允许

原方案的联网 CSP 示例包含：

```http
script-src 'unsafe-inline' https:
```

这会允许模型生成 HTML 加载任意远程 JS。即使 sandbox 隔离了 KiKi 权限，远程脚本仍可能：

- 窃取用户在小应用内输入的数据。
- 注入广告或恶意 UI。
- 让小应用行为不可复现。

修正决策：

第一版联网 webapp 仍然不允许远程 script：

```http
script-src 'unsafe-inline'
```

允许的互联网信息优先是：

- 图片：`img-src https: data: blob:`
- 音视频：`media-src https: data: blob:`
- 外部 iframe：`frame-src https:`
- 数据请求：通过受控代理，不直接 `connect-src https:`

如果未来需要远程脚本，必须作为单独能力开关，并配合来源 allowlist。

### 4. 外部 iframe 的交互状态不能像本地 webapp 一样完整保存

本地生成 HTML 可以调用：

```js
window.KikiBridge.patchState(...)
```

但 YouTube 或任意第三方网页不能被要求调用 KiKiBridge。

因此：

- 对 `webapp`，可以保存用户在小应用内的表单、选择、计算结果。
- 对 `external_embed`，第一版只能保存 KiKi 外层可观察的状态，例如“用户打开了该嵌入”“用户点击外部打开”“用户标记已看完”。
- 不能承诺保存用户在 YouTube iframe 内部的播放进度、暂停、点赞等第三方内部状态，除非 provider 明确提供 postMessage API 并单独适配。

修正决策：

`external_embed` 的状态保存第一版只做外层 wrapper 状态，不做第三方内部状态。

### 5. 需要新增联网代理，而不是只改 CSP

为了同时满足“可访问互联网信息”和“不访问 KiKi 内部 API”，需要新增受控代理：

```txt
iframe webapp
  -> postMessage: internet.fetch
  -> SandboxedWebAppSurface 校验
  -> POST /api/artifacts/[id]/internet-fetch
  -> 服务端校验 URL
  -> 服务端 fetch 公网资源
  -> 返回 JSON/text 摘要给宿主
  -> 宿主 postMessage 回 iframe
```

代理必须限制：

- 只允许 `https://`
- 禁止当前 KiKi origin
- 禁止 localhost
- 禁止私网 IP
- 禁止 link-local / multicast / metadata IP
- 限制响应大小
- 限制 content-type
- 限制超时
- 不转发 KiKi cookie
- 不转发用户浏览器 cookie
- 不允许任意 request headers

这比直接开放 `connect-src https:` 更符合用户目标。

### 6. URL 校验必须防 DNS rebinding / 私网绕过

仅检查字符串不够。

例如：

- `https://localhost.example.com`
- DNS 解析到 `127.0.0.1`
- DNS 解析到 `192.168.x.x`
- IPv6 loopback / link-local
- 十进制/八进制/IPv6 混写 IP

修正决策：

第一版至少做：

- URL protocol 校验。
- hostname 明确禁止 localhost 类。
- IP literal 禁止私网。
- 对普通域名，服务端 fetch 前后检查最终 URL。
- 重定向次数限制，并校验每次重定向后的 URL。

MVP 可以先不做完整 DNS 解析拦截，但必须在计划中标注为安全缺口；更推荐实现 DNS 解析后的私网阻断。

### 7. 外部内容需要“点击后加载”选项

如果一打开任务结果就加载 YouTube/第三方网站，会立刻向第三方泄露：

- IP
- User-Agent
- Referer 或 origin 信息
- 访问时间

修正决策：

`ExternalEmbedSurface` 默认采用轻量卡片：

```txt
外部内容：youtube.com
[加载嵌入内容] [新窗口打开]
```

用户点击“加载嵌入内容”后才创建 iframe。

第一版可以对 demo 默认加载，但产品默认建议点击后加载。

### 8. 需要 Permissions-Policy 与 referrerPolicy

外部 iframe 和联网小应用都应减少浏览器能力暴露。

补充：

```tsx
referrerPolicy="strict-origin-when-cross-origin"
```

preview API 可增加响应头：

```http
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
```

YouTube external embed 按需允许：

```tsx
allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
```

但本地 webapp 不需要这些能力。

### 9. prompt 必须避免让模型误以为能调用 KiKi API

联网后模型可能在 HTML 中生成：

```js
fetch('/api/...')
```

修正决策：

prompt 必须明确：

- 禁止调用任何 `/api/...`、`localhost`、内网地址、当前页面 origin。
- 需要公网数据时调用 `window.KikiBridge.fetchInternet(url)`。
- 用户状态保存仍调用 `patchState/saveState`。

### 10. 验证项需要增加负向安全测试

原验证只测“公网可访问”，还不够。

必须增加：

- `fetch('/api/runtime/state')` 不成功。
- `KikiBridge.fetchInternet('/api/runtime/state')` 被拒绝。
- `KikiBridge.fetchInternet('http://localhost:3001/api/runtime/state')` 被拒绝。
- `KikiBridge.fetchInternet('https://127.0.0.1/...')` 被拒绝。
- YouTube 可加载或提供外部打开降级。
- 被 `frame-ancestors` 禁止的网站显示降级提示。

## Summary

目标是让交互渲染区不仅能运行本地生成的 HTML 小应用，还能加载互联网上的信息，同时继续保证：

* 不能随意访问 KiKi 页面 DOM。

* 不能读取 KiKi cookie。

* 不能读取 KiKi localStorage。

* 不能直接调用 KiKi 内部 API。

* 用户与小应用的有效交互状态仍通过受控通道保存。

结论：

这件事可以支持，但不能简单把当前 `webapp` 的 sandbox/CSP 全部放开。正确做法是引入“网络访问策略”和“外部嵌入类型”，把不同风险级别的内容分开处理。

建议第一版支持两类：

1. `webapp` 的联网模式：模型生成的 HTML 小应用可以加载公网图片、音视频、iframe；公网 API/JSON/text 读取通过受控代理完成，仍不能直接访问 KiKi。
2. `external_embed`：专门嵌入 YouTube、公开网页、地图、在线文档等外部 iframe。

需要明确的限制：

* KiKi 可以允许 iframe 访问互联网，但不能保证所有网站都能被 iframe 嵌入。

* 很多网站会通过 `X-Frame-Options` 或 `Content-Security-Policy: frame-ancestors` 禁止被第三方嵌入。

* 对这类网站，只能降级为“外部打开链接”，不能强行嵌入。

## Current State Analysis

### 1. 当前小应用是离线安全模式

文件：

* `src/components/execution/SandboxedWebAppSurface.tsx`

* `src/app/api/artifacts/[id]/preview/route.ts`

当前 iframe：

```tsx
<iframe
  sandbox="allow-scripts"
  src={previewUrl}
/>
```

当前 preview CSP：

```http
default-src 'none';
script-src 'unsafe-inline';
style-src 'unsafe-inline';
img-src data: blob:;
font-src data:;
media-src data: blob:;
connect-src 'none';
frame-ancestors 'self';
base-uri 'none';
form-action 'none';
```

这意味着：

* HTML 小应用可以运行内联 JS。

* 不能发起 `fetch` 到互联网。

* 不能加载远程图片、远程脚本、远程 iframe。

* 不能直接访问 KiKi 内部 API。

* 不能访问父页面 DOM。

这是一个适合“模型生成 HTML + 本地交互状态保存”的安全默认模式，但不适合 YouTube 或联网内容。

### 2. 当前 Artifact 类型只有 `webapp`

文件：

* `src/types/artifact.ts`

* `src/lib/server/repositories/artifactsRepository.ts`

* `src/lib/server/workspace/artifactStorage.ts`

当前 `ArtifactKind`：

```ts
export type ArtifactKind = "text_block" | "file" | "external_link" | "webapp";
```

问题：

* `webapp` 同时承担“本地 HTML 小应用运行区”。

* 还没有表达“外部网页/视频嵌入”的类型。

* 还没有表达网络权限策略。

### 3. 当前 prompt 明确禁止远程资源

文件：

* `src/lib/taskResult/schemaForPrompt.ts`

当前 `WEBAPP_ARTIFACT_PROMPT_FRAGMENT` 要求：

```txt
html 必须是完整单文件 HTML，内联 CSS/JS，不要引用远程 script，不要依赖 npm install 或构建。
```

这需要改成“按网络策略区分”：

* `offline`：仍禁止远程资源。

* `internet`：允许公网图片、音视频、iframe、fetch，但禁止 KiKi 内部 API。

* `external_embed`：不生成 HTML，而是返回外部嵌入 URL。

## 这会有什么问题

### 1. 不是所有互联网内容都能嵌入

即使 KiKi 允许：

```tsx
<iframe src="https://example.com" />
```

目标网站仍可能拒绝：

* `X-Frame-Options: DENY`

* `X-Frame-Options: SAMEORIGIN`

* `Content-Security-Policy: frame-ancestors 'none'`

* `Content-Security-Policy: frame-ancestors 'self'`

结果：

* iframe 空白。

* 浏览器 console 报 frame 被拒绝。

* KiKi 无法绕过。

处理方式：

* UI 显示“该网站禁止嵌入，可在新窗口打开”。

* 提供外部打开按钮。

* 对 YouTube 这类支持 embed 的站点，使用官方 embed URL。

### 2. 互联网内容可能跟踪用户

如果嵌入 YouTube、地图、第三方网站：

* 对方可能设置自己的 cookie。

* 对方可能记录用户 IP、User-Agent、播放行为。

* 对方可能加载广告、统计脚本。

但只要不加 `allow-same-origin` 给 KiKi 同源内容，第三方无法读取 KiKi 的 DOM/cookie/localStorage。

处理方式：

* 外部嵌入区显示来源域名。

* 对外部 embed 使用明确标签，例如“外部内容，由 youtube.com 提供”。

* 可选增加“点击后加载”模式，避免页面打开就请求第三方。

### 3. 不应直接放开 `connect-src`

如果允许：

```http
connect-src https:
```

小应用可以请求任意 HTTPS API，包括生产环境下同样是 HTTPS 的 KiKi 自身 API。

它仍然不能直接读 KiKi DOM/localStorage，但可能：

* 把用户在小应用内输入的数据发给第三方。

* 请求恶意站点。

* 加载不可控内容。

* 向 KiKi 内部 API 发出请求，形成不可接受的边界绕过风险。

修正处理方式：

* 第一版不直接开放 `connect-src https:`。

* HTML 内的公网数据请求通过 `window.KikiBridge.fetchInternet(url)` 发给宿主。

* 宿主调用 `/api/artifacts/[id]/internet-fetch`，由服务端做 URL 安全校验后再请求公网。

* 代理不转发 KiKi cookie，不接受任意 headers，不允许访问当前 KiKi origin、localhost 或内网 IP。

* 对 state 保存仍只走宿主 `KikiBridge.patchState/saveState`。

### 4. 不能用 `allow-same-origin` 运行模型生成 HTML

如果对模型生成 HTML 加：

```tsx
sandbox="allow-scripts allow-same-origin"
```

风险会显著增加。即使 preview URL 是 `/api/artifacts/[id]/preview`，它会获得同源能力，更容易访问同源资源。

建议：

* 对模型生成的 `webapp`：继续不加 `allow-same-origin`。

* 对外部 `external_embed`：可以按 provider 使用 `allow-same-origin`，因为它本来就是第三方 origin，不是 KiKi origin。

### 5. “任何互联网信息”需要定义边界

系统可以支持“尝试加载任意 HTTPS 公网信息”，但不能承诺：

* 任意网页都可 iframe 嵌入。

* 任意 API 都允许跨域 fetch。

* 任意网站都能在 sandbox 中正常运行。

更准确的产品表述应是：

```txt
交互区支持联网资源和外部嵌入；如果目标网站因自身安全策略禁止嵌入，KiKi 会降级为外部打开。
```

## Proposed Changes

### 1. 类型层增加网络策略与外部嵌入类型

修改文件：

* `src/types/artifact.ts`

新增：

```ts
export type ArtifactKind =
  | "text_block"
  | "file"
  | "external_link"
  | "webapp"
  | "external_embed";

export type WebAppNetworkPolicy = "offline" | "internet";

export type WebAppManifest = {
  schemaVersion: 1;
  title: string;
  description?: string;
  bridgeVersion: 1;
  capabilities: Array<"state.read" | "state.write" | "event.emit" | "height.report">;
  networkPolicy?: WebAppNetworkPolicy;
  allowedHosts?: string[];
  initialState?: Record<string, unknown>;
};

export type ExternalEmbedProvider =
  | "youtube"
  | "generic";

export type ExternalEmbedArtifact = ArtifactCommon & {
  kind: "external_embed";
  url: string;
  embedUrl: string;
  provider: ExternalEmbedProvider;
  allowFullScreen?: boolean;
};
```

`ArtifactRef` 增加：

```ts
provider?: "youtube" | "generic";
embedUrl?: string;
surfaceKind?: "webapp" | "external_embed";
```

### 2. 数据库支持 embed 元数据

修改文件：

* `src/lib/server/db/schema.ts`

* `src/lib/server/repositories/artifactsRepository.ts`

当前 `artifacts` 表已有：

```sql
url TEXT
manifest_json TEXT
```

建议新增：

```sql
embed_url TEXT
provider TEXT
```

Schema version 升级到下一版，例如 `6`。

`artifactsRepository` 增加：

* `external_embed` 行到类型的映射。

* `provider` / `embed_url` 的读写。

* `manifest_json` 继续用于 `webapp` 网络策略。

### 3. WebApp preview CSP 根据网络策略动态生成

修改文件：

* `src/app/api/artifacts/[id]/preview/route.ts`

当前只有一个 `WEBAPP_CSP`，需要拆成：

```ts
function buildWebAppCsp(policy: WebAppNetworkPolicy) {
  if (policy === "internet") {
    return [
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
  }

  return offlineCsp;
}
```

仍然保持：

* 不允许 `allow-same-origin`。

* 不允许直接访问 KiKi 内部 API。

* 不允许 `form-action`。

* 不允许 `base-uri`。

数据请求规则：

* 第一版不开放浏览器原生 `connect-src https:`。

* 公网数据读取通过 `KikiBridge.fetchInternet(url)` 和后端代理完成。

* 后端代理负责阻断 KiKi origin、localhost、内网 IP、重定向到危险地址等情况。

* M2 可增加 `allowedHosts` 白名单或按任务显式授权的 host 列表。

### 4. iframe sandbox 根据 surface 类型分开

修改文件：

* `src/components/execution/SandboxedWebAppSurface.tsx`

* 新增 `src/components/execution/ExternalEmbedSurface.tsx`

* 修改 `src/components/task/GenericAgentResultView.tsx`

#### webapp internet 模式

继续：

```tsx
<iframe
  sandbox="allow-scripts"
  src={previewUrl}
/>
```

原因：

* 允许小应用脚本运行。

* 不给同源权限。

* 小应用仍不能读取 KiKi DOM/cookie/localStorage。

#### external\_embed 模式

新增：

```tsx
<iframe
  sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
  allowFullScreen
  referrerPolicy="strict-origin-when-cross-origin"
  src={embedUrl}
/>
```

说明：

* 这是给 YouTube 等第三方 iframe 用的。

* 这里的 `allow-same-origin` 是第三方自己的 origin，不是 KiKi origin。

* 不应把这套权限给模型生成的 KiKi preview HTML。

### 5. URL 规范化与安全校验

新增或修改文件：

* `src/lib/server/workspace/artifactStorage.ts`

* `src/lib/server/externalEmbed.ts`

实现：

```ts
normalizeExternalEmbedUrl(url)
```

规则：

* 只允许 `https://`。

* 禁止 `javascript:`、`data:`、`file:`。

* 禁止 `localhost`、`127.0.0.1`、`0.0.0.0`、`::1`。

* 禁止内网地址段：

  * `10.0.0.0/8`

  * `172.16.0.0/12`

  * `192.168.0.0/16`

  * link-local 地址

* YouTube URL 转换为官方 embed URL：

```txt
https://www.youtube.com/watch?v=VIDEO_ID
-> https://www.youtube.com/embed/VIDEO_ID
```

支持：

* `youtube.com/watch?v=...`

* `youtu.be/...`

* `youtube.com/embed/...`

### 6. 新增受控公网数据代理

新增文件：

* `src/app/api/artifacts/[id]/internet-fetch/route.ts`

新增或复用工具：

* `src/lib/server/network/safeInternetFetch.ts`

目的：

* 让联网 webapp 可以读取公网 JSON/text 信息。

* 避免直接开放 `connect-src https:`。

* 避免小应用直接访问 KiKi 内部 API 或内网资源。

请求格式：

```json
{
  "url": "https://example.com/data.json",
  "responseType": "json"
}
```

响应格式：

```json
{
  "ok": true,
  "url": "https://example.com/data.json",
  "contentType": "application/json",
  "body": {}
}
```

限制：

* 只允许 `GET`。

* 只允许 `https://`。

* 不转发浏览器 cookie。

* 不接受自定义认证 header。

* 超时建议 `8s`。

* 响应大小建议 `256KB`。

* 重定向最多 `3` 次，每次重定向后都重新校验 URL。

* 阻断当前 KiKi origin、localhost、内网 IP、link-local、metadata IP。

前端 bridge：

```js
window.KikiBridge.fetchInternet(url, options)
```

消息类型：

```txt
internet.fetch
internet.fetch.result
internet.fetch.error
```

`SandboxedWebAppSurface` 接收到 `internet.fetch` 后：

* 校验 message 来源仍是当前 iframe。

* 校验 `artifactId` 和 `bridgeVersion`。

* 调用 `/api/artifacts/[id]/internet-fetch`。

* 把结果通过 `postMessage` 回传给 iframe。

### 7. Prompt 协议扩展

修改文件：

* `src/lib/taskResult/schemaForPrompt.ts`

* `src/lib/server/goalTaskPrompt.ts`

新增两种返回格式。

#### 联网 webapp

```json
{
  "webapp": {
    "title": "联网资料看板",
    "description": "加载公开 API 或公开媒体资源",
    "networkPolicy": "internet",
    "html": "<!doctype html>...",
    "initialState": {}
  },
  "task_result": {
    "meta": {
      "surfaces": ["interactive"],
      "interactiveSurfaceKind": "webapp"
    }
  }
}
```

要求：

* 可加载公网 HTTPS 展示资源，例如图片、音视频和外部 iframe。

* 不要调用 KiKi 内部 API。

* 不要直接使用 `fetch("https://...")`。

* 需要公网 JSON/text 数据时使用 `window.KikiBridge.fetchInternet(url)`。

* 用户状态仍通过 `window.KikiBridge` 保存。

#### 外部嵌入

```json
{
  "external_embed": {
    "title": "YouTube 视频",
    "url": "https://www.youtube.com/watch?v=...",
    "provider": "youtube"
  },
  "task_result": {
    "meta": {
      "surfaces": ["interactive"],
      "interactiveSurfaceKind": "webapp"
    }
  }
}
```

Runner 会把它转换为 `external_embed` artifact。

### 8. Runner 解析与持久化

修改文件：

* `src/lib/server/goalTaskRunner.ts`

* `src/lib/taskResult/parseAndRepair.ts`

* `src/lib/taskResult/localValidation.ts`

新增：

```ts
extractExternalEmbedSpec(finalMessage)
persistExternalEmbedArtifact(input)
```

逻辑：

* 如果返回 `webapp.networkPolicy = "internet"`，保存为 `webapp`，manifest 写入 `networkPolicy: "internet"`。

* 如果返回 `external_embed`，保存为 `external_embed` artifact。

* `taskResult.artifactRefs` 增加对应 ref。

* `interactiveSurfaceKind` 可以继续用 `"webapp"`，但 `ArtifactRef.surfaceKind` 标记为 `"external_embed"`。

校验更新：

* interactive surface 可以由以下任一满足：

  * blocks

  * webapp artifact

  * external\_embed artifact

  * 原始输出中有 `webapp.html`

  * 原始输出中有 `external_embed.url`

### 9. 前端渲染入口

修改文件：

* `src/components/task/GenericAgentResultView.tsx`

* `src/components/execution/ArtifactRenderer.tsx`

* `src/components/conversation/TaskMessageCard.tsx`

逻辑：

```tsx
const externalEmbedRef = taskResult.artifactRefs?.find((ref) => ref.kind === "external_embed");
if (externalEmbedRef) return <ExternalEmbedSurface artifact={externalEmbedRef} />;

const webappRef = taskResult.artifactRefs?.find((ref) => ref.kind === "webapp");
if (webappRef) return <SandboxedWebAppSurface artifact={webappRef} />;
```

UI：

* webapp 标签：`可执行小应用`

* external embed 标签：`外部嵌入`

* internet webapp 标签：`联网小应用`

外部嵌入失败时：

* 显示说明：`该网站可能禁止被嵌入，可在新窗口打开`

* 提供外部打开按钮。

### 9. Mock Demo

修改文件：

* `src/mocks/goals.ts`

* `src/mocks/conversations.ts`

新增两个 demo：

1. YouTube 外部嵌入 demo：

```txt
inst-surface-demo-youtube
```

1. 联网 webapp demo：

```txt
inst-surface-demo-internet-webapp
```

第一版如果只做一个，优先做 YouTube，因为能直接验证 iframe embed。

## Assumptions & Decisions

### 已锁定

* 需要支持互联网上的信息加载。

* 仍不允许小应用直接访问 KiKi DOM/cookie/localStorage/internal API。

* `webapp` 和 `external_embed` 必须分开，因为安全模型不同。

* 模型生成 HTML 即使联网，也不加 `allow-same-origin`。

* 外部第三方 iframe 可以按 provider 加更宽松 sandbox。

* 所有 KiKi 状态保存仍通过 `KikiBridge`，而不是 iframe 直接调用 KiKi API。

### 第一版支持

* HTTPS 公网资源。

* YouTube embed。

* 通用外部 iframe embed。

* 联网 webapp 的远程图片、音视频、iframe。

* 联网 webapp 通过 `KikiBridge.fetchInternet` 读取公网 JSON/text。

* 被禁止嵌入时降级为外部打开。

### 第一版不支持

* 绕过目标网站的 `X-Frame-Options` / `frame-ancestors`。

* 嵌入 HTTP 非加密资源。

* 访问 localhost / 内网 IP。

* 外部 iframe 读取或写入 KiKi state。

* 第三方网站直接调用 KiKi API。

## Verification Steps

### 静态检查

运行：

```bash
pnpm tsc --noEmit
```

检查 diagnostics：

* `src/types/artifact.ts`

* `src/app/api/artifacts/[id]/preview/route.ts`

* `src/components/execution/SandboxedWebAppSurface.tsx`

* `src/components/execution/ExternalEmbedSurface.tsx`

* `src/lib/server/goalTaskRunner.ts`

### API 验证

验证 webapp internet preview：

* `GET /api/artifacts/[id]/preview`

* 响应 CSP 包含：

  * `connect-src 'none'`

  * `img-src data: blob: https:`

  * `frame-src https:`

验证 internet fetch 代理：

* `POST /api/artifacts/[id]/internet-fetch` 可读取 `https://example.com`。

* 代理不转发 KiKi cookie。

* 代理限制响应大小和超时。

验证外部 embed artifact：

* repository 能保存 `external_embed`

* `ArtifactRef` 包含 `embedUrl/provider`

### UI 验证

打开：

```txt
http://localhost:3001/conversations/conv-goal-toefl
```

验证：

* YouTube demo 在右侧结果边栏中以 iframe 展示。

* 支持全屏按钮。

* 显示来源域名。

* 如果 iframe 加载失败，有“新窗口打开”降级按钮。

* 小应用仍不能访问 KiKi DOM/localStorage。

### 安全验证

在联网 webapp 内测试：

```js
parent.document.body
```

预期失败。

测试：

```js
fetch('/api/runtime/state')
```

预期失败。

测试公网：

```js
window.KikiBridge.fetchInternet('https://example.com')
```

预期通过受控代理返回文本或 JSON。

测试内部 API：

```js
window.KikiBridge.fetchInternet('/api/runtime/state')
window.KikiBridge.fetchInternet('http://localhost:3001/api/runtime/state')
window.KikiBridge.fetchInternet('https://127.0.0.1/')
```

预期全部被拒绝。

测试嵌入：

```html
<iframe src="https://www.youtube.com/embed/..."></iframe>
```

预期可展示。

## Implementation Order

1. 扩展 `ArtifactKind`、`ArtifactRef`、`WebAppManifest` 网络策略和 `ExternalEmbedArtifact` 类型。
2. 升级数据库 schema，支持 `embed_url/provider`。
3. repository 支持 `external_embed` 读写。
4. storage 增加 `persistExternalEmbedArtifact()` 和 URL 规范化。
5. preview API 按 `manifest.networkPolicy` 动态生成 CSP。
6. 新增 `/api/artifacts/[id]/internet-fetch` 受控公网代理。
7. `SandboxedWebAppSurface` 增加 `KikiBridge.fetchInternet` 消息处理。
8. 新增 `ExternalEmbedSurface`。
9. `GenericAgentResultView` 接入 external embed 和 internet webapp。
10. prompt/runner/validation/normalize 支持 `external_embed` 与 `webapp.networkPolicy`。
11. 增加 YouTube demo 和联网 webapp demo。
12. 跑类型检查、diagnostics、页面和 API 验证。
