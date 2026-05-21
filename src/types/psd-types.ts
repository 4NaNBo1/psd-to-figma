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

export interface SerializedTextData {
  text: string;
  horizontalAlignment: string;
  styles: SerializedTextStyle[];
  transformScale: number;
  rotation?: number;
  docBoundsY?: number;
  docBboxCenterX?: number;
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
}

export interface SerializedPsd {
  name: string;
  width: number;
  height: number;
  layers: SerializedLayer[];
  images: string[];
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
