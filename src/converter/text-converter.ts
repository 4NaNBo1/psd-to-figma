import type { SerializedLayer } from '../types/psd-types';

type LogFn = (level: 'info' | 'warn' | 'error', message: string) => void;

const FALLBACK_FONT: FontName = { family: 'Inter', style: 'Regular' };

const POSTSCRIPT_TO_FAMILY: Record<string, string> = {
  'PingFangSC': 'PingFang SC',
  'PingFangTC': 'PingFang TC',
  'PingFangHK': 'PingFang HK',
  'STHeitiSC': 'Heiti SC',
  'STHeitiTC': 'Heiti TC',
  'STSongti': 'Songti SC',
  'STSongtiSC': 'Songti SC',
  'STSongtiTC': 'Songti TC',
  'STKaitiSC': 'Kaiti SC',
  'STKaitiTC': 'Kaiti TC',
  'STFangsongSC': 'STFangsong',
  'HiraginoSans': 'Hiragino Sans',
  'HiraginoSansGB': 'Hiragino Sans GB',
  'YuGothic': 'Yu Gothic',
  'YuMincho': 'Yu Mincho',
  'MicrosoftYaHei': 'Microsoft YaHei',
  'MicrosoftJhengHei': 'Microsoft JhengHei',
  'SimSun': 'SimSun',
  'SimHei': 'SimHei',
  'NotoSansSC': 'Noto Sans SC',
  'NotoSansTC': 'Noto Sans TC',
  'NotoSansCJKsc': 'Noto Sans CJK SC',
  'NotoSerifSC': 'Noto Serif SC',
  'NotoSerifCJKsc': 'Noto Serif CJK SC',
  'SourceHanSansSC': 'Source Han Sans SC',
  'SourceHanSansTC': 'Source Han Sans TC',
  'SourceHanSerifSC': 'Source Han Serif SC',
  'SourceHanSerifTC': 'Source Han Serif TC',
  'AdobeHeitiStd': 'Adobe Heiti Std',
  'AdobeSongStd': 'Adobe Song Std',
  'AdobeKaitiStd': 'Adobe Kaiti Std',
  'AdobeFangsongStd': 'Adobe Fangsong Std',
  'Helvetica': 'Helvetica',
  'HelveticaNeue': 'Helvetica Neue',
  'TimesNewRoman': 'Times New Roman',
  'ArialMT': 'Arial',
  'Arial': 'Arial',
  'Roboto': 'Roboto',
  'SFProText': 'SF Pro Text',
  'SFProDisplay': 'SF Pro Display',
  'SFProRounded': 'SF Pro Rounded',
};

const STYLE_MAP: Record<string, string> = {
  'Bold': 'Bold',
  'Italic': 'Italic',
  'BoldItalic': 'Bold Italic',
  'Bold Italic': 'Bold Italic',
  'Regular': 'Regular',
  'Light': 'Light',
  'Thin': 'Thin',
  'Ultralight': 'Ultralight',
  'Medium': 'Medium',
  'Semibold': 'Semibold',
  'SemiBold': 'Semibold',
  'Heavy': 'Heavy',
  'Black': 'Black',
  'ExtraBold': 'ExtraBold',
  'ExtraLight': 'ExtraLight',
  'DemiBold': 'Semibold',
  'Book': 'Book',
  'Roman': 'Regular',
  'Normal': 'Regular',
  'W3': 'W3',
  'W6': 'W6',
  'W9': 'W9',
};

function parseFontName(rawName: string): { family: string; style: string } {
  const cleaned = rawName.replace(/^\s+|\s+$/g, '');

  const lastDash = cleaned.lastIndexOf('-');
  if (lastDash > 0) {
    const prefix = cleaned.substring(0, lastDash);
    const suffix = cleaned.substring(lastDash + 1);

    const mappedFamily = POSTSCRIPT_TO_FAMILY[prefix];
    const mappedStyle = STYLE_MAP[suffix];

    if (mappedFamily) {
      return { family: mappedFamily, style: mappedStyle || suffix || 'Regular' };
    }

    if (mappedStyle) {
      const family = prefix
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
      return { family, style: mappedStyle };
    }

    const family = prefix
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
    return { family, style: suffix || 'Regular' };
  }

  const mapped = POSTSCRIPT_TO_FAMILY[cleaned];
  if (mapped) {
    return { family: mapped, style: 'Regular' };
  }

  const spaced = cleaned
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return { family: spaced, style: 'Regular' };
}

const ALIGNMENT_MAP: Record<string, 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED'> = {
  'left': 'LEFT',
  'center': 'CENTER',
  'right': 'RIGHT',
  'justify-left': 'JUSTIFIED',
  'justify-center': 'JUSTIFIED',
  'justify-right': 'JUSTIFIED',
  'justify-all': 'JUSTIFIED',
};

