import { parsePsdFile } from './parser/psd-parser';
import type { SerializedPsd, PluginMessage } from './types/psd-types';
import { logger } from './logger';

declare const __VERSION__: string;

const REPO_OWNER = '4NaNBo1';
const REPO_NAME = 'psd-to-figma';
const CURRENT_VERSION = __VERSION__;

const dropZone = document.getElementById('dropZone')!;
const fileInput = document.getElementById('fileInput') as HTMLInputElement;
const progressArea = document.getElementById('progressArea')!;
const progressFill = document.getElementById('progressFill')!;
const progressText = document.getElementById('progressText')!;
const errorArea = document.getElementById('errorArea')!;
const copyLogBtn = document.getElementById('copyLogBtn') as HTMLButtonElement;
const footer = document.getElementById('footer')!;

footer.textContent = `by ${REPO_OWNER} · v${CURRENT_VERSION}`;

let isProcessing = false;

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
    link.textContent = `v${latest} 可用`;
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
