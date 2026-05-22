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
}