async function tryLoadFont(family: string, style: string): Promise<FontName | null> {
  try {
    const fontName: FontName = { family, style };
    await figma.loadFontAsync(fontName);
    return fontName;
  } catch {
    return null;
  }
}

async function loadBestFont(rawFamily: string, rawStyle: string, onLog: LogFn, layerName: string): Promise<FontName> {
  const direct = await tryLoadFont(rawFamily, rawStyle);
  if (direct) return direct;

  if (rawStyle !== 'Regular') {
    const regular = await tryLoadFont(rawFamily, 'Regular');
    if (regular) {
      onLog('warn', `Font "${rawFamily} ${rawStyle}" not found for "${layerName}", using "${rawFamily} Regular"`);
      return regular;
    }
  }

  onLog('warn', `Font "${rawFamily}" not available for "${layerName}", using fallback "${FALLBACK_FONT.family} ${FALLBACK_FONT.style}"`);
  try {
    await figma.loadFontAsync(FALLBACK_FONT);
    return FALLBACK_FONT;
  } catch {
    return FALLBACK_FONT;
  }
}

export async function applyTextProperties(
  node: TextNode,
  layer: SerializedLayer,
  onLog: LogFn
): Promise<void> {
  const td = layer.textData;
  if (!td || !td.text) return;
  const alignment = ALIGNMENT_MAP[td.horizontalAlignment] || 'LEFT';

  const firstStyle = td.styles.length > 0 ? td.styles[0] : null;
  let defaultFont: FontName;

  if (firstStyle) {
    const parsed = parseFontName(firstStyle.fontFamily);
    defaultFont = await loadBestFont(parsed.family, parsed.style, onLog, layer.name);
  } else {
    await figma.loadFontAsync(FALLBACK_FONT);
    defaultFont = FALLBACK_FONT;
  }

  node.fontName = defaultFont;

  const boxW = td.boxBounds?.width ?? 0;
  const boxH = td.boxBounds?.height ?? 0;
  const isBoxText = td.shapeType === 'box' && (boxW > 0 || (layer.width > 0 && layer.height > 0));
  const resizeW = boxW > 0 ? boxW : layer.width;
  const resizeH = boxH > 0 ? boxH : layer.height;
  if (isBoxText) {
    node.textAutoResize = 'HEIGHT';
    node.resize(resizeW, resizeH);
  } else {
    node.textAutoResize = 'WIDTH_AND_HEIGHT';
  }

  node.characters = td.text;
  node.textAlignHorizontal = alignment;

  if (isBoxText) {
    node.textAutoResize = 'NONE';
    node.resize(resizeW, resizeH);
  }


  if (td.styles.length > 0) {
    for (const style of td.styles) {
      const start = style.start;
      const end = Math.min(style.end, td.text.length);
      if (start >= end) continue;

      try {
        const parsed = parseFontName(style.fontFamily);
        const fontName = await loadBestFont(parsed.family, parsed.style, onLog, layer.name);
        node.setRangeFontName(start, end, fontName);

        if (style.fontSize > 0) {
          node.setRangeFontSize(start, end, style.fontSize);
          if (style.lineHeight != null && style.lineHeight > 0) {
            node.setRangeLineHeight(start, end, {
              value: style.lineHeight,
              unit: 'PIXELS',
            });
          } else {
            node.setRangeLineHeight(start, end, {
              value: style.fontSize,
              unit: 'PIXELS',
            });
          }
        }

        const c = style.color;
        node.setRangeFills(start, end, [
          { type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a },
        ]);

        if (style.letterSpacing !== 0) {
          node.setRangeLetterSpacing(start, end, {
            value: style.letterSpacing,
            unit: 'PIXELS',
          });
        }
      } catch (e) {
        onLog('warn', `Failed to apply text style range [${start}:${end}] for "${layer.name}": ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  if (td.gradientOverlay && td.gradientOverlay.type === 'linear') {
    const go = td.gradientOverlay;
    const angleRad = ((go.angle + 180) * Math.PI) / 180;
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);

    const cx = 0.5, cy = 0.5;
    const stops = go.reverse ? [...go.stops].reverse() : go.stops;

    const gradientStops: ColorStop[] = stops.map((s, i) => ({
      position: go.reverse ? 1 - s.position : s.position,
      color: { r: s.color.r, g: s.color.g, b: s.color.b, a: (s.color.a ?? 1) * go.opacity },
    }));

    const gradientPaint: GradientPaint = {
      type: 'GRADIENT_LINEAR',
      gradientStops,
      gradientTransform: [
        [cos, sin, cx - cos * cx - sin * cy],
        [-sin, cos, cy + sin * cx - cos * cy],
      ],
    };
    node.fills = [gradientPaint];
  }

}
