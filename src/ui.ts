import { parsePsdFile } from './parser/psd-parser';
import type { SerializedPsd, PluginMessage, ExportNodeData } from './types/psd-types';
import { buildAndDownloadPsd } from './exporter/psd-builder';
import { logger } from './logger';

declare const __VERSION__: string;

const REPO_OWNER = '4NaNBo1';
const REPO_NAME = 'psd-to-figma';
const CURRENT_VERSION = __VERSION__;

// Import tab elements
const dropZone = document.getElementById('dropZone')!;
const fileInput = document.getElementById('fileInput') as HTMLInputElement;
const progressArea = document.getElementById('progressArea')!;
const progressFill = document.getElementById('progressFill')!;
const progressText = document.getElementById('progressText')!;
const errorArea = document.getElementById('errorArea')!;
const copyLogBtn = document.getElementById('copyLogBtn') as HTMLButtonElement;
const footer = document.getElementById('footer')!;

// Tab elements
const tabBtns = document.querySelectorAll<HTMLButtonElement>('.tab-btn');
const tabImport = document.getElementById('tabImport')!;
const tabExport = document.getElementById('tabExport')!;

// Export tab elements
const selectionInfo = document.getElementById('selectionInfo')!;
const filenameRow = document.getElementById('filenameRow')!;
const exportFileName = document.getElementById('exportFileName') as HTMLInputElement;
const exportBtn = document.getElementById('exportBtn') as HTMLButtonElement;
const exportProgressArea = document.getElementById('exportProgressArea')!;
const exportProgressFill = document.getElementById('exportProgressFill')!;
const exportProgressText = document.getElementById('exportProgressText')!;
const exportErrorArea = document.getElementById('exportErrorArea')!;

footer.innerHTML =
  `by <a id="authorLink">${REPO_OWNER}</a> · <a id="versionLink">v${CURRENT_VERSION}</a>`;

document.getElementById('authorLink')!.addEventListener('click', (e) => {
  e.preventDefault();
  window.open(`https://github.com/${REPO_OWNER}`, '_blank');
});
document.getElementById('versionLink')!.addEventListener('click', (e) => {
  e.preventDefault();
  window.open(`https://github.com/${REPO_OWNER}/${REPO_NAME}`, '_blank');
});

let isProcessing = false;
let isExporting = false;
let selectionCount = 0;
// 文件名是否处于"自动跟随选中"状态：true 表示当前值由选中节点自动填入，
// 用户手动编辑后变为 false，输入框被清空后再恢复为 true
let isAutoFileName = true;

// 批量/二次导入队列状态
// pendingFiles: 等待处理的文件队列（FIFO）
// batchTotal/batchProcessed: 当前批次进度（用于 "[i/N] 文件名 — XX%" 显示）
// activeBatchOpen: 是否已向主线程发过 import-psd-batch-start 但还未发 end
// batchSuccessCount/batchErrorCount: 用于 UI 端的批次总结展示
const pendingFiles: File[] = [];
let batchTotal = 0;
let batchProcessed = 0;
let activeBatchOpen = false;
let batchSuccessCount = 0;
let batchErrorCount = 0;
let currentFileName = '';

// --- Tab switching ---
tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    tabBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    tabImport.classList.toggle('active', tab === 'import');
    tabExport.classList.toggle('active', tab === 'export');
  });
});

function showProgress(percent: number, message: string) {
  progressArea.classList.add('visible');
  progressFill.style.width = `${percent}%`;
  progressText.textContent = message;
}

function showError(message: string) {
  errorArea.classList.add('visible');
  errorArea.textContent = message;
}

function resetUI() {
  progressArea.classList.remove('visible');
  errorArea.classList.remove('visible');
  progressFill.style.width = '0%';
  progressText.textContent = '';
  errorArea.textContent = '';
}

/** 把用户选/拖的文件过滤后加入队列，并启动下一项处理。
 *  允许在 isProcessing=true 时调用：新文件会排在当前文件之后顺序执行（不重置锚点）。 */
