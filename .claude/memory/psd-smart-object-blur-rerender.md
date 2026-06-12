---
name: psd-smart-object-blur-rerender
description: 智能对象重渲染清晰像素的全部坑(blend判定/补回滤镜+调整/超采样/锐度重渲染+白底守卫/滤镜蒙版拖尾用sharp-over-blur)
metadata: 
  node_type: memory
  type: project
  originSessionId: 5b31324a-112d-4c13-bee5-0a37988b374a
---

智能对象(`placedLayer`)带启用的模糊类智能滤镜(motion blur 等)时,ag-psd 读到的 `layer.imageData` 是被模糊污染的图层缓存,与 PS merged composite(清晰)不一致,导入后发糊。修复在 `src/parser/psd-parser.ts`:用 `placedLayer.id` 找 `linkedFiles` 内嵌源 → `readPsd` 解码 → `placedLayer.transform`(纯仿射平行四边形)canvas 重渲染清晰像素覆盖 `imageData`。

**Why:** 用 `图层样式测试.psd` 的 cions 组数据驱动定位,踩了三个非显而易见的坑。

**How to apply:**
1. **不是所有模糊滤镜都该重渲染**——blend=screen/lighten + 降透明度的层是刻意用模糊做的下落拖尾/光晕(如 `图层26` screen 70%),模糊像素正是 PS 要显示的,必须保留。只有 normal 混合 + 高透明度才重渲染。判定见 `shouldRerenderClearForBlur`。
2. **重渲染丢失的两类调整要补回**:(a) 非模糊智能滤镜(如 curves 提亮)——`applyNonBlurSmartFilters` 渲染后烘进像素,只跳过模糊类;(b) 父层预处理已烘进旧 imageData 的剪贴调整层(如亮度+17)会被覆盖丢失,预处理时把调整引用暂存到 `__rerenderClipAdjustments`,serializeLayer 重渲染后再 `applyAdjustmentLayers` 一次。
3. **必须超采样**:按 bbox 烤会丢源分辨率(PS 智能对象放大时从源重渲染更锐利),按「源边长/显示边长」算倍率(上限 4x)渲染,节点显示尺寸仍用 1x bounds + scaleMode 缩放填充。有 layer mask / 空间蒙版调整时降级 1x(`supersampleSafe`)避免按 1x 坐标对齐的蒙版错位。
4. **重渲染不只为模糊清洗,也为锐度**——`cions` 组里有的 coin **无任何智能滤镜**,但其 channel data 是按显示尺寸(58×46)栅格化的低分辨率缓存,而内嵌源 138×97 更高,放大照样糊。要让"normal 混合 + 高透明度 + 纯仿射 + 源分辨率高于显示(rawScale>1.05)"的智能对象也从源超采样重渲染(`shouldRerenderClearForSharpness`,与模糊门 OR 成 `shouldRerenderClear`)。配套两个守卫:(a) `isAffineParallelogram` 校验 BR≈TR+(BL-TL),非仿射(透视/自由变形)一律放弃重渲染、回退缓存,否则会被当平行四边形扭曲;(b) 按 `placedLayer.id` 缓存源解码(`globalSmartObjectSourceCache`),4 枚 coin 共享同一源只 readPsd 一次,也避免大 PSB 重复解码。round-trip 与模糊路径同链路:`rawPsdOriginalImage`(调整前原始像素)优先于 `smartObjData.origImageB64`,导出单次加回 `rawPsdAdjustments`,不双重应用。
5. **锐度重渲染会把"带白底的扁平源"渲染成白块**——智能对象内嵌源的扁平合成图**不保证等于该层在文档里的实际像素**:coin 源恰好透明底吻合,但 `backlgt` 源是 931×934 **不透明白底**,从源重渲染 → 整片白块。守卫:解码时在 64×64 采样估 `transparentFrac`(alpha<250 占比),源透明占比<0.02(白底)直接拒绝;再算"重渲染轮廓 vs 缓存轮廓"的 `meanAlphaDiff`,>40 也拒绝(好层 ≤5,坏层 218,区分极大)。**仅锐度路径用此守卫**,模糊路径因有缓存兜底不用。
6. **带滤镜蒙版的动感模糊 = 清晰币 + 拖尾,纯净重渲染会丢拖尾**——`cions` 是被锤子砸开存钱罐飞溅的金币,coin 的 motion blur 带 `filter.maskEnabled:true`,PS 合成 = 蒙版处显示模糊(拖尾)、非蒙版处显示清晰源(币主体)。**ag-psd 不暴露智能滤镜蒙版栅格**(filter 无 mask 字节、layer 无 filterMask),无法精确还原。用 **sharp-over-blur 近似**:清晰源(超采样)叠在「模糊缓存(=整层动感条纹,即拖尾)」之上,币主体盖住中心、四周条纹透出来当拖尾。拖尾底图用 `getRerenderBaseCache`(=调整前缓存,曲线已自带、勿与稍后 +17 双重叠)。所以模糊路径**不再纯净重渲染**,改 sharp+trail 合成。

7. **拖尾必须低不透明度叠加(0.3),否则"显得大/位置不对"**——缓存 smear 是沿运动轴(`filter.angle`)**对称两端**的整条动感模糊,但 PS 滤镜蒙版只显现**一端**的淡拖尾(方向不可还原)。满不透明度叠 → 一圈过亮大光晕,既"拖尾显得大",又把币视觉重心摊开像"位置不对"(其实节点 bounds/FILL 几何正确,scaleMode=FILL 超采样不影响位置——别误判成几何 bug)。读 merged composite 裁各 coin bbox 数据驱动比对:`SMART_BLUR_TRAIL_OPACITY=0.3` 最接近(清晰币主导、拖尾仅淡淡运动感)。亮度+17 只改 RGB 不改 alpha,拖尾淡覆盖不受影响。诊断脚本坑:`initializeCanvas(createCanvas)` 第二参是 createImageData**别误传 Image 工厂**;`useImageData:true` 需默认 createImageData 才能分配 `.data`,否则崩 verifyCompatible。

round-trip(务实兜底):`rawPsdSmartObject` 存原始模糊像素 + transform/filter,与剪贴调整的 `rawPsdAdjustments` 各自独立还原,不双重应用。排查方法见 [[debug-workflow-psd-roundtrip]];亮度对比度细节见 [[psd-brightness-contrast-uselegacy]]。
