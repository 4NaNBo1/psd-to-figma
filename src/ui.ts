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

async function handleFile(file: File) {
  if (isProcessing) return;
  if (!file.name.toLowerCase().endsWith('.psd')) {
    logger.warn(`Rejected file: ${file.name} (not .psd)`);
    showError('Please select a .psd file');
    return;
  }

  isProcessing = true;
  logger.clear();
  resetUI();

  logger.info(`Start import: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
  showProgress(0, 'Reading file...');

  try {
    const buffer = await file.arrayBuffer();
    logger.info('File read into memory');

    showProgress(5, 'Parsing PSD...');

    const psd = await parsePsdFile(buffer, (p) => {
      showProgress(p.percent, p.message);
    });

    logger.info(`PSD parsed: ${psd.width}x${psd.height}, ${psd.layers.length} top-level layers, ${psd.images.length} images`);
    showProgress(90, 'Sending to Figma...');

    psd.name = file.name.replace(/\.psd$/i, '');
    const message: PluginMessage = { type: 'import-psd', data: psd };
    parent.postMessage({ pluginMessage: message }, '*');
    logger.info('PSD data sent to Figma main thread');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error occurred';
    logger.error(`PSD parse failed: ${msg}`);
    showError(`Failed to parse PSD: ${msg}`);
    isProcessing = false;
  }
}

dropZone.addEventListener('click', () => {
  if (!isProcessing) fileInput.click();
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
    handleFile(files[0]);
  }
});

fileInput.addEventListener('change', () => {
  if (fileInput.files && fileInput.files.length > 0) {
    handleFile(fileInput.files[0]);
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
    if (!exportFileName.value) {
      exportFileName.value = names[0] ?? 'export';
    }
    exportBtn.disabled = false;
  }
}

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
    case 'done':
      showProgress(100, 'Done!');
      isProcessing = false;
      break;
    case 'error':
      logger.error(`Figma error: ${msg.message}`);
      showError(msg.message);
      isProcessing = false;
      break;
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
      }).then(() => {
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
