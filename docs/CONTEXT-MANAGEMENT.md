# 实验性 Codex Remote Context

本功能参考 `awoaCrim/pi-openai-toolkit` 的 `src/context-management/`，参考提交为
`1d3972c7ae64397463e922d8fe8333279df352d8`。版权及上游来源见
[CONTEXT-MANAGEMENT-NOTICE.md](./CONTEXT-MANAGEMENT-NOTICE.md)。

**默认关闭。** 原有 Responses V2 压缩、可移植摘要、压缩模型选择和直接 OpenAI 续接逻辑保持原样。
`contextManagement` 是 Codex 的实验性 Remote Context 窗口管理，**不是**普通 Responses 的
`context_management: [{ type: "compaction", ... }]` 参数。

## 开启

在现有配置文件中合并以下字段，不要删除原来的其他配置：

```json
{
  "enabled": true,
  "contextManagement": "remote",
  "contextReminderThresholdPercent": 10
}
```

配置路径仍为 `~/.pi/agent/openai-server-compaction.json` 或项目目录的
`.pi/openai-server-compaction.json`，项目配置优先，环境变量最高。更改配置后执行 `/reload`。
无需更换 Pi 的 `openai-codex` 传输，无需填写额外的 OAuth token；认证从当前模型的 Pi registry 获取。
最低 Pi 版本仍为 `0.84.4`。本功能使用公开扩展生命周期，不修改私有 AgentSession。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `contextManagement` | `"off"` | `off` 保留原逻辑；`remote` 启用符合条件模型的窗口管理 |
| `contextReminderThresholdPercent` | `10` | 可用窗口剩余到该百分比时提醒，范围 0–100；0 关闭提醒 |
| `contextManagementGatewayModels` | `[]` | 显式允许的 `provider/model-id` 列表，仅适用于 `openai-responses` 网关模型 |
| `contextManagementGatewayBaseUrl` | `""` | 可选 alpha 接口根路径；必须与该模型最终认证 URL 同源 |

对应环境变量：

```text
PI_OPENAI_SERVER_COMPACTION_CONTEXT_MANAGEMENT
PI_OPENAI_SERVER_COMPACTION_CONTEXT_REMINDER_PERCENT
PI_OPENAI_SERVER_COMPACTION_CONTEXT_GATEWAY_MODELS
PI_OPENAI_SERVER_COMPACTION_CONTEXT_GATEWAY_BASE_URL
```

网关模型列表环境变量接受 JSON 数组或逗号分隔的完整模型引用。

## 窗口如何工作

激活后，模型获得 `history`、`notes`、`new_context`、`get_context_remaining` 四个工具。
发给 Codex 的 `history` 与 `notes` 是原生 namespace schemas；本地 Pi 负责路由执行。
每次请求带有 `x-codex-window-id` 和 `x-codex-turn-metadata`，同时合并到 `client_metadata`，
包含 `history_ingest_requested: true`。已有的无关元数据和 Prompt Cache 字段会保留。

模型在当前窗口使用 `notes.write_file` 或 `notes.append_to_file` 保存任务检查点后，
可调用 `new_context` 开启下一窗口。**没有本地摘要自动携带到新窗口**，模型需要通过
notes 和 history 取回信息。`history` 支持 list_windows、list_items、read_item、search_contents；
`notes` 支持 list_files_by_prefix、read_file、search_contents、append_to_file、write_file。

为防止未保存的工作丢失，本实现要求当前窗口存在成功的 notes 写入结果。
与参考实现不同，本版不提供 `force=true` 绕过检查点的路径。
HTTP 200 但正文为 `success:false` 或 `ok:false` 也被视为失败，不能作为检查点。
不支持的接口、认证失败、超时、取消或协议错误不会静默降级为有损摘要。

