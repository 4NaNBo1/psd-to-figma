import type { PluginMessage, SerializedPsd } from './types/psd-types';
import { buildFigmaTree } from './converter/node-factory';

figma.showUI(__html__, { width: 400, height: 360, themeColors: true });

type LogLevel = 'info' | 'warn' | 'error';

function sendLog(level: LogLevel, message: string) {
  figma.ui.postMessage({ type: 'log', level, message } as PluginMessage);
}

figma.ui.onmessage = async (msg: PluginMessage) => {
  if (msg.type !== 'import-psd') return;

  const psd = msg.data;
  sendLog('info', `Received PSD: "${psd.name}" ${psd.width}x${psd.height}, ${psd.layers.length} layers, ${psd.images.length} images`);

  try {
    figma.ui.postMessage({
      type: 'progress-update',
      percent: 92,
      message: 'Creating Figma layers...',
    } as PluginMessage);

    sendLog('info', 'Building Figma tree...');

    await buildFigmaTree(psd, (percent, message) => {
      figma.ui.postMessage({
        type: 'progress-update',
        percent: 92 + Math.round(percent * 0.08),
        message,
      } as PluginMessage);
    }, sendLog);

    sendLog('info', 'Figma tree built successfully');
    figma.ui.postMessage({ type: 'done' } as PluginMessage);
    figma.notify('PSD import complete!');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error during import';
    sendLog('error', `Import failed: ${message}`);
    figma.ui.postMessage({ type: 'error', message } as PluginMessage);
    figma.notify('PSD import failed', { error: true });
  }
};
