---
name: psd-text-rasterize-companion-rect
description: "文本平台不可渲染效果(spread阴影/warp)回退栅格化用兄弟rect承载,不能设到TextNode的fill"
metadata: 
  node_type: memory
  type: project
  originSessionId: b95b50ee-a27d-42b5-99ab-a62c2feda8a3
---

文本含平台渲染不出的效果(dropShadow/innerShadow `spread>0` 实色外扩、`warp.style!=='none'` 弧形)时,回退栅格化:psd-parser 的 `textEffectsRenderable()` 判定 false → `compositeLayerEffects` 把字形+效果烤成合成图,`SerializedLayer.textRasterized=true` / `IRTextProps.rasterized=true`。

**Why:** MasterGo/Figma 文本节点渲染不出 spread 实色阴影,也不支持可编辑弧形。

**How to apply:**
- 合成图**不能**直接设成平台 TextNode 的 `node.fills`——MasterGo 的 `setRangeFills`(字符颜色)优先级高于 `node.fills`,白字会盖住合成图的橙边,只露出偏移阴影。
- 正确做法(方案B):占位 TextNode 字符设透明(`setRangeFills` alpha=0)+ `fills=[]`,保留 characters/全部 pluginData(导出仍识别为文本层);**另建兄弟 rectangle** 承载合成图显示,几何=IR文本几何(含expand),标记 `setPluginData('psd_raster_companion','1')`。
- 导出端 `node-serializer.serializeNode` 开头检测 `psd_raster_companion` → `return null` 跳过;透明 TextNode 正常导出文本层(rawImage纯字形 + rawEffects还原spread阴影 + psd_warp回写)。`buildEffects` 的 `isTextWithRaw`(type==='text' && rawEffects)完整保留原始PSD effects。
- PS 逐层 `layer.imageData`/`layer.canvas` 是 **warp 变形前**的平直字形(不是变形后),故合成图无弧形——弧形仅靠 round-trip 还原,画布降级为平直字+阴影,可接受。

双平台对称(figma createRectangle / mg createRectangle,rotation figma正=mastergo取反)。详见 [[psd-export-layer-geometry-relative-coords]]。

**坑:栅格化文本 textAutoResize=NONE 污染导出 point/box 判定。** 栅格化为对齐 companion 把 `text.textAutoResize='NONE'`,但 psd-builder 用 `isPointText = textAutoResize==='WIDTH_AND_HEIGHT'` 判定 → point 文本(如 Piggy Pop,transform sy≈2.167 + arc warp)误走 box 分支,box 分支 transform 写死 `[1,0,0,1,x,y]` 丢缩放/旋转,且观感字号位置全错。修复:renderer 栅格化分支额外存 `psd_shape_type`(tp.shapeType),node-serializer 读进 `ExportTextInfo.shapeType`,psd-builder `isPointText = shapeType==='point' || (shapeType==null && textAutoResize==='WIDTH_AND_HEIGHT')`。warp 写回(layer.text.warp,974)依赖 layer.text 已构造,point 分支构造后才生效——故 warp 丢失与 shapeType 误判同根因。双平台都要存 psd_shape_type。
