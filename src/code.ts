import type { PluginMessage, SerializedPsd } from './types/psd-types';
import { buildIRTree } from './ir/builder';
import { createRenderer } from './platform/index';
import { serializeSelection } from './exporter/node-serializer';

declare const __VERSION__: string;
declare const mg: any;
const isMasterGo = typeof mg !== 'undefined';

const api = isMasterGo ? mg : figma;

api.showUI(__html__, { width: 400, height: 460, title: `PSD Import & Export` });

type LogLevel = 'info' | 'warn' | 'error';

function sendLog(level: LogLevel, message: string) {
  api.ui.postMessage({ type: 'log', level, message } as PluginMessage);
}

function sendSelectionInfo() {
  const page = isMasterGo ? mg.document.currentPage : api.currentPage;
  const selection = page.selection ?? [];
  const names = selection.map((n: any) => n.name ?? 'Unnamed');
  api.ui.postMessage({
    type: 'selection-changed',
    data: { count: selection.length, names },
  } as PluginMessage);
}

// Push initial selection state once UI is ready
sendSelectionInfo();

// Listen for selection changes
if (isMasterGo) {
  try {
    mg.on('selectionchange', () => sendSelectionInfo());
  } catch { /* MasterGo may not support this event */ }
} else {
  figma.on('selectionchange', () => sendSelectionInfo());
}

api.ui.onmessage = async (rawMsg: any) => {
  const msg: PluginMessage = isMasterGo && rawMsg?.pluginMessage ? rawMsg.pluginMessage : rawMsg;

  if (msg.type === 'import-psd') {
    const psd = (msg as { type: 'import-psd'; data: SerializedPsd }).data;
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
    return;
  }

  if (msg.type === 'export-psd') {
    sendLog('info', 'Export PSD requested');

    try {
      const result = await serializeSelection(
        sendLog,
        (percent, message) => {
          api.ui.postMessage({
            type: 'export-progress',
            percent,
            message,
          } as PluginMessage);
        },
      );

      sendLog('info', `Serialized ${result.nodes.length} nodes, canvas ${result.width}x${result.height}`);

      api.ui.postMessage({
        type: 'export-psd-data',
        nodes: result.nodes,
        width: result.width,
        height: result.height,
        engineData: result.engineData,
      } as PluginMessage);
    } catch (err) {
      const message = err instanceof Error ? err.message : '导出失败';
      sendLog('error', `Export failed: ${message}`);
      api.ui.postMessage({
        type: 'export-psd-error',
        message,
      } as PluginMessage);
    }
    return;
  }
};
