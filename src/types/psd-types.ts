export type LayerType = 'group' | 'image' | 'text' | 'shape' | 'smartObject';

export interface SerializedColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface SerializedShadow {
  type: 'drop' | 'inner';
  color: SerializedColor;
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
  blendMode: string;
  visible: boolean;
}

export interface SerializedStroke {
  color: SerializedColor;
  width: number;
  position: 'inside' | 'center' | 'outside';
  blendMode: string;
  opacity: number;
  visible: boolean;
}

/** PSD fontCaps mapping: 0=normal, 1=small caps, 2=all caps. */
export type SerializedTextCase = 'ORIGINAL' | 'UPPER' | 'SMALL_CAPS';

export interface SerializedTextStyle {
  fontFamily: string;
  fontStyle: string;
  fontSize: number;
  color: SerializedColor;
  strokeColor?: SerializedColor;
  letterSpacing: number;
  lineHeight: number | null;
  /** PSD fontCaps: 0→ORIGINAL, 1→SMALL_CAPS, 2→UPPER. Omitted = ORIGINAL. */
  textCase?: SerializedTextCase;
  start: number;
  end: number;
}

export interface SerializedGradientStop {
  color: SerializedColor;
  position: number;
}

export interface SerializedGradientOverlay {
  type: 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond';
  angle: number;
  stops: SerializedGradientStop[];
  reverse: boolean;
  opacity: number;
}

/**
 * 图层 Color/Gradient Overlay 效果的「可编辑表达」——当整层通过原生化闸门时，overlay 不再
 * 烤进位图，而是作为叠加 fill 透传给平台（IMAGE fill 之上叠加 SOLID/GRADIENT_LINEAR），
 * 导出端从 node.fills 读回还原 PSD solidFill / gradientOverlay。
 */
export type SerializedFill =
  | { type: 'SOLID'; color: SerializedColor }
  | { type: 'GRADIENT_LINEAR'; gradient: SerializedGradientOverlay };

