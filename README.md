# pi-openai-server-compaction

`pi-openai-server-compaction` 是一个面向 [Pi](https://pi.dev) coding agent 的 OpenAI Responses 服务端压缩扩展。它为兼容的模型接入 Codex 风格的 Responses V2 原生压缩，同时保留 Pi 自身的会话、工具、恢复、分支、树导航和跨模型可移植性。

插件在压缩时同时维护两种上下文表示：

- **Pi 可移植摘要**：可读的文本摘要，继续服务于 Pi 的本地 JSONL、恢复会话、切换模型和分支/树操作。
- **Provider 原生压缩历史**：Responses V2 返回的 opaque `compaction` 项，用于兼容模型后续请求中的高保真续接。

> **状态：实验性。** 内置 OpenAI 与 OpenAI Codex 后端经过真实环境测试；自定义 Provider 具有离线传输、协议、回退和历史重放测试，但仍取决于目标服务是否完整实现 Responses V2 压缩协议。

## 核心功能

- 使用普通 Responses endpoint 和末尾的 `compaction_trigger` 请求服务端压缩。
- 增量解析 SSE 响应，并要求服务端返回且只返回一个非空的加密 `compaction` 项。
- 在远端压缩的同时生成 Pi 可读摘要；远端失败时仍可继续使用本地摘要。
- 支持 Pi 0.84.4 原生的工具调用间阈值检查，不再监听 `turn_end`，也不再 patch 私有 `AgentSession`。
- 支持手动 `/compact`、自动压缩和溢出恢复，统一使用 Pi 的公开压缩生命周期。
- 可指定独立的压缩模型，并在失败时依次回退到当前模型、本地摘要和 Pi 默认压缩。
- 对直接 `openai/*` Responses 模型提供 `store`、`context_management`、`previous_response_id` 和 WebSocket 续接能力。
- WebSocket 不可用或当前请求不适合增量续接时，自动回退到 Pi 的 HTTP Responses 流。
- 在会话恢复、reload、fork、tree 导航和压缩后重建可兼容的远端压缩历史。
- 保留 Pi/OpenAI 原生 Prompt Cache 字段，避免自定义 WebSocket 路径静默丢失缓存配置。
- 支持注册到 Pi 的自定义 Responses-compatible Provider，包括自定义 `baseUrl`、认证结果和 Provider headers。

## 支持范围

| Provider / 模型类型 | Responses V2 远端压缩 | `previous_response_id` | 自定义 WebSocket 流 | 当前验证状态 |
|---|---:|---:|---:|---|
| `openai/*` | 支持 | 支持 | 支持，失败时回退 HTTP | 真实环境测试 |
| `openai-codex/*` | 支持 | 不接管 | 不接管，保留 Pi 内置传输 | 真实环境测试 |
| 自定义 Responses-compatible Provider | 需要可用 `baseUrl` 和兼容协议 | 不注入；压缩后使用远端历史重放 | 不接管 Provider 普通流 | 离线传输与回退测试 |
| Azure OpenAI | 部分兼容 | 需显式启用兼容路径 | 不支持 | 尚未真实环境测试 |

自定义 Provider 是否可用，最终取决于服务端是否支持流式 Responses 请求、`compaction_trigger`、`remote_compaction_v2` feature，以及包含 `encrypted_content` 的压缩结果。

## 安装

本仓库只支持通过 GitHub 安装，不发布 npm package。

### 环境要求

- Node.js `>=22.19.0`
- Pi `>=0.84.4 <0.85.0`
- Pi 中已经配置好压缩模型所需的认证信息
- 内置或自定义的 Responses-compatible 压缩模型
- 自定义 Provider 的模型或认证结果必须提供可用 `baseUrl`

Pi 0.84.4 是最低版本，因为从该版本开始，Pi 会在工具执行完成后、同一 Agent run 的下一次模型响应前原生检查自动压缩阈值。

### 从 GitHub 全局安装

```bash
pi install git:github.com/CoderDoubleflower/pi-openai-server-compaction
```

### 仅在当前项目安装

在项目目录中执行：

```bash
pi install -l git:github.com/CoderDoubleflower/pi-openai-server-compaction
```

### 更新

```bash
pi update --extensions
```

安装或更新后，重启 Pi，或者在当前会话中执行：

```text
/reload
```

## 压缩流程

当 Pi 决定执行压缩时，插件会并行运行两条路径：

1. 使用 Pi 的上下文与压缩准备结果生成可读的本地文本摘要。
2. 将当前分支转换为 Responses input items，追加 `compaction_trigger`，并请求 Responses V2 服务端压缩。

远端压缩成功后，返回的替代历史会写入：

```text
CompactionEntry.details.remoteCompaction
```

实际生成远端产物的模型会记录为：

```text
CompactionEntry.details.remoteCompaction.compactionModelKey
```

Pi 仍会保存文本摘要，因此即使之后切换到不支持该原生产物的模型，会话也不会只剩下不可读的 opaque 数据。

### 工具调用间自动压缩

插件本身不再维护独立的 same-run trigger。Pi 0.84.4 或更新版本负责完整时序：

```text
Assistant 请求工具
→ 工具执行完成，结果写入上下文
→ Pi 检查自动压缩阈值
→ 达到阈值时触发 session_before_compact
→ 插件生成可移植摘要并请求 Responses V2 压缩
→ Pi 持久化 compaction entry 并刷新 Agent context
→ 同一 Agent run 开始下一次 Assistant 响应
```

Pi 只会在 Agent loop 确实还要继续时执行这次工具边界检查。已经结束且没有后续 steering/message 的工具批次，不会因为插件而额外压缩。

本地触发时机由 Pi 自身设置控制，包括：

```text
compaction.enabled
compaction.reserveTokens
compaction.keepRecentTokens
```

旧版插件中的以下配置已经删除：

```text
midRunCompaction
PI_OPENAI_SERVER_COMPACTION_MID_RUN
```

旧配置中的这些字段不会重新启用旧适配器。当前实现不注册扩展级 `turn_end` 压缩监听器，也不修改私有 `AgentSession` 方法。

手动 `/compact` 和溢出恢复同样进入 Pi 的公开 `session_before_compact` / `session_compact` 生命周期，因此会复用相同的远端压缩实现。

## 不同 Provider 的行为

### 直接 OpenAI Responses：`openai/*`

在两次实际压缩之间，插件会在模型支持时为请求补充：

```json
{
  "store": true,
  "context_management": [
    {
      "type": "compaction",
      "compact_threshold": 80000
    }
  ],
  "previous_response_id": "resp_..."
}
```

具体行为：

- `store: true` 仅在模型没有声明 `supportsStore: false` 时加入。
- 已有 `context_management` 时不会覆盖调用方提供的值。
- 只有当前会话、模型和历史状态都兼容时才复用 `previous_response_id`。
- 请求可通过 OpenAI Responses WebSocket 发送；连接或请求不满足安全条件时回退到 Pi 的默认 HTTP 流。
- 压缩完成后优先重放持久化的远端替代历史，而不是继续引用压缩前的 response id。

### OpenAI Codex：`openai-codex/*`

插件保留 Pi 内置 Codex transport，不注册替代 WebSocket 流，也不使用自定义 `previous_response_id` 路径。

发生压缩后，插件会在模型兼容时把重建出的远端替代历史注入后续 Responses 请求，从而保持 Codex 风格的原生压缩连续性。

### 自定义 Responses-compatible Provider

可在配置中指定任意已注册的 `provider/model-id`。该模型可以与当前会话模型使用不同 Provider 或 API 标识。

插件会通过 Pi 的 model registry：

- 查找目标模型；
- 解析 API key；
- 接收认证流程返回的最终 `baseUrl`；
- 保留 Provider 自定义 headers；
- 只为压缩请求构造 Responses endpoint；
- 不注册或替换该 Provider 的普通 stream implementation。

Endpoint 规则：

```text
baseUrl 已以 /responses 结尾 → 直接使用
baseUrl 以 /v1 结尾        → 追加 /responses
其他 baseUrl               → 追加 /v1/responses
```

自定义 Provider 不会收到 OpenAI Codex 专用的 installation、window 或 account identity headers。

### Azure OpenAI

Azure 路径属于实验性兼容。`includeAzure` 主要控制 `previous_response_id` 等旧续接兼容行为；远端压缩是否成功仍取决于实际 endpoint、认证方式和 Responses V2 协议支持。该路径目前未做真实环境验证。

## 压缩模型与回退链

压缩请求默认使用当前 Pi 模型：

```json
{
  "model": "current"
}
```

也可以使用 Pi 已注册的其他模型：

```json
{
  "model": "my-responses-provider/my-model",
  "reasoningEffort": "high"
}
```

目标模型必须能从 Pi model registry 中找到，并能解析 API key 与可用 Responses endpoint。

运行时回退顺序：

```text
配置的 provider/model
        ↓ 认证、HTTP 或协议失败
当前会话模型
        ↓ 远端压缩失败
可移植本地摘要
        ↓ 本地摘要也失败
Pi 默认压缩实现
```

有 UI 时会显示回退警告。用户取消或 `AbortSignal` 中断不会启动新的远端回退请求。

### `reasoningEffort`

默认值：

```json
{
  "reasoningEffort": "inherit"
}
```

支持：

```text
inherit
none
minimal
low
medium
high
xhigh
```

`inherit` 会优先继承当前 Responses 请求中的 reasoning 配置；没有可复用配置时，回退到 Pi 当前 thinking level。显式值只覆盖压缩请求的 reasoning effort，不修改普通对话模型设置。

## 配置

配置读取顺序：

1. `~/.pi/agent/openai-server-compaction.json`：全局配置。
2. `.pi/openai-server-compaction.json`：项目配置，覆盖同名全局字段。
3. 环境变量：优先级最高。

完整示例：

```json
{
  "enabled": true,
  "includeAzure": false,
  "thresholdRatio": 0.7,
  "compactThreshold": 0,
  "usePreviousResponseId": true,
  "notify": false,
  "model": "current",
  "reasoningEffort": "inherit"
}
```

| 配置项 | 默认值 | 作用 |
|---|---:|---|
| `enabled` | `true` | 启用插件的远端压缩与请求续接逻辑 |
| `includeAzure` | `false` | 为 Azure Responses 模型启用兼容的 `previous_response_id` 路径 |
| `thresholdRatio` | `0.7` | 未设置显式阈值时，按 context window 计算 Responses `compact_threshold` |
| `compactThreshold` | `0` | 直接指定 Responses `context_management` 的 token 阈值；`0` 表示使用 ratio |
| `usePreviousResponseId` | `true` | 控制直接 OpenAI 的 `previous_response_id` 与自定义 WebSocket 路径 |
| `notify` | `false` | 在普通特性启用和回退时显示 UI 通知 |
| `model` | `"current"` | 指定压缩模型，格式为 `current` 或 `provider/model-id` |
| `reasoningEffort` | `"inherit"` | 指定压缩请求的 reasoning effort |

`compactThreshold` 和 `thresholdRatio` 只控制直接 `openai/*` 普通 Responses 请求中的：

```text
context_management[].compact_threshold
```

它们不控制 Pi 的本地工具边界自动压缩触发。Pi 的自动触发设置必须在 Pi 自身的 `settings.json` 中配置。

### 环境变量

| 环境变量 | 作用 |
|---|---|
| `PI_OPENAI_SERVER_COMPACTION_ENABLED` | 启用或关闭插件 |
| `PI_OPENAI_SERVER_COMPACTION_AZURE` | 启用 Azure 续接兼容路径 |
| `PI_OPENAI_SERVER_COMPACTION_THRESHOLD` | 显式设置 Responses `compact_threshold` token 数 |
| `PI_OPENAI_SERVER_COMPACTION_RATIO` | 按 context window 比例计算 Responses 阈值，默认 `0.7` |
| `PI_OPENAI_SERVER_COMPACTION_PREVIOUS_RESPONSE_ID` | 启用或关闭直接 OpenAI 的 response-id/WebSocket 续接 |
| `PI_OPENAI_SERVER_COMPACTION_NOTIFY` | 显示普通功能启用通知 |
| `PI_OPENAI_SERVER_COMPACTION_MODEL` | `current` 或任意已注册的 `provider/model-id` |
| `PI_OPENAI_SERVER_COMPACTION_REASONING_EFFORT` | `inherit`、`none`、`minimal`、`low`、`medium`、`high` 或 `xhigh` |
| `PI_CACHE_RETENTION` | Pi/OpenAI Prompt Cache 兼容设置 |

示例：

```bash
PI_OPENAI_SERVER_COMPACTION_MODEL=my-responses-provider/my-model \
PI_OPENAI_SERVER_COMPACTION_REASONING_EFFORT=high \
pi
```

关闭插件：

```bash
PI_OPENAI_SERVER_COMPACTION_ENABLED=0 pi
```

只关闭直接 OpenAI 的 `previous_response_id` 和 WebSocket 续接：

```bash
PI_OPENAI_SERVER_COMPACTION_PREVIOUS_RESPONSE_ID=0 pi
```

## Responses V2 协议处理

压缩请求发送到 Responses endpoint，并包含流式输出与 `remote_compaction_v2` feature。请求 input 的最后一项是压缩触发器。

插件会增量读取 SSE，并验证：

- HTTP 请求成功；
- 流中没有 `error` 或 `response.failed`；
- 流最终出现 `response.completed`；
- 恰好出现一个合法的 `response.output_item.done` 压缩项；
- 该项具有非空 `encrypted_content`；
- 中断、无响应体、非法 SSE JSON 和不完整流都按失败处理。

解析成功后，插件将返回的 opaque item 与必要的显式历史组合为可重放的远端替代历史，并把 usage/cost 快照存入 compaction details。

## 会话恢复与兼容性

Pi 本地 JSONL 和 tree 始终是权威会话来源。远端原生产物只是兼容模型的附加续接层。

插件会在以下生命周期边界清理或重建内存状态：

- session start、reload 和 resume；
- session switch、fork 和 tree 导航；
- compaction 完成；
- model select；
- session shutdown。

持久化远端历史只会在 replay model key 与当前请求模型匹配时重放。恢复会话或执行 tree 操作后，重建逻辑还会过滤不匹配模型的 Assistant completion，避免跨模型内容污染远端历史。

配置模型实际生成的产物会记录 `compactionModelKey`，而 replay compatibility 仍与当前会话模型绑定，从而兼顾独立压缩模型和 Pi 的会话重建语义。

## Prompt Cache 行为

直接 OpenAI 的自定义 WebSocket 路径会镜像 Pi 原生 OpenAI Responses 的缓存行为：

- Pi session id 用作稳定的 `prompt_cache_key`；
- key 会限制在 OpenAI 的 64 个 Unicode code point 范围内；
- 默认 cache retention 为 `short`；
- `cacheRetention: "long"` 仅在模型声明支持时发送 `prompt_cache_retention: "24h"`；
- `cacheRetention: "none"` 会移除 cache key，并仅在模型声明支持时发送显式 cache mode；
- 调用方的 `onPayload` hook 在默认字段应用后运行，仍可检查或覆盖 payload。

Pi 的兼容环境设置同样保留：

```bash
PI_CACHE_RETENTION=long pi
```

一次真实压缩会改变有效 Prompt 前缀。因此，压缩后的第一条请求出现较低 cache hit rate 属于正常现象；后续请求会围绕新的前缀重新建立缓存。

## 数据处理与安全说明

使用前需要了解：

- 直接 `openai/*` 请求在模型支持时可能被加入 `store: true`；
- 当前压缩上下文会发送到配置的压缩 Provider；
- 服务端返回的 opaque `encrypted_content` 会保存在 Pi 本地 session JSONL 中；
- opaque 压缩项不是可读摘要，也不应被当作跨 Provider 通用格式；
- 插件使用 Pi model registry 解析认证，不在仓库中保存凭据；
- 自定义 Provider 的普通请求 transport 不会被本插件替换。

在使用第三方 Responses-compatible Provider 前，应确认其数据保留、日志、加密和隐私政策。

## 故障排查

1. 将 `"model"` 改为 `"current"`，排除独立压缩模型的 endpoint 或认证问题。
2. 检查自定义 Provider 最终解析出的 `baseUrl`、Authorization/header 行为和 Responses V2 SSE 兼容性。
3. 使用 `PI_OPENAI_SERVER_COMPACTION_PREVIOUS_RESPONSE_ID=0 pi` 关闭直接 OpenAI 的 response-id/WebSocket 路径，只保留压缩功能。
4. 使用 `PI_OPENAI_SERVER_COMPACTION_ENABLED=0 pi` 或配置 `"enabled": false` 完全关闭插件。
5. 使用 `pi --no-extensions` 排除所有扩展影响。
6. 修改配置或更新 GitHub package 后执行 `/reload`。
7. 在 Pi session JSONL 中查找带有 `details.remoteCompaction` 和 `compactionModelKey` 的 `compaction` entry。
8. 调试自动触发时，应检查 Pi 自身的 compaction 设置；本插件不再拥有独立的工具调用间触发器。

如果所有远端候选都失败，但本地摘要成功，Pi 会继续使用可移植摘要；只有远端和本地摘要都失败时，才完全交回 Pi 默认压缩实现。

## 测试

安装依赖：

```bash
npm install
```

Prompt Cache payload 回归：

```bash
npm run smoke:cache
```

Responses V2 SSE、加密压缩项和异常处理回归：

```bash
npm run smoke:v2
```

Pi 0.84.4 工具边界原生触发与公开 hook 合约回归：

```bash
npm run smoke:tool-boundary
```

自定义 Provider endpoint、headers、fallback 和 replay 回归：

```bash
npm run smoke:custom-provider
```

完整离线测试：

```bash
npm test
```

真实 Pi + OpenAI 端到端测试：

```bash
npm run test:live
```

Live 测试需要本机存在可用的 Pi 与 OpenAI 认证。仓库不包含真实环境或自定义 Provider 的凭据。

## 已知限制

- Pi 的本地 JSONL/tree 模型始终是权威状态。
- Pi 0.84.4+ 决定自动压缩的实际时机；插件只通过公开 hook 自定义压缩结果。
- 自定义 Provider 必须实现插件预期的 Responses V2 流式压缩协议。
- `previous_response_id` 与自定义 WebSocket transport 仅用于现有的直接 OpenAI 兼容路径。
- 自定义 Provider 支持远端历史 replay，不代表它自动获得 response-id 或 WebSocket 续接。
- Azure 路径尚未真实环境测试。
- 一次实际压缩会创建新的 Prompt Cache 边界。
- 压缩请求的 usage/cost 会记录在 details 中，但目前不会合并进 Pi 的 `get_session_stats()`。

## 仓库结构

| 路径 | 作用 |
|---|---|
| `src/extension.ts` | Pi package 入口，仅委托给公开扩展实现 |
| `src/index.ts` | Provider-agnostic wrapper 入口 |
| `src/index-core.ts` | OpenAI/Codex 生命周期、请求 patch 与压缩编排 |
| `src/provider-agnostic-hooks.ts` | 独立压缩模型尝试、当前模型回退和通用远端历史重放 |
| `src/compaction-model-fallback.ts` | 配置模型解析与候选模型顺序 |
| `src/remote-compaction-core.ts` | Pi 历史转换、请求体、摘要、持久化和重建逻辑 |
| `src/remote-compaction-v2.ts` | Responses V2 SSE 解析、校验和 usage 处理 |
| `src/remote-compaction-transport.ts` | 内置/自定义 endpoint 与 headers 解析 |
| `src/openai.ts` | 模型识别、阈值、payload patch 和 model key |
| `src/openai-prompt-cache.ts` | OpenAI Prompt Cache 字段兼容 |
| `src/openai-ws-stream.ts` | 直接 OpenAI WebSocket 续接与 HTTP 回退 |
| `src/config.ts` | 全局、项目和环境变量配置加载 |
| `src/state.ts` | 每个 session 的临时 continuation/replay 状态 |
| `scripts/pi-tool-boundary-compaction-smoke.mjs` | Pi 0.84.4 工具边界与公开 hook 回归 |
| `scripts/custom-provider-compaction-smoke.mjs` | 自定义 Provider 离线回归 |
| `tests/live/openai-compaction-rpc-live.ts` | 真实 Pi RPC 端到端测试 |

进一步了解实现：

- [`ARCHITECTURE.md`](ARCHITECTURE.md)
- [`VALIDATION.md`](VALIDATION.md)
- [`TESTPLAN.md`](TESTPLAN.md)
- [`CHANGELOG.md`](CHANGELOG.md)

## License

MIT，详见 [`LICENSE.md`](LICENSE.md)。
