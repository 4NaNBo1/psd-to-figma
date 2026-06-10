import type { PluginMessage, SerializedPsd } from './types/psd-types';
import { buildIRTree } from './ir/builder';
import { createRenderer } from './platform/index';
import { serializeSelection } from './exporter/node-serializer';

declare const __VERSION__: string;
declare const mg: any;
const isMasterGo = typeof mg !== 'undefined';

const api = isMasterGo ? mg : figma;

api.showUI(__html__, { width: 400, height: 460, title: `PSD Import & Export` });

// 批次内多个 PSD 水平依次排开时，相邻 section 之间的固定间距（画布像素）
const BATCH_GAP = 100;

// 主线程仅维护"上一份导入的占位矩形"用于布局，不负责批次统计/总结（由 UI 端负责）。
// UI 在每个新批次开始时发 `import-psd-batch-start` 重置 lastImportRect，
// 让该批次第一份 PSD 沿用默认位置 (0,0)；批中后续 PSD 依次水平排开。
let lastImportRect: { x: number; y: number; w: number; h: number } | null = null;

/** 计算下一份 PSD 根 section 的画布坐标。
 *  首份保持原版默认位置 (0, 0)；后续依次放在上一份右侧，避免叠在一起。 */
function computeNextPlacement(): { x: number; y: number } {
  if (lastImportRect) {
    return {
      x: lastImportRect.x + lastImportRect.w + BATCH_GAP,
      y: lastImportRect.y,
    };
  }
  return { x: 0, y: 0 };
}

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

  if (msg.type === 'import-psd-batch-start') {
    // 新批次开始：把锚点重置为当前视口（让首个文件落在用户当前视野中心）
    lastImportRect = null;
    sendLog('info', `Batch start: ${msg.total} file(s)`);
    return;
  }

  if (msg.type === 'import-psd-batch-end') {
    lastImportRect = null;
    return;
  }

  if (msg.type === 'import-psd') {
    const psd = msg.data;
    const batchIndex = msg.batchIndex ?? 0;
    const batchTotalForMsg = msg.batchTotal ?? 1;
    const isBatchTail = batchIndex >= batchTotalForMsg - 1;
    const prefix = batchTotalForMsg > 1 ? `[${batchIndex + 1}/${batchTotalForMsg}] ` : '';
    sendLog('info', `${prefix}Received PSD: "${psd.name}" ${psd.width}x${psd.height}, ${psd.layers.length} layers, ${psd.images.length} images`);

    try {
      api.ui.postMessage({
        type: 'progress-update',
        percent: 90,
        message: `${prefix}Building IR tree...`,
      } as PluginMessage);

      sendLog('info', `${prefix}Building IR tree...`);
      const irTree = buildIRTree(psd);
      sendLog('info', `${prefix}IR tree built: type=${irTree.type}, children=${irTree.children?.length}`);



      api.ui.postMessage({
        type: 'progress-update',
        percent: 92,
        message: `${prefix}Creating layers...`,
      } as PluginMessage);

      const renderer = createRenderer();
      sendLog('info', `${prefix}Renderer: ${renderer.constructor?.name}`);

      const placement = computeNextPlacement();

      await renderer.render(irTree, (percent, message) => {
        api.ui.postMessage({
          type: 'progress-update',
          percent: 92 + Math.round(percent * 0.08),
          message: `${prefix}${message}`,
        } as PluginMessage);
      }, sendLog, { placement, isBatchTail });

      // 记录占位矩形，供同批次后续文件水平排开
      lastImportRect = { x: placement.x, y: placement.y, w: psd.width, h: psd.height };

      sendLog('info', `${prefix}Render complete`);
      api.ui.postMessage({ type: 'done' } as PluginMessage);
      if (batchTotalForMsg === 1) api.notify('PSD import complete!');
      else if (isBatchTail) api.notify(`PSD 导入完成：${batchTotalForMsg} 个文件`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error during import';
      sendLog('error', `${prefix}Import failed: ${message}`);
      api.ui.postMessage({ type: 'error', message: `${prefix}${message}` } as PluginMessage);
      if (batchTotalForMsg === 1) api.notify('PSD import failed', { error: true });
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
        patterns: result.patterns,
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