function enqueueFiles(rawFiles: FileList | File[]) {
  const all = Array.from(rawFiles);
  const psdFiles = all.filter((f) => f.name.toLowerCase().endsWith('.psd'));
  const ignored = all.length - psdFiles.length;

  if (psdFiles.length === 0) {
    logger.warn(`Rejected ${all.length} file(s): no .psd`);
    if (!activeBatchOpen) showError('请选择 .psd 文件');
    return;
  }
  if (ignored > 0) {
    logger.warn(`Ignored ${ignored} non-.psd file(s)`);
  }

  // 仅在"开启全新批次"时清日志/重置 UI/通知主线程重置锚点；
  // 批中追加文件不会清掉之前的进度，也不会让主线程的 lastImportRect 失效
  const isNewBatch = !activeBatchOpen;
  if (isNewBatch) {
    logger.clear();
    resetUI();
    batchTotal = 0;
    batchProcessed = 0;
    batchSuccessCount = 0;
    batchErrorCount = 0;
    activeBatchOpen = true;
  }

  for (const f of psdFiles) pendingFiles.push(f);
  batchTotal += psdFiles.length;

  logger.info(
    isNewBatch
      ? `Queued ${psdFiles.length} file(s)${ignored > 0 ? `, ignored ${ignored}` : ''}`
      : `Appended ${psdFiles.length} file(s) to current batch (total ${batchTotal})`
  );

  if (isNewBatch) {
    const startMsg: PluginMessage = { type: 'import-psd-batch-start', total: batchTotal };
    parent.postMessage({ pluginMessage: startMsg }, '*');
  }

  void startNext();
}

