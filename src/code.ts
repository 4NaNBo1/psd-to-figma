import type { PluginMessage } from './types/psd-types';
import { buildIRTree } from './ir/builder';
import { createRenderer } from './platform/index';
import { serializeSelection } from './exporter/node-serializer';
import { getMessages, isLocale, type Locale } from './i18n';

const LOCALE_STORAGE_KEY = 'psd_plugin_locale';
let currentLocale: Locale = 'zh';

figma.showUI(__html__, {
  width: 340,
  height: 410,
  title: 'PSD Import & Export',
  themeColors: true,
});

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
  figma.ui.postMessage({ type: 'log', level, message } as PluginMessage);
}

function sendSelectionInfo() {
  const items = figma.currentPage.selection.map(({ id, name }) => ({ id, name }));
  figma.ui.postMessage({
    type: 'selection-changed',
    items,
  } as PluginMessage);
}

async function restoreSavedLocale() {
  try {
    const saved = await figma.clientStorage.getAsync(LOCALE_STORAGE_KEY);
    if (isLocale(saved)) {
      currentLocale = saved;
      figma.ui.postMessage({
        type: 'locale-loaded',
        locale: saved,
      } as PluginMessage);
    }
  } catch {
    // ignore storage errors
  }
}

figma.on('selectionchange', () => sendSelectionInfo());
void restoreSavedLocale();

figma.ui.onmessage = async (msg: PluginMessage) => {
  if (msg.type === 'set-locale') {
    if (isLocale(msg.locale)) {
      currentLocale = msg.locale;
      try {
        await figma.clientStorage.setAsync(LOCALE_STORAGE_KEY, msg.locale);
      } catch {
        // ignore storage errors
      }
    }
    return;
  }

  if (msg.type === 'request-selection') {
    sendSelectionInfo();
    return;
  }

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
    const locale = isLocale(msg.locale) ? msg.locale : currentLocale;
    const messages = getMessages(locale);
    sendLog('info', `${prefix}Received PSD: "${psd.name}" ${psd.width}x${psd.height}, ${psd.layers.length} layers, ${psd.images.length} images`);

    try {
      figma.ui.postMessage({
        type: 'progress-update',
        percent: 90,
        message: `${prefix}${messages.buildingIrTree}`,
      } as PluginMessage);

      sendLog('info', `${prefix}Building IR tree...`);
      const irTree = buildIRTree(psd);
      sendLog('info', `${prefix}IR tree built: type=${irTree.type}, children=${irTree.children?.length}`);

      figma.ui.postMessage({
        type: 'progress-update',
        percent: 92,
        message: `${prefix}${messages.creatingLayers}`,
      } as PluginMessage);

      const renderer = createRenderer();
      sendLog('info', `${prefix}Renderer: ${renderer.constructor?.name}`);

      const placement = computeNextPlacement();

      await renderer.render(irTree, (percent, message) => {
        figma.ui.postMessage({
          type: 'progress-update',
          percent: 92 + Math.round(percent * 0.08),
          message: `${prefix}${message}`,
        } as PluginMessage);
      }, sendLog, { placement, isBatchTail, locale });

      // 记录占位矩形，供同批次后续文件水平排开
      lastImportRect = { x: placement.x, y: placement.y, w: psd.width, h: psd.height };

      sendLog('info', `${prefix}Render complete`);
      figma.ui.postMessage({ type: 'done' } as PluginMessage);
      if (batchTotalForMsg === 1) figma.notify(messages.importCompleteNotify);
      else if (isBatchTail) figma.notify(messages.importBatchCompleteNotify(batchTotalForMsg));
    } catch (err) {
      const message = err instanceof Error ? err.message : messages.unknownImportError;
      sendLog('error', `${prefix}Import failed: ${message}`);
      figma.ui.postMessage({ type: 'error', message: `${prefix}${message}` } as PluginMessage);
      if (batchTotalForMsg === 1) figma.notify(messages.importFailedNotify, { error: true });
    }
    return;
  }

  if (msg.type === 'export-psd') {
    const locale = isLocale(msg.locale) ? msg.locale : currentLocale;
    const messages = getMessages(locale);
    sendLog('info', 'Export PSD requested');

    try {
      const node = await figma.getNodeByIdAsync(msg.nodeId);
      if (!node || node.type === 'DOCUMENT' || node.type === 'PAGE') {
        throw new Error(messages.exportNodeUnavailable);
      }
      const result = await serializeSelection(
        sendLog,
        (percent, message) => {
          figma.ui.postMessage({
            type: 'export-progress',
            percent,
            message,
          } as PluginMessage);
        },
        msg.scale,
        msg.ignoreHiddenLayers,
        locale,
        [node],
      );

      sendLog('info', `Serialized ${result.nodes.length} nodes, canvas ${result.width}x${result.height}`);

      figma.ui.postMessage({
        type: 'export-psd-data',
        nodes: result.nodes,
        width: result.width,
        height: result.height,
        engineData: result.engineData,
        patterns: result.patterns,
        compositeBase64: result.compositeBase64,
      } as PluginMessage);
    } catch (err) {
      const message = err instanceof Error ? err.message : messages.exportFailedFallback;
      sendLog('error', `Export failed: ${message}`);
      figma.ui.postMessage({
        type: 'export-psd-error',
        message,
      } as PluginMessage);
    }
    return;
  }
};
