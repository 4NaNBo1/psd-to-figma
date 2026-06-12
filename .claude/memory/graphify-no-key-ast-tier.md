---
name: graphify-no-key-ast-tier
description: "本机无任何 LLM API key,graphify 只能跑 AST 档位(graphify update .),extract 语义档需 key"
metadata: 
  node_type: memory
  type: project
  originSessionId: e6fbd3a8-64f3-4565-b1ca-fbfca81686f6
---

本机(psd-to-figma 开发机)**未设置任何 LLM API key**(GEMINI/GOOGLE/ANTHROPIC/OPENAI/DEEPSEEK 全空,无 ollama)。

- `graphify extract . --backend claude` **会失败**:报 `backend 'claude' requires ANTHROPIC_API_KEY`。它走 Anthropic API,**不是**本地 `claude` CLI,别再试。
- 无 key 唯一能跑的构建是 `graphify update .` —— 纯 AST,从零也能建图(实测 484 节点 / 818 边 / 38 社区),并生成 graph.html + GRAPH_REPORT.md。`query`/`explain`/`path` 都能用,但边是结构边(calls/imports/contains),**不是 LLM 语义边**。
- 想要真正的语义档(概念节点、why、跨模态 surprising 链),要么设一个 API key 后 `graphify extract .`,要么跑交互式 `/graphify`(用 Claude Code 子代理当 LLM,无需 key)。

**Why:** 写 [[code-intel skill]] 时踩过——把 `--backend claude` 当成本地 CLI 无 key 路径写进草稿,实际报错才发现。

**How to apply:** 给本项目自动构建 graphify 图时默认 `graphify update .`;只有确认有 key 才用 `extract`。graphify-out/ 已加入 .gitignore(类比 .codegraph/,本地重建)。
