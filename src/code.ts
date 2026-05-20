import type { PluginMessage, SerializedPsd } from './types/psd-types';
import { buildIRTree } from './ir/builder';
import { createRenderer } from './platform/index';

declare const __VERSION__: string;
declare const mg: any;
const isMasterGo = typeof mg !== 'undefined';

const api = isMasterGo ? mg : figma;

api.showUI(__html__, { width: 400, height: 360, title: `PSD Importer by 4NaNBo1 - v${__VERSION__}` });

type LogLevel = 'info' | 'warn' | 'error';

function sendLog(level: LogLevel, message: string) {
  api.ui.postMessage({ type: 'log', level, message } as PluginMessage);
}

api.ui.onmessage = async (rawMsg: any) => {
  const msg: PluginMessage = isMasterGo && rawMsg?.pluginMessage ? rawMsg.pluginMessage : rawMsg;

  if (msg.type !== 'import-psd') return;

  const psd = msg.data;
  sendLog('info', `Received PSD: "${psd.name}" ${psd.width}x${psd.height}, ${psd.layers.length} layers, ${psd.images.length} images`);

  try {
    api.ui.postMessage({
      type: 'progress-update',
      percent: 90,
      message: 'Building IR tree...',
    } as PluginMessage);

    sendLog('info', 'Building IR tree...');
    const irTree = buildIRTree(psd);
    sendLog('info', `IR tree built: type=${irTree.type}, children=${irTree.children?.length}`);

    api.ui.postMessage({
      type: 'progress-update',
      percent: 92,
      message: 'Creating layers...',
    } as PluginMessage);

    const renderer = createRenderer();
    sendLog('info', `Renderer: ${renderer.constructor?.name}`);

    await renderer.render(irTree, (percent, message) => {
      api.ui.postMessage({
        type: 'progress-update',
        percent: 92 + Math.round(percent * 0.08),
        message,
      } as PluginMessage);
    }, sendLog);

    sendLog('info', 'Render complete');
    api.ui.postMessage({ type: 'done' } as PluginMessage);
    api.notify('PSD import complete!');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error during import';
    sendLog('error', `Import failed: ${message}`);
    api.ui.postMessage({ type: 'error', message } as PluginMessage);
    api.notify('PSD import failed', { error: true });
  }
};
