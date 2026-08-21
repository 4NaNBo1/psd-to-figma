export type IRNodeType = 'frame' | 'rectangle' | 'text' | 'section';

export interface IRColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface IRImageFill {
  type: 'IMAGE';
  imageBytes: Uint8Array;
  scaleMode: 'FILL' | 'FIT' | 'CROP' | 'TILE' | 'STRETCH';
}

export interface IRSolidFill {
  type: 'SOLID';
  color: IRColor;
  opacity?: number;
}

export interface IRGradientFill {
  type: 'GRADIENT_LINEAR';
  stops: { position: number; color: IRColor }[];
  transform: [[number, number, number], [number, number, number]];
  /** PSD source angle in degrees. PS convention: 0° = left-to-right, 90° = bottom-to-top. */
  angle: number;
}

export type IRFill = IRImageFill | IRSolidFill | IRGradientFill;

export interface IRShadow {
  type: 'DROP_SHADOW' | 'INNER_SHADOW';
  color: IRColor;
  offset: { x: number; y: number };
  radius: number;
  spread: number;
  visible: boolean;
  blendMode: string;
}

export interface IRStroke {
  fills: IRSolidFill[];
  weight: number;
  align: 'INSIDE' | 'OUTSIDE' | 'CENTER';
}

export interface IRCornerRadii {
  topLeft: number;
  topRight: number;
  bottomLeft: number;
  bottomRight: number;
}

/** Text case for a range. Maps from PSD fontCaps (0/1/2). */
export type IRTextCase = 'ORIGINAL' | 'UPPER' | 'SMALL_CAPS';

export interface IRTextRange {
  start: number;
  end: number;
  fontFamily: string;
  fontStyle: string;
  fontSize: number;
  lineHeight: number | null;
  letterSpacing: number;
  fills: IRFill[];
  /** All-caps / small-caps display. Omitted = ORIGINAL. */
  textCase?: IRTextCase;
}

export interface IRTextBounds {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

/** PSD 文本弯曲变形数据（见 SerializedWarp）。仅用于导出往返保真。 */
export interface IRWarp {
  style: string;
  value?: number;
  values?: number[];
  perspective?: number;
  perspectiveOther?: number;
  rotate?: string;
}

export interface IRTextProps {
  characters: string;
  alignment: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
  autoResize: 'WIDTH_AND_HEIGHT' | 'HEIGHT' | 'NONE';
  width: number;
  height: number;
  ranges: IRTextRange[];
  gradientOverlay?: IRGradientFill;
  rotation?: number;
  position: { x: number; y: number };
  shapeType?: 'point' | 'box';
  docBoundsY?: number;
  docBboxCenterX?: number;
  txOffsetX?: number;
  /** 旋转文本专用：旋转后 boundingBox 中心的画布坐标。平台 rotation 绕节点中心旋转，
   * 渲染时令节点中心落在此点（text.x = cx − w/2, text.y = cy − h/2），绕中心旋转后视觉中心不变。 */
  docRotatedCenterX?: number;
  docRotatedCenterY?: number;
  bounds?: IRTextBounds;
  boundingBox?: IRTextBounds;
  textIndex?: number;
  /** PSD 原始 transform 的 sy（垂直缩放系数）。导入时 fontSize 已乘以 sy，导出时
   * 需要把 boundingBox.top/bottom 等"font-space"度量也乘以 sy 才能让 layer.top
   * 与原始 PSD 一致。 */
  transformScale?: number;
  /** PSD 原始 transform 的 sx（水平缩放系数）。非旋转情况下可能与 sy 不同
   * （如 Level 40 sx=1.0 sy=1.0021），export 时需要分别还原才能让水平字符位置匹配。 */
  transformScaleX?: number;
  /** PSD 原始 transform.tx（水平基线位置），用于精确还原（避开 mastergo 亚像素精度损失）。 */
  transformTx?: number;
  /** PSD 原始 transform.ty（垂直基线位置），用于精确还原。 */
  transformTy?: number;
  /** PSD 文本弯曲（warp）变形。Figma/MasterGo 不支持可编辑弧形弯曲，渲染时仅存入
   * 节点 pluginData，导出 PSD 时写回 layer.text.warp 以实现往返保真。 */
  warp?: IRWarp;
  /** round-trip 兜底：原始 PSD 文本栅格像素（base64 PNG）+ 原始文档坐标 bounds。渲染时存入节点
   * pluginData，导出时在文本未被编辑的前提下优先写回，规避平台字形度量差异导致的导出裁剪。 */
  rawImage?: { base64: string; left: number; top: number; width: number; height: number };
  /** 原始 PSD 文本内容，用于导出端判断是否被编辑过。 */
  originalText?: string;
}

export interface IRNode {
  type: IRNodeType;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  blendMode: string;
  visible: boolean;
  clipsContent: boolean;
  /** PSD 矢量 shape / 旋转位图层的旋转角（度，PS 屏幕坐标系）。 */
  rotation?: number;
  /** PSD 剪贴蒙版基底层标记。渲染器把该节点设为 isMask，用其 alpha 形状裁剪
   *  clip group 内排在其后的兄弟节点（对应 PS 剪贴蒙版）。 */
  isMask?: boolean;
  /** 原始 PSD layer.clipping；导出时优先于 isMask 推断，保证像素与剪贴语义一致。 */
  psdClipping?: boolean;
  /** 仅用于导入画布显示的辅助节点；导出 PSD 时跳过。 */
  isImportHelper?: boolean;

