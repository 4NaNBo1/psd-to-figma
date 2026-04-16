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

export type PluginMessage =
  | { type: 'import-psd'; data: SerializedPsd }
  | { type: 'progress'; percent: number; message: string }
  | { type: 'error'; message: string }
  | { type: 'done' }
  | { type: 'progress-update'; percent: number; message: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };
