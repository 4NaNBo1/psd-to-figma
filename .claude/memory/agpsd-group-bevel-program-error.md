---
name: agpsd-group-bevel-program-error
description: "ag-psd 把 bevel 写到 group(section divider)上会让 PS 报 \"program error reading layers\"，导出端须在容器节点剔除 bevel"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 4226603a-0f99-4ca2-97f0-9ae34784f70c
---

ag-psd(30.1.0)用 `writeEffects`(lfx2 路径)把 `bevel` 图层样式写到 **group / section divider** 层上时，会产生 Photoshop 无法解析的块，PS 打开报 `Problems were encountered reading layers "X" because of a program error (6408e1.9067)`。同一份 bevel 数据写在**普通图层**上完全正常。

数据驱动定位过程（关键，避免重复踩坑）：单个图层无论带不带像素/矢量都正常 → 整文件无论删矢量/mask 拆分/group clipping/pattern 都报错 → 二分到「带 effects 的 group」→ 逐 effect 拆分锁定**仅 bevel** 触发 → 原始 PSD 的 bevel 与导出的 bevel 数据**逐字段完全一致**（排除数据被改坏）→ ag-psd 写 layer+bevel 正常、写 group+bevel 报错 ⇒ 是 ag-psd 写 group bevel 的固有问题。这些 group bevel 多为 `enabled:false / present:false` 的禁用样式槽，不可见。

修复：`src/exporter/psd-builder.ts` 的 `buildEffects` 在容器节点（`node.children.length>0`）返回前 `delete result.bevel`。仅容器节点剔除，普通图层/文本的 bevel 保留。剔除不可见的禁用 bevel 对画面零影响；原始字节仍在 `rawPsdEffects` 里，若将来 patch ag-psd 修好 group bevel 写入可恢复。

与 [[agpsd-pattern-not-parsed]] 同属 ag-psd 写入/解析的坑。