保留 16,384 token 作为收尾缓冲，提醒百分比基于剩余可用窗口计算。
提醒不等于定时自动切换：模型仍需先保存 notes，再调用 `new_context`。
新窗口收到第一次有效 assistant usage 前，剩余量显示未知，避免沿用旧窗口的计量误报。
`compactThreshold`、`thresholdRatio` 与独立压缩 `model` 不控制此模式。

## 与原插件的互斥及会话恢复

`remote` 覆盖的模型不会执行原来的 V2 远端压缩、可移植摘要或 previous_response_id 历史续接。
阈值压缩、手动 `/compact`、溢出恢复都会取消传统压缩，不自动改变用户选择的模式。
未覆盖的模型仍使用原插件逻辑。只有显式配置成网关的直接 `openai` 模型会绕开本插件的旧 WebSocket
续接实现，使用 Pi 的 Responses transport；原生 Codex 和自定义 Provider 的 transport 不被替换。

本实现采用**追加窗口标记 + 请求上下文投影**，不伪造 CompactionEntry。
与参考仓库的无摘要压缩边界不同，旧消息仍留在 Pi 本地 JSONL 和内存中，只有模型收到的上下文被裁短。
因此本地存储/内存仍会随会话增长；它不是本地日志大小优化。
首次启用不会丢弃会话已有内容，切换窗口后过滤孤立的工具结果。

窗口状态绑定 Pi session、后端和账号作用域，恢复/reload/tree 导航从当前分支恢复。
fork 使用新 session，不复用旧线程的窗口身份。后端或认证身份变化会建立独立作用域，
不会将其他作用域保存的加密工具结果作为原生加密内容重放。

关闭方式：将 `contextManagement` 改为 `off` 并 `/reload`。内部标记隐藏，本地历史重新参与原始上下文构造；
原插件或 Pi 仍可能随后按正常规则压缩。关闭后其他模型不会获得解密远端 opaque 数据的能力。
不要同时启用其他注册相同四个工具的扩展；检测到工具名称冲突时会停止 Remote Context 请求。

## 自定义网关 / sub2api

**仅支持 `/v1/responses` 或 Responses V2 压缩不够。** 网关还必须兼容以下独立 POST 接口及其加密协议：

```text
<root>/alpha/history/v2/{list_windows,list_items,read_item,search_contents}
<root>/alpha/notes/v2/{list_files_by_prefix,read_file,search_contents,append_to_file,write_file,thread_hint}
```

还必须保留 namespace 工具、window metadata、encrypted arguments/output，以及请求间稳定的后端账号/线程归属。
单纯添加路由不能保证跨账号的历史和 notes 连续性。这里不承诺任意 sub2api 版本或渠道支持这些接口。
参考仓库限定了自己的网关 Provider 和模型，本插件没有照搬该硬编码，也不会自动探测所有 Provider。

仅在网关确已实现上述协议时配置，例如：

```json
{
  "enabled": true,
  "contextManagement": "remote",
  "contextManagementGatewayModels": ["my-gateway/my-codex-model"],
  "contextManagementGatewayBaseUrl": "https://gateway.example/v1"
}
```

这里的根路径是例子，应按实际 alpha 路由设置；普通模型 baseUrl 不会因此改变。
必须显式配置完整模型引用。网关请求只使用其 data-plane key，移除 Cookie、ChatGPT-Account-ID、x-api-key，
拒绝将可识别的 Codex OAuth 凭据用作网关 API key，不自动重定向到其他地址。
工具响应的密文保存于本地 details，终端显示完成提示；后续请求才恢复为原生 encrypted_content。
不要把真实 token、加密历史或完整会话作为调试资料公开上传。

## 验证

```bash
npm run smoke:context
npm test
```

离线测试覆盖配置、namespace 与加密协议、网关隔离、异常/取消/超时、窗口与检查点、旧逻辑互斥、
pending rollover、会话恢复和 fork、名称冲突与默认关闭行为。测试只用假认证和模拟后端。
**尚未进行真实 Codex/sub2api 端到端验证**：后端 alpha 功能、账号授权与网关亲和性需要在真实环境验收。