export interface PsdTextBounds {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

/**
 * PSD 文本弯曲（warp）变形数据。Figma/MasterGo 都不支持可编辑文本的弧形弯曲，
 * 因此该数据仅用于往返保真：导入时随节点保存（pluginData），导出 PSD 时写回
 * layer.text.warp，使 PS 重新打开时弯曲效果完整恢复。
 * 字段对应 ag-psd 的 Warp 接口（style/value/perspective/...）。
 */
export interface SerializedWarp {
  style: string;
  value?: number;
  values?: number[];
  perspective?: number;
  perspectiveOther?: number;
  rotate?: string;
}

export interface SerializedTextData {
  text: string;
  horizontalAlignment: string;
  styles: SerializedTextStyle[];
  /** PSD transform sy (vertical scale). Used to scale fontSize at import. */
  transformScale: number;
  /** PSD transform sx (horizontal scale). May differ from sy (e.g. sx=1.0 sy=1.0021).
   * Needed at export to restore PSD transform faithfully so character horizontal positions match. */
  transformScaleX?: number;
  /** PSD transform tx (horizontal baseline position in document). Saved for roundtrip:
   * export-time ty/tx = original_ty/tx + delta (user move) avoids subpixel precision loss in mastergo. */
  transformTx?: number;
  /** PSD transform ty (vertical baseline position in document). Same purpose as transformTx. */
  transformTy?: number;
  rotation?: number;
  docBoundsY?: number;
  docBboxCenterX?: number;
  txOffsetX?: number;
  /** 旋转文本专用：boundingBox 几何中心经 transform 映射到画布后的坐标（= 旋转后 bbox 中心）。
   * Figma/MasterGo 的 rotation 绕「节点中心」旋转（实测确认），渲染时令节点中心落在此点，
   * 绕中心旋转后视觉中心不变即对齐 PSD。仅旋转文本输出。 */
  docRotatedCenterX?: number;
  docRotatedCenterY?: number;
  /** Original PSD bounds (font-metric-derived character bbox relative to transform) */
  bounds?: PsdTextBounds;
  /** Original PSD boundingBox (actual character pixel bbox relative to transform) */
  boundingBox?: PsdTextBounds;
  /** Original PSD layer.text.index (TextFrameSet index in top-level engineData). */
  textIndex?: number;
  gradientOverlay?: SerializedGradientOverlay;
  shapeType?: 'point' | 'box';
  boxBounds?: { width: number; height: number };
  /** PSD 文本弯曲（warp）变形。保存用于导出往返，详见 SerializedWarp。 */
  warp?: SerializedWarp;
  /** round-trip 兜底：原始 PSD 文本图层的栅格像素（PS 渲染的字形位图，base64 PNG）+ 原始文档坐标 bounds。
   * MasterGo 与 PS 同名字体（如 Asap SemiBold）字形度量不同，exportAsync 重渲染像素会偏小/偏移导致
   * PS 中文本被裁剪；导出时若文本未被编辑则优先用这份原始像素，保证像素级保真。 */
  rawImage?: { base64: string; left: number; top: number; width: number; height: number };
  /** 原始 PSD 文本内容，用于导出时判断用户是否在平台改过文字（改过则原始像素失效，回退重渲染）。 */
  originalText?: string;
}

export interface SerializedCornerRadii {
  topLeft: number;
  topRight: number;
  bottomLeft: number;
  bottomRight: number;
}

export interface SerializedLayer {
  id: string;
  name: string;
  type: LayerType;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  blendMode: string;
  visible: boolean;
  clipped: boolean;
  isArtboard?: boolean;
  isSubGroup?: boolean;
  children?: SerializedLayer[];
  textData?: SerializedTextData;
  imageIndex?: number;
  /**
   * 当本层是 PSD clipping chain 的基底且 effects 已栅格化时，保存一张“仅效果”叠加图。
   * builder 将原始 channel 放在被剪贴层下方、此图放在上方，从而保持 PS 的顺序：
   * base content → clipped content → base layer effects。
   */
  clippingEffectOverlayImageIndex?: number;
  effects: SerializedShadow[];
  strokes: SerializedStroke[];
  /**
   * 整层原生化时，Color/Gradient Overlay 的可编辑表达（叠加在 IMAGE fill 之上）。
   * 仅在该层通过 canNativizeLayer 闸门时设置；栅格化的层此字段为空（overlay 已烤进位图）。
   */
  overlayFills?: SerializedFill[];
  cornerRadii?: SerializedCornerRadii;
  expandOffset?: number;
  /**
   * 标记：本文本层画布显示使用 PSD 原始字形像素（带效果时先合成 Layer Style）。
   * 节点仍按文本层导出，textData/rawImage/rawEffectsData 完整保留；透明 TextNode 负责编辑与往返，
   * 兄弟 raster companion 负责像素准确显示。
   */
  textRasterized?: boolean;
  /**
   * 标记：本层的 effects 含「从父组下放来的」effect（见 psd-parser 的 isSubGroup 下放逻辑）。
   * PS 中 pass-through 组的 layer effects 会作用于组合轮廓，Figma/MasterGo 的 frame 在
   * pass-through 下不渲染 frame 自身的 effect，故导入时把组 effect 复制给子层做近似显示。
   * 但组 effect 已由组自身的 rawEffectsData 完整 round-trip，下放到子层的副本在导出时是
   * 冗余的——若子层没有自己的 rawEffectsData 兜底，会被当成子层自有 effect 错误写回 PSD
   * （产生伪投影）。此标记透传到导出端，用于剔除这些下放副本。
   */
  inheritedGroupEffects?: boolean;
  /** 同 inheritedGroupEffects，针对从父组下放来的 strokes。 */
  inheritedGroupStrokes?: boolean;
  /**
   * 原始 PSD `layer.effects` 与 `layer.fillOpacity` 的 JSON 序列化数据。
   * 当图层的 effects 已被合成（rasterize）到位图中、`effects`/`strokes` 被清空时，
   * 用这份原始数据让 figma/mastergo → PSD 的回转还原所有效果（bevel/satin/glow/
   * pattern/多 stroke 的 fillType=gradient 等高级效果），避免视觉与数据信息丢失。
   */
  rawEffectsData?: string;
  /**
   * 原始 PSD 矢量形状数据（vectorMask + vectorFill + vectorOrigination）的 JSON 序列化。
   * PSD 中 rounded rectangle / 自由路径等矢量形状 layer 在 figma/mastergo 端会变成
   * rectangle (含 cornerRadius)，但 PS 中 appearance 面板的 Fill/Stroke/圆角等
   * 矢量属性会丢失。保留这份数据让 figma/mastergo → PSD 回转时还原矢量形状。
   */
  rawVectorData?: string;
  /**
   * 原始 PSD 调整图层数据（clipping 在 base 层上的 adjustment layers）的 JSON 序列化。
   * 导入时效果已烘焙到基底像素，此字段用于 round-trip 导出时还原调整图层。
   */
  rawPsdAdjustments?: string;
  /**
   * 组的矩形图层蒙版（layer mask）信息，坐标相对组 frame 原点。
   * PSD 中组上的矩形蒙版用于裁剪溢出内容（滚动视口）。Figma/MasterGo 用
   * frame 的 clipsContent + 蒙版框尺寸表达；此字段透传给 renderer 写入
   * pluginData，round-trip 导出时重建组的矩形 layer mask。
   */
  groupMaskRect?: { left: number; top: number; width: number; height: number; defaultColor: number };
  /**
   * 基底层「烘焙调整前的原始像素」的 base64 PNG。
   * 仅当该层带调整图层（rawPsdAdjustments）时存在。
   * 导出时基底层用这份原始像素 + 加回调整图层，PS 应用一次 = 与原始一致，
   * 避免「烘焙像素 + 再叠加调整图层」的双重应用（颜色偏移）。
   */
  rawPsdOriginalImage?: string;
  /**
   * 「patternOverlay 烘焙之前」的原始像素 base64 PNG。
   * 仅当该层是「纯 patternOverlay 场景」（唯一启用的 effect 是 patternOverlay）时存在。
   * 导出时该层用这份烤前像素 + 保留 patternOverlay effect + 写回 pattern 资源块，
   * PS 应用一次 pattern = 与原始一致，避免「烤后像素 + 再叠加 pattern」的双重应用。
   */
  rawPsdPrePatternImage?: string;
  /**
   * PSD 图层 channel 原始像素（效果合成之前）的 base64 PNG，尺寸 = layer bbox。
   * 9-slice 折叠导出时写回 PSD channel，避免用 533×181 拉伸图或 exportAsync 重渲染导致圆角/纹理失真。
   */
  rawPsdChannelImage?: string;
  /**
   * 智能对象（placedLayer）带启用的模糊类智能滤镜（如动感模糊）时的 round-trip 数据 JSON。
   * 这类图层 ag-psd 读到的 channel data 是被模糊污染的缓存，导入时已改用「智能对象源 +
   * 仿射变换」渲染出清晰像素；此字段保存原始模糊像素 + placedLayer/滤镜元信息，
   * 导出时优先写回原始智能对象图层，保证不丢失原始 PSD 信息。
   * 结构：{ origImageB64, transform:number[8], soId, width, height, filter }
   */
  rawPsdSmartObject?: string;
  /**
   * 普通光栅层的 layer mask 数据（几何 + 单通道 alpha base64）。
   * left/top 为相对层 bbox 左上的偏移（非文档绝对），导出端叠加图层最终坐标还原绝对位置。
   * 导入时 mask 已烘焙进像素 alpha；此字段配合 rawLayerMaskImage 用于 round-trip 导出
   * 还原为可编辑的独立 layer mask。仅普通像素层（非 group / 非调整基底 / 非纯 pattern）赋值。
   */
  rawLayerMask?: { left: number; top: number; width: number; height: number; defaultColor: number; dataB64: string };
  /**
   * 「烘焙 layer mask 之前」的原始像素 base64 PNG（与主像素同款 composite，仅未乘 mask alpha）。
   * 导出时用它作 canvas + 还原 rawLayerMask 为 layer.mask，PS 渲染 canvas×mask = 原始效果，避免双重裁剪。
   */
  rawLayerMaskImage?: string;
  /**
   * 9-Slice 九宫元数据 JSON。从 PSD 图层名 PUA 后缀解码；renderer 写入 nineSliceSettings plugin data。
   */
  nineSliceSettings?: string;
}

/**
 * PSD 全局 pattern 资源（Patt 块），用于 round-trip 导出时写回 psd.patterns。
 * 对齐 ag-psd 的 PatternInfo（data 走 base64 传输）。
 */
export interface SerializedPattern {
  id: string;
  name: string;
  x: number;
  y: number;
  bounds: { x: number; y: number; w: number; h: number };
  /** pattern 像素 RGBA（Uint8Array, length=w*h*4）的 base64。*/
  dataB64: string;
}

export interface SerializedPsd {
  name: string;
  width: number;
  height: number;
  layers: SerializedLayer[];
  images: string[];
  /** Original PSD top-level engineData (Txt2 block, base64). Used to preserve text engine data on roundtrip. */
  engineData?: string;
  /** PSD 全局 pattern 资源表（patternOverlay 引用的像素数据）。round-trip 导出时写回 psd.patterns。*/
  psdPatterns?: SerializedPattern[];
}

// --- Export types (design tool -> PSD) ---

export type ExportNodeType = 'frame' | 'group' | 'rectangle' | 'ellipse' | 'vector' | 'text' | 'instance' | 'component' | 'other';

export interface ExportFillInfo {
  type: 'SOLID' | 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'GRADIENT_ANGULAR' | 'GRADIENT_DIAMOND' | 'IMAGE';
  color?: SerializedColor;
  opacity?: number;
  gradientStops?: { position: number; color: SerializedColor }[];
  gradientAngle?: number;
  visible: boolean;
}

export interface ExportStrokeInfo {
  color: SerializedColor;
  /** 默认 SOLID；渐变描边为 GRADIENT_* */
  fillType?: 'SOLID' | 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'GRADIENT_ANGULAR' | 'GRADIENT_DIAMOND';
  gradientStops?: { position: number; color: SerializedColor }[];
  gradientAngle?: number;
  weight: number;
  align: 'INSIDE' | 'OUTSIDE' | 'CENTER';
  opacity: number;
  visible: boolean;
}

export interface ExportTextStyleRange {
  start: number;
  end: number;
  fontFamily: string;
  fontStyle: string;
  fontSize: number;
  color: SerializedColor;
  letterSpacing: number;
  lineHeight: number | null;
  /** Text case read back from the node. Restored to PSD fontCaps on export. */
  textCase?: SerializedTextCase;
}

export interface ExportTextInfo {
  characters: string;
  alignment: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
  styles: ExportTextStyleRange[];
  textAutoResize?: 'NONE' | 'HEIGHT' | 'WIDTH_AND_HEIGHT';
  /** 原始 PSD 文本 shapeType（point/box）。栅格化文本把 textAutoResize 强制设为 NONE 对齐 companion，
   * 会污染 isPointText 判定；导出时优先用此字段决定走 point/box 分支，保留缩放/旋转 transform。 */
  shapeType?: 'point' | 'box';
  /** Asymmetric font offset from visual character center to PSD transform.tx.
   * Positive value means PSD tx is right of visual center. */
  txOffsetX?: number;
  /** Original PSD bounds (font-metric-derived character bbox relative to transform) */
  bounds?: PsdTextBounds;
  /** Original PSD boundingBox (actual character pixel bbox relative to transform) */
  boundingBox?: PsdTextBounds;
  /** Original PSD layer.text.index for TextFrameSet lookup. */
  textIndex?: number;
  /** Original PSD transform.sy (vertical scale). Import time multiplies fontSize by this;
   * export time multiplies boundingBox.top/bottom by this so layer.top matches the original PSD. */
  transformScale?: number;
  /** Original PSD transform.sx (horizontal scale). May differ from sy.
   * Export time uses this for transform matrix [sx, 0, 0, sy, tx, ty] to match original character positions. */
  transformScaleX?: number;
  /** Original PSD transform.tx, used for sub-pixel exact restoration at export. */
  transformTx?: number;
  /** Original PSD transform.ty, used for sub-pixel exact restoration at export. */
  transformTy?: number;
  /** PSD 文本弯曲（warp）变形。从节点 pluginData 读回，导出时写回 layer.text.warp。 */
  warp?: SerializedWarp;
  /** mastergo/figma node.x at import time (anchor). Combined with transformTx,
   * export ty/tx = original_psd_ty/tx + (current node - anchor), avoiding sub-pixel precision loss. */
  anchorNodeX?: number;
  /** mastergo/figma node.y at import time (anchor). */
  anchorNodeY?: number;
  /** Multi-stroke clone group id (shared by main node and all clones).
   * Present only when imported from a PSD text layer with multiple strokes. */
  multiStrokeGroupId?: string;
  /** Position within the multi-stroke group: 0 = topmost (main node, stroke[0] in PSD). */
  multiStrokeIndex?: number;
  /** Total number of clones in the multi-stroke group. */
  multiStrokeTotal?: number;
  /** Offset of absoluteRenderBounds vs absoluteBoundingBox for text PNG.
   * Used to position MasterGo-rendered text PNG correctly within PSD layer bbox. */
  renderBoundsOffset?: {
    dx: number;
    dy: number;
    w: number;
    h: number;
    nodeW: number;
    nodeH: number;
  };
  /** round-trip 兜底：原始 PSD 文本栅格像素（base64 PNG）+ 原始文档坐标 bounds。从节点 pluginData
   * 读回，导出时优先写回图层像素，规避 MasterGo 字形度量差异导致的裁剪。仅文本未被编辑时存在。 */
  rawImage?: { base64: string; left: number; top: number; width: number; height: number };
  /** 原始 PSD 文本内容，导出端用于判断是否编辑过（此字段校验通过后才填 rawImage）。 */
  originalText?: string;
}

export interface ExportEffectInfo {
  type: 'DROP_SHADOW' | 'INNER_SHADOW';
  color: SerializedColor;
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
  visible: boolean;
  /** 平台节点 effect 的混合模式（'NORMAL'/'MULTIPLY'/...）。导出时映射回 PSD blendMode，
   * 避免一律硬编码成 multiply 丢失原始（如 normal）混合模式。 */
  blendMode?: string;
}

export interface ExportNodeData {
  id: string;
  name: string;
  type: ExportNodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  /** MasterGo/Figma 节点旋转角（度）。非文本位图层 exportAsync PNG 基于 absoluteRenderBounds，需据此定位 bbox。 */
  rotation?: number;
  opacity: number;
  blendMode: string;
  visible: boolean;
  clipsContent: boolean;
  isMask: boolean;
  /** 导入时写入的原始 PSD layer.clipping；有值时导出优先于 isMask 推断。 */
  psdClipping?: boolean;
  isInstance: boolean;

