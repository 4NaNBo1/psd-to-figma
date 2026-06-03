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
  scaleMode: 'FILL' | 'FIT' | 'CROP' | 'TILE';
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

export interface IRTextRange {
  start: number;
  end: number;
  fontFamily: string;
  fontStyle: string;
  fontSize: number;
  lineHeight: number | null;
  letterSpacing: number;
  fills: IRFill[];
}

export interface IRTextBounds {
  top: number;
  left: number;
  right: number;
  bottom: number;
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

  fills: IRFill[];
  effects: IRShadow[];
  strokes: IRStroke[];
  cornerRadii?: IRCornerRadii;

  textProps?: IRTextProps;
  children?: IRNode[];

  isRootFrame?: boolean;
  /** Set on the root section: original PSD top-level engineData (base64 Txt2 block) */
  psdEngineData?: string;
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
}
