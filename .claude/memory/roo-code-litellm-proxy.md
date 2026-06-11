---
name: roo-code-litellm-proxy
description: 给 Roo Code 配置内部 LLM 网关用的本地代理脚本与已知坑
metadata: 
  node_type: memory
  type: project
  originSessionId: 895509c6-b11f-4607-b043-0226110deb65
---

用户(chenbo)要在 VS Code 的 Roo Code 插件里用公司内部 LLM 网关 `https://llm-gateway-internal.hs99.vip`(虚拟 key `sk-hTfuBEWY58gyL9W3mKFcPw`)。

**网关已知限制(均经 curl 直连验证):**
- 受限虚拟 key 不允许调 `/v1/model/info`(报 "Virtual key is not allowed")。`/v1/models` 可调。
- 网关**不接受 `tools`/`tool_choice` 字段** —— 带 tools 的请求直连也返回 400 Invalid JSON。
- `temperature`/`top_p` 对 Claude 4.x 会 400。
- `reasoning_effort` none/low 都可接受。

**解决方案:本地代理** `/Users/admin/litellm-local/roo-proxy.py`,监听 `127.0.0.1:8788`,转发到网关。
- 本地应答 `/v1/model/info`(让 Roo Code LiteLLM provider 能拉模型)。
- 剥离 `temperature/top_p/tools/tool_choice/parallel_tool_calls`。
- 虚拟模型 `opus-4-8` / `opus-4-8-max` / `opus-4-8-1m` 映射到真实 `claude-opus-4-8`。
- 启动: `cd /Users/admin/litellm-local && python3 -u roo-proxy.py >> proxy.log 2>&1 &`

**注意:** 旧脚本 `/Users/admin/.copilot-litellm-proxy/proxy.py`(8787)被某个工具持续还原,改了会丢,所以另起 8788 的独立脚本。开机自启(launchctl)被安全策略拒绝,未安装。

**Roo Code 配置:** Provider=LiteLLM,Base URL=`http://127.0.0.1:8788`(不带 /v1),Key=网关 key,Model=`opus-4-8`。因剥离了 tools,需让 Roo Code 走文本(XML)工具模式。

**未决问题(2026-06-03):** 用户发消息时界面停在 `api_req_started` 转圈,代理日志收不到对应 POST —— 请求疑似卡在 Roo Code 内部未发出。下一步靠 VS Code 开发者工具 Console 报错定位。代理本身端到端已 100% 验证可用。
