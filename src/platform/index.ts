import type { PlatformRenderer } from './types';
import { FigmaRenderer } from './figma-renderer';
import { MasterGoRenderer } from './mastergo-renderer';

declare const mg: any;

export function createRenderer(): PlatformRenderer {
  if (typeof mg !== 'undefined') {
    return new MasterGoRenderer();
  }
  return new FigmaRenderer();
}
