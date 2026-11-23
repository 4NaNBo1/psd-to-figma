import type { PlatformRenderer } from './types';
import { FigmaRenderer } from './figma-renderer';

export function createRenderer(): PlatformRenderer {
  return new FigmaRenderer();
}
