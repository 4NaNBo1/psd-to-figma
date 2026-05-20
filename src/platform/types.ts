import type { IRNode } from '../ir/types';

export type LogFn = (level: 'info' | 'warn' | 'error', message: string) => void;
export type ProgressFn = (percent: number, message: string) => void;

export interface PlatformRenderer {
  render(tree: IRNode, onProgress: ProgressFn, onLog: LogFn): Promise<void>;
}
