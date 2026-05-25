import type { IRNode } from '../ir/types';

export type LogFn = (level: 'info' | 'warn' | 'error', message: string) => void;
export type ProgressFn = (percent: number, message: string) => void;

export interface RenderPlacement {
  x: number;
  y: number;
}

export interface RenderOptions {
  /** 根 section 的目标画布坐标；缺省时按 (0, 0) 摆放（兼容旧行为）。 */
  placement?: RenderPlacement;
  /** 是否为本批次最后一个文件；仅 tail 时调用 viewport 聚焦，避免多文件互相把视口拽走。 */
  isBatchTail?: boolean;
}

export interface PlatformRenderer {
  render(tree: IRNode, onProgress: ProgressFn, onLog: LogFn, options?: RenderOptions): Promise<void>;
}
