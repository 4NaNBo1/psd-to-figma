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

export interface SerializedTextStyle {
  fontFamily: string;
  fontStyle: string;
  fontSize: number;
  color: SerializedColor;
  strokeColor?: SerializedColor;
  letterSpacing: number;
  lineHeight: number | null;
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

export interface PsdTextBounds {
  top: number;
  left: number;
  right: number;
  bottom: number;
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
  /** Original PSD bounds (font-metric-derived character bbox relative to transform) */
  bounds?: PsdTextBounds;
  /** Original PSD boundingBox (actual character pixel bbox relative to transform) */
  boundingBox?: PsdTextBounds;
  /** Original PSD layer.text.index (TextFrameSet index in top-level engineData). */
  textIndex?: number;
  gradientOverlay?: SerializedGradientOverlay;
  shapeType?: 'point' | 'box';
  boxBounds?: { width: number; height: number };
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
  effects: SerializedShadow[];
  strokes: SerializedStroke[];
  cornerRadii?: SerializedCornerRadii;
  expandOffset?: number;
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
}

export interface SerializedPsd {
  name: string;
  width: number;
  height: number;
  layers: SerializedLayer[];
  images: string[];
  /** Original PSD top-level engineData (Txt2 block, base64). Used to preserve text engine data on roundtrip. */
  engineData?: string;
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
}

export interface ExportTextInfo {
  characters: string;
  alignment: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
  styles: ExportTextStyleRange[];
  textAutoResize?: 'NONE' | 'HEIGHT' | 'WIDTH_AND_HEIGHT';
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
}

export interface ExportEffectInfo {
  type: 'DROP_SHADOW' | 'INNER_SHADOW';
  color: SerializedColor;
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
  visible: boolean;
}

export interface ExportNodeData {
  id: string;
  name: string;
  type: ExportNodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  blendMode: string;
  visible: boolean;
  clipsContent: boolean;
  isMask: boolean;
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
}

export interface ExportSelectionInfo {
  count: number;
  names: string[];
}

export type PluginMessage =
  | { type: 'import-psd'; data: SerializedPsd }
  | { type: 'progress'; percent: number; message: string }
  | { type: 'error'; message: string }
  | { type: 'done' }
  | { type: 'progress-update'; percent: number; message: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'selection-changed'; data: ExportSelectionInfo }
  | { type: 'export-psd'; fileName: string }
  | { type: 'export-progress'; percent: number; message: string }
  | { type: 'export-psd-data'; nodes: ExportNodeData[]; width: number; height: number }
  | { type: 'export-psd-error'; message: string };
