import type { LayerEffectsInfo, LayerEffectShadow, LayerEffectStroke, Color } from 'ag-psd';
import type { SerializedShadow, SerializedStroke, SerializedColor } from '../types/psd-types';
import { convertBlendMode } from './blend-converter';

function resolveUnitsValue(v: { value: number; units: string } | undefined, fallback = 0): number {
  return v?.value ?? fallback;
}

function toSerializedColor(color: Color | undefined): SerializedColor {
  if (!color) return { r: 0, g: 0, b: 0, a: 1 };

  if ('r' in color && 'a' in color) {
    return {
      r: color.r / 255,
      g: color.g / 255,
      b: color.b / 255,
      a: (color as { a: number }).a / 255,
    };
  }
  if ('r' in color) {
    return {
      r: (color as { r: number }).r / 255,
      g: (color as { g: number }).g / 255,
      b: (color as { b: number }).b / 255,
      a: 1,
    };
  }

  return { r: 0, g: 0, b: 0, a: 1 };
}

function convertShadow(
  shadow: LayerEffectShadow,
  type: 'drop' | 'inner'
): SerializedShadow | null {
  // PS 中被禁用（眼睛关闭）的阴影不进入 IR：避免下发给 MasterGo 后被错误显示
  // （MasterGo 不严格尊重 effect 的 visible:false）。round-trip 导出不受影响：
  // 导出端按 visible 过滤，原始 effects 由 plugin data 还原。
  if (!shadow.enabled) return null;

  const angle = ((shadow.angle ?? 120) * Math.PI) / 180;
  const distance = resolveUnitsValue(shadow.distance);

  const color = toSerializedColor(shadow.color);
  const shadowOpacity = (shadow as { opacity?: number }).opacity ?? 1;
  color.a *= shadowOpacity;

  const size = resolveUnitsValue(shadow.size);
  const chokePct = resolveUnitsValue(shadow.choke) / 100;

  return {
    type,
    color,
    offsetX: Math.round(Math.cos(angle) * distance),
    offsetY: Math.round(Math.sin(angle) * distance),
    blur: size * (1 - chokePct),
    spread: size * chokePct,
    blendMode: convertBlendMode(shadow.blendMode),
    visible: shadow.enabled !== false,
  };
}

export function convertEffects(effects: LayerEffectsInfo | undefined): SerializedShadow[] {
  if (!effects || effects.disabled) return [];

  const result: SerializedShadow[] = [];

  if (effects.dropShadow) {
    for (const ds of effects.dropShadow) {
      const converted = convertShadow(ds, 'drop');
      if (converted) result.push(converted);
    }
  }

  if (effects.innerShadow) {
    for (const is of effects.innerShadow) {
      const converted = convertShadow(is, 'inner');
      if (converted) result.push(converted);
    }
  }

  if (effects.outerGlow?.enabled) {
    const glow = effects.outerGlow;
    result.push({
      type: 'drop',
      color: toSerializedColor(glow.color),
      offsetX: 0,
      offsetY: 0,
      blur: resolveUnitsValue(glow.size),
      spread: resolveUnitsValue(glow.choke),
      blendMode: convertBlendMode(glow.blendMode),
      visible: true,
    });
  }

  if (effects.innerGlow?.enabled) {
    const glow = effects.innerGlow;
    result.push({
      type: 'inner',
      color: toSerializedColor(glow.color),
      offsetX: 0,
      offsetY: 0,
      blur: resolveUnitsValue(glow.size),
      spread: resolveUnitsValue(glow.choke),
      blendMode: convertBlendMode(glow.blendMode),
      visible: true,
    });
  }

  return result;
}

export function convertStrokes(effects: LayerEffectsInfo | undefined): SerializedStroke[] {
  if (!effects || effects.disabled) return [];
  if (!effects.stroke) return [];

  const result: SerializedStroke[] = [];
  for (const s of effects.stroke) {
    if (!s.enabled) continue;
    if (s.fillType !== 'color') continue;

    const pos = s.position ?? 'outside';
    result.push({
      color: toSerializedColor(s.color),
      width: resolveUnitsValue(s.size),
      position: pos as 'inside' | 'center' | 'outside',
      blendMode: convertBlendMode(s.blendMode),
      opacity: s.opacity ?? 1,
      visible: true,
    });
  }
  return result;
}

export { toSerializedColor };