  imageBase64?: string;
  fills: ExportFillInfo[];
  strokes: ExportStrokeInfo[];
  effects: ExportEffectInfo[];
  textInfo?: ExportTextInfo;
  cornerRadii?: SerializedCornerRadii;
  children?: ExportNodeData[];
  /**
   * 从节点 setPluginData('psd_raw_effects', ...) 读出的原始 PSD effects JSON。
   * 导出 PSD 时作为 fallback：figma/mastergo 上能提取到的字段（fills/strokes/effects）
   * 优先使用，原始数据用于补全 figma/mastergo 无法表达的高级效果（bevel/satin/glow 等)。
   */
  rawPsdEffects?: string;
  /**
   * 从节点 setPluginData('psd_expand_offset', ...) 读出的扩展边框像素。
   * import 时为容纳 stroke 像素，把位图层向四周扩展了该像素数。
   * export 时 node-serializer 已把 x/y/width/height 减回到原始 bbox，
   * 但 imageBase64 仍是 expand 后的尺寸，psd-builder 需要据此裁剪 canvas 边框。
   */
  psdExpandOffset?: number;
  /**
   * 从节点 setPluginData('psd_vector_data', ...) 读出的原始 PSD 矢量形状数据
   * （vectorMask + vectorFill + vectorOrigination）。导出 PSD 时让 PS 显示
   * appearance 面板的 Fill/Stroke/圆角等矢量属性。
   */
  rawPsdVectorData?: string;
  /**
   * 从节点 setPluginData('psd_adjustments', ...) 读出的原始 PSD 调整图层数据。
   * 导出 PSD 时在 base 层之后还原为 clipping 调整图层。
   */
  rawPsdAdjustments?: string;
  /**
   * 从节点 setPluginData('psd_original_image', ...) 读出的基底层「烘焙调整前原始像素」base64 PNG。
   * 导出时用它替换基底层位图，再加回调整图层，避免调整双重应用导致的颜色偏移。
   */
  rawPsdOriginalImage?: string;
  /**
   * 从节点 setPluginData('psd_pre_pattern_image', ...) 读出的「patternOverlay 烘焙前原始像素」base64 PNG。
   * 导出时用它替换图层位图 + 保留 patternOverlay effect + 写回 pattern 资源，避免 pattern 双重应用。
   */
  rawPsdPrePatternImage?: string;
  /** 从 setPluginData('psd_channel_image') 读出的 PSD channel 原始像素（效果合成前）。 */
  rawPsdChannelImage?: string;
  /**
   * 从节点 setPluginData('psd_smart_object', ...) 读出的智能对象 round-trip 数据 JSON
   * （{ origImageB64, transform, soId, width, height, filter }）。
   * 导出时优先用原始模糊像素 + transform 重建 placedLayer 智能对象图层。
   */
  rawPsdSmartObject?: string;
  /**
   * 从节点 setPluginData('psd_group_mask', ...) 读出的组矩形图层蒙版数据 JSON
   * （{left,top,width,height,defaultColor}，坐标相对组 frame）。
   * 导出 PSD 时在组 layer 上重建矩形 layer mask，还原 PS 中的滚动视口裁剪。
   */
  rawPsdGroupMask?: string;
  /**
   * 从节点 setPluginData('psd_layer_mask', ...) 读出的普通层 layer mask 数据 JSON
   * （{left,top,width,height,defaultColor,dataB64}，left/top 为相对层 bbox 偏移）。
   * 导出时叠加图层最终坐标，在该层上重建可编辑 layer mask。
   */
  rawPsdLayerMask?: string;
  /**
   * 从节点 setPluginData('psd_layer_mask_image', ...) 读出的「烘焙 mask 前原始像素」base64 PNG。
   * 导出时用它作 canvas，配合 rawPsdLayerMask 还原 layer.mask，避免 mask 双重裁剪。
   */
  rawPsdLayerMaskImage?: string;
  /**
   * 从节点 setPluginData('psd_inherited_group_fx', ...) 读出的标记：本层 effects 含父组下放副本。
   * 导出时若本层无 rawPsdEffects 兜底，则丢弃节点上的 dropShadow/innerShadow（视为下放伪影）。
   */
  inheritedGroupEffects?: boolean;
  /** 从节点 setPluginData('psd_inherited_group_stroke', ...) 读出的标记：本层 strokes 含父组下放副本。 */
  inheritedGroupStrokes?: boolean;
  /** 像素已含同组 PASS_THROUGH 穿透叠加层的合成结果，勿再写 solidFill/gradientOverlay 以免双重应用。 */
  passThroughBaked?: boolean;
  /** isMask 裁剪层：exportAsync 保留 MG 合成（含模糊/multiply），勿再 strip effects 或叠 hard mask。 */
  platformRenderBaked?: boolean;
  /**
   * 9-Slice 九宫元数据 JSON（与 nineSliceSettings plugin data 同格式）。
   * 导出 PSD 时编码进图层名；导入时写回 setPluginData('nineSliceSettings')，供 9slice 插件还原。
   */
  nineSliceSettings?: string;
}

export interface ExportSelectionInfo {
  count: number;
  names: string[];
}

export type PluginMessage =
  | { type: 'import-psd'; data: SerializedPsd; batchIndex?: number; batchTotal?: number }
  | { type: 'import-psd-batch-start'; total: number }
  | { type: 'import-psd-batch-end' }
  | { type: 'progress'; percent: number; message: string }
  | { type: 'error'; message: string }
  | { type: 'done' }
  | { type: 'progress-update'; percent: number; message: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'selection-changed'; data: ExportSelectionInfo }
  | { type: 'export-psd'; fileName: string }
  | { type: 'export-progress'; percent: number; message: string }
  | { type: 'export-psd-data'; nodes: ExportNodeData[]; width: number; height: number; engineData?: string; patterns?: string }
  | { type: 'export-psd-error'; message: string };