  fills: IRFill[];
  effects: IRShadow[];
  strokes: IRStroke[];
  cornerRadii?: IRCornerRadii;

  textProps?: IRTextProps;
  children?: IRNode[];

  isRootFrame?: boolean;
  /** Set on the root section: original PSD top-level engineData (base64 Txt2 block) */
  psdEngineData?: string;
  /** Set on the root section: PSD 全局 pattern 资源表的 JSON 序列化。round-trip 导出写回 psd.patterns。*/
  psdPatterns?: string;
  /**
   * 原始 PSD `layer.effects` 与 `layer.fillOpacity` 的 JSON 序列化数据。
   * 仅在位图/形状/智能对象图层 effects 被 rasterize 到 fill 时设置，
   * renderer 会写入节点的 setPluginData('psd_raw_effects', ...)，
   * figma/mastergo→PSD 回转时读出以还原所有高级效果。
   */
  rawPsdEffects?: string;
  /**
   * 位图层为容纳 stroke 等向外扩展像素时，psd-parser 把 layer 向四周扩展 expand 像素，
   * 把 expand 透传到 renderer，再写入 setPluginData('psd_expand_offset', ...)，
   * 这样 figma/mastergo→PSD 回转时可以减回这 expand 像素，还原成原始 layer bbox。
   */
  psdExpandOffset?: number;
  /**
   * 原始 PSD 矢量形状数据（vectorMask + vectorFill + vectorOrigination）的 JSON 序列化。
   * renderer 会写入 setPluginData('psd_vector_data', ...)，figma/mastergo→PSD 回转时
   * 还原 PS 中 appearance 面板的 Fill/Stroke/圆角/精确坐标等矢量属性。
   */
  rawPsdVectorData?: string;
  /**
   * 原始 PSD 调整图层数据的 JSON 序列化（clipping 在 base 层上的 adjustment layers）。
   * 导入时效果已烘焙到基底像素，此字段仅用于 round-trip 导出还原。
   * renderer 写入 setPluginData('psd_adjustments', ...)。
   */
  rawPsdAdjustments?: string;
  /**
   * 基底层「烘焙调整前原始像素」的 base64 PNG（仅带调整图层的基底层有）。
   * renderer 写入 setPluginData('psd_original_image', ...)，导出时用于还原原始像素 + 加回调整图层。
   */
  rawPsdOriginalImage?: string;
  /**
   * 「patternOverlay 烘焙之前」的原始像素 base64 PNG（仅纯 patternOverlay 场景）。
   * renderer 写入 setPluginData('psd_pre_pattern_image', ...)，导出时用它 + 保留 patternOverlay
   * effect + 写回 pattern 资源，避免「烤后像素 + 再叠加 pattern」双重应用。
   */
  rawPsdPrePatternImage?: string;
  /**
   * PSD 图层 channel 原始像素 base64 PNG（效果合成前，尺寸 = layer bbox）。
   * renderer 写入 setPluginData('psd_channel_image', ...)，9-slice 折叠导出时写回 PSD channel。
   */
  rawPsdChannelImage?: string;
  /**
   * 智能对象 round-trip 数据 JSON（{ origImageB64, transform, soId, width, height, filter }）。
   * renderer 写入 setPluginData('psd_smart_object', ...)，导出时用原始模糊像素 + transform 重建
   * placedLayer 智能对象图层。仅智能对象带模糊类智能滤镜（重渲染清晰像素）的层有。
   */
  rawPsdSmartObject?: string;
  /**
   * 组的矩形图层蒙版数据 JSON（{left,top,width,height,defaultColor}，坐标相对组 frame）。
   * frame 节点用 clipsContent + 蒙版框尺寸表达裁剪；renderer 写入
   * setPluginData('psd_group_mask', ...)，round-trip 导出时重建组的矩形 layer mask。
   */
  psdGroupMask?: string;
  /**
   * 普通光栅层的 layer mask 数据 JSON（{left,top,width,height,defaultColor,dataB64}）。
   * renderer 写入 setPluginData('psd_layer_mask', ...)，round-trip 导出时重建可编辑 layer mask。
   */
  psdLayerMask?: string;
  /**
   * 「烘焙 layer mask 前」的原始像素 base64 PNG。renderer 写入
   * setPluginData('psd_layer_mask_image', ...)，导出时用它作 canvas + 还原 layer.mask，避免双重裁剪。
   */
  rawPsdLayerMaskImage?: string;
  /**
   * 标记：本节点 effects 含「从父组下放来的」effect（见 SerializedLayer.inheritedGroupEffects）。
   * renderer 写入 setPluginData('psd_inherited_group_fx', '1')，导出端据此剔除下放的伪投影。
   */
  inheritedGroupEffects?: boolean;
  /** 同上，针对从父组下放来的 strokes。renderer 写入 setPluginData('psd_inherited_group_stroke', '1')。 */
  inheritedGroupStrokes?: boolean;
  /** 9-Slice 九宫元数据 JSON；renderer 写入 setPluginData('nineSliceSettings', ...)。 */
  nineSliceSettings?: string;
}