/** 从队列取出一个文件，解析后发送给主线程。串行执行：必须等 done/error 才继续。 */
async function startNext(): Promise<void> {
  if (isProcessing) return;
  const file = pendingFiles.shift();
  if (!file) {
    // 批次结束：通知主线程做总结 notify，UI 端归位为"等待二次导入"
    if (activeBatchOpen) {
      const endMsg: PluginMessage = { type: 'import-psd-batch-end' };
      parent.postMessage({ pluginMessage: endMsg }, '*');
      activeBatchOpen = false;

      if (batchTotal > 1) {
        const summary = `共 ${batchSuccessCount} 个成功${batchErrorCount > 0 ? ` / ${batchErrorCount} 失败` : ''}`;
        progressText.textContent = summary;
        if (batchErrorCount > 0) {
          showError(`${batchErrorCount} 个文件失败，详见日志`);
        }
      }
      batchTotal = 0;
      batchProcessed = 0;
    }
    return;
  }

  isProcessing = true;
  currentFileName = file.name;
  const idx = batchProcessed; // 0-based
  const prefix = batchTotal > 1 ? `[${idx + 1}/${batchTotal}] ` : '';

  logger.info(`${prefix}Start import: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
  showProgress(0, `${prefix}${file.name} — 读取中...`);

  try {
    const buffer = await file.arrayBuffer();
    logger.info(`${prefix}File read into memory`);

    showProgress(5, `${prefix}${file.name} — 解析中...`);

    const psd = await parsePsdFile(buffer, (p) => {
      showProgress(p.percent, `${prefix}${file.name} — ${p.message}`);
    });

    logger.info(`${prefix}PSD parsed: ${psd.width}x${psd.height}, ${psd.layers.length} top-level layers, ${psd.images.length} images`);
    showProgress(90, `${prefix}${file.name} — 发送到主线程...`);

    psd.name = file.name.replace(/\.psd$/i, '');
    const message: PluginMessage = {
      type: 'import-psd',
      data: psd,
      batchIndex: idx,
      batchTotal,
    };
    parent.postMessage({ pluginMessage: message }, '*');
    logger.info(`${prefix}PSD data sent to plugin main thread`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Unknown error occurred';
    logger.error(`${prefix}PSD parse failed: ${errMsg}`);
    showError(`${prefix}${file.name} 解析失败：${errMsg}`);
    batchErrorCount++;
    batchProcessed++;
    isProcessing = false;
    void startNext();
  }
}

dropZone.addEventListener('click', () => {
  // dropzone 始终允许点击：当前批次进行中也可追加文件
  fileInput.click();
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const files = e.dataTransfer?.files;
  if (files && files.length > 0) {
    enqueueFiles(files);
  }
});

fileInput.addEventListener('change', () => {
  if (fileInput.files && fileInput.files.length > 0) {
    enqueueFiles(fileInput.files);
    // 清空 value 以便重复选同名文件也会触发 change
    fileInput.value = '';
  }
});

const ICON_COPY = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';

copyLogBtn.addEventListener('click', () => {
  const text = logger.toClipboardText();

  function onCopySuccess() {
    copyLogBtn.innerHTML = ICON_CHECK;
    copyLogBtn.classList.add('copied');
    setTimeout(() => {
      copyLogBtn.innerHTML = ICON_COPY;
      copyLogBtn.classList.remove('copied');
    }, 1500);
  }

  function fallbackCopy(str: string): boolean {
    const ta = document.createElement('textarea');
    ta.value = str;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { /* ignore */ }
    document.body.removeChild(ta);
    return ok;
  }

  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(onCopySuccess).catch(() => {
      if (fallbackCopy(text)) onCopySuccess();
    });
  } else {
    if (fallbackCopy(text)) onCopySuccess();
  }
});

// --- Export tab logic ---
function showExportProgress(percent: number, message: string) {
  exportProgressArea.classList.add('visible');
  exportProgressFill.style.width = `${percent}%`;
  exportProgressText.textContent = message;
}

function showExportError(message: string) {
  exportErrorArea.classList.add('visible');
  exportErrorArea.textContent = message;
}

function resetExportUI() {
  exportProgressArea.classList.remove('visible');
  exportErrorArea.classList.remove('visible');
  exportProgressFill.style.width = '0%';
  exportProgressText.textContent = '';
  exportErrorArea.textContent = '';
}

function updateSelectionDisplay(count: number, names: string[]) {
  selectionCount = count;
  if (count === 0) {
    selectionInfo.innerHTML =
      '<div class="sel-icon">&#127912;</div>' +
      '<div class="sel-text">请在画布中选中要导出的节点</div>';
    filenameRow.style.display = 'none';
    exportBtn.disabled = true;
  } else {
    const nameList = names.slice(0, 3).join('、') + (names.length > 3 ? ` 等` : '');
    selectionInfo.innerHTML =
      '<div class="sel-icon">&#9989;</div>' +
      `<div class="sel-count">已选中 ${count} 个节点</div>` +
      `<div class="sel-names">${nameList}</div>`;
    filenameRow.style.display = 'flex';
    // 选中多个时取第一个；处于自动跟随状态则始终更新文件名
    if (isAutoFileName) {
      exportFileName.value = names[0] ?? 'export';
    }
    exportBtn.disabled = false;
  }
}

exportFileName.addEventListener('input', () => {
  // 用户清空输入框 → 恢复为自动跟随；否则视为手动编辑
  isAutoFileName = exportFileName.value.trim() === '';
});

exportBtn.addEventListener('click', () => {
  if (isExporting || selectionCount === 0) return;
  isExporting = true;
  exportBtn.disabled = true;
  resetExportUI();

  const fileName = exportFileName.value.trim() || 'export';
  showExportProgress(0, '开始导出...');
  logger.info(`Export started: ${fileName}`);

  const message: PluginMessage = { type: 'export-psd', fileName };
  parent.postMessage({ pluginMessage: message }, '*');
});

window.onmessage = (event) => {
  const raw = event.data;
  const msg = (raw?.pluginMessage ?? raw) as PluginMessage;
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'progress-update':
      showProgress(msg.percent, msg.message);
      break;
    case 'done': {
      const prefix = batchTotal > 1 ? `[${batchProcessed + 1}/${batchTotal}] ` : '';
      showProgress(100, `${prefix}${currentFileName || ''} — 完成`);
      batchSuccessCount++;
      batchProcessed++;
      isProcessing = false;
      void startNext();
      break;
    }
    case 'error': {
      const prefix = batchTotal > 1 ? `[${batchProcessed + 1}/${batchTotal}] ` : '';
      logger.error(`${prefix}Plugin error: ${msg.message}`);
      showError(msg.message);
      batchErrorCount++;
      batchProcessed++;
      isProcessing = false;
      void startNext();
      break;
    }
    case 'log':
      logger[msg.level](msg.message);
      break;

    case 'selection-changed':
      updateSelectionDisplay(msg.data.count, msg.data.names);
      break;

    case 'export-progress':
      showExportProgress(msg.percent, msg.message);
      break;

    case 'export-psd-data': {
      const nodes = msg.nodes as ExportNodeData[];
      const fileName = exportFileName.value.trim() || 'export';
      showExportProgress(65, '构建 PSD 文件...');

      buildAndDownloadPsd(nodes, msg.width, msg.height, fileName, (percent, message) => {
        showExportProgress(percent, message);
      }, msg.engineData).then(() => {
        logger.info('Export complete');
        isExporting = false;
        exportBtn.disabled = selectionCount === 0;
      }).catch((err) => {
        const errMsg = err instanceof Error ? err.message : 'PSD 生成失败';
        logger.error(`Export failed: ${errMsg}`);
        isExporting = false;
        exportBtn.disabled = selectionCount === 0;
      });
      break;
    }

    case 'export-psd-error':
      logger.error(`Export error: ${msg.message}`);
      showExportError(msg.message);
      isExporting = false;
      exportBtn.disabled = selectionCount === 0;
      break;
  }
};

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

async function checkForUpdate() {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`
    );
    if (!res.ok) return;

    const data = await res.json();
    const tag: string = data.tag_name ?? '';
    const latest = tag.replace(/^v/, '');

    if (!latest || compareVersions(latest, CURRENT_VERSION) <= 0) return;

    const link = document.createElement('a');
    link.textContent = `v${latest} ↑`;
    link.style.color = '#4ade80';
    link.href = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/tag/${tag}`;
    link.addEventListener('click', (e) => {
      e.preventDefault();
      window.open(link.href, '_blank');
    });
    footer.appendChild(document.createTextNode(' · '));
    footer.appendChild(link);
  } catch {
    // silently ignore network errors
  }
}

checkForUpdate();
