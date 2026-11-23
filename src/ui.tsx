import { Fragment, h, render } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  Bold,
  Button,
  Checkbox,
  FileUploadDropzone,
  IconCheck24,
  IconClipboardSmall24,
  IconImport24,
  IconInfo16,
  IconWarning16,
  Muted,
  SegmentedControl,
  Tabs,
  Text,
  Textbox,
} from '@create-figma-plugin/ui';
import type { SegmentedControlOption, TabsOption } from '@create-figma-plugin/ui';
import { parsePsdFile } from './parser/psd-parser';
import type { ExportSelectionItem, PluginMessage } from './types/psd-types';
import { buildAndDownloadPsd } from './exporter/psd-builder';
import { detectDefaultLocale, getMessages, isLocale, type Locale } from './i18n';
import { logger } from './logger';
import './ui.css';

declare const __VERSION__: string;

const REPO_OWNER = '4NaNBo1';
const REPO_NAME = 'psd-to-figma';
const CURRENT_VERSION = __VERSION__;

type TabKey = 'import' | 'export';

const SCALE_OPTIONS: Array<SegmentedControlOption> = [
  { value: '1', children: '1×' },
  { value: '2', children: '2×' },
  { value: '3', children: '3×' },
  { value: '4', children: '4×' },
  { value: '5', children: '5×' },
];

interface ProgressState {
  visible: boolean;
  percent: number;
  message: string;
}

interface UpdateInfo {
  version: string;
  url: string;
}

interface ExportFile {
  nodeId: string;
  fileName: string;
}

interface ExportQueue {
  files: ExportFile[];
  index: number;
  errors: string[];
  scale: number;
  ignoreHiddenLayers: boolean;
  locale: Locale;
}

function normalizePsdBasename(value: string): string {
  return value.trim().replace(/\.psd$/i, '').trim();
}

function getDefaultExportFileName(name: string): string {
  return normalizePsdBasename(name).replace(/[<>:"/\\|?*]/g, '_').replace(/[ .]+$/, '') || 'export';
}

function getBatchExportFiles(selection: ExportSelectionItem[]): ExportFile[] {
  const files = selection.map(({ id, name }) => ({
    nodeId: id,
    fileName: getDefaultExportFileName(name),
  }));
  const nameKey = (name: string) => name.normalize('NFC').toLowerCase();
  const reserved = new Set(files.map(({ fileName }) => nameKey(fileName)));
  const used = new Set<string>();
  return files.map(({ nodeId, fileName }) => {
    let uniqueName = fileName;
    if (used.has(nameKey(fileName))) {
      let suffix = 2;
      do {
        uniqueName = `${fileName} (${suffix++})`;
      } while (reserved.has(nameKey(uniqueName)) || used.has(nameKey(uniqueName)));
    }
    used.add(nameKey(uniqueName));
    return { nodeId, fileName: uniqueName };
  });
}

function compareVersions(versionA: string, versionB: string): number {
  const partsA = versionA.split('.').map(Number);
  const partsB = versionB.split('.').map(Number);
  for (let index = 0; index < Math.max(partsA.length, partsB.length); index++) {
    const numA = partsA[index] || 0;
    const numB = partsB[index] || 0;
    if (numA !== numB) return numA - numB;
  }
  return 0;
}

function fallbackCopyText(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '-9999px';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  document.body.removeChild(textarea);
  return copied;
}

function initThemeFallback() {
  const root = document.documentElement;
  if (root.classList.contains('figma-light') || root.classList.contains('figma-dark')) {
    return;
  }
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  const applyFallback = (isDark: boolean) => {
    document.body.classList.toggle('figma-dark', isDark);
    document.body.classList.toggle('figma-light', !isDark);
  };
  applyFallback(media ? media.matches : true);
  media?.addEventListener?.('change', (event) => {
    if (!root.classList.contains('figma-light') && !root.classList.contains('figma-dark')) {
      applyFallback(event.matches);
    }
  });
}

function ProgressBar({ state }: { state: ProgressState }) {
  if (!state.visible) return null;
  const clamped = Math.max(0, Math.min(100, state.percent));
  return (
    <div class="progress-block">
      <div class="progress-track">
        <div class="progress-fill" style={{ width: `${clamped}%` }} />
      </div>
      <div class="progress-message truncate" title={state.message}>
        {state.message}
      </div>
    </div>
  );
}

function ErrorNotice({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div class="error-banner" role="alert">
      <div class="error-banner-icon">
        <IconWarning16 />
      </div>
      <div class="error-banner-text">{message}</div>
    </div>
  );
}

function App() {
  const [locale, setLocale] = useState<Locale>(() => detectDefaultLocale());
  const localeRef = useRef<Locale>(locale);
  const messages = getMessages(locale);

  const [activeTab, setActiveTab] = useState<TabKey>('export');

  const [importProgress, setImportProgress] = useState<ProgressState>({
    visible: false,
    percent: 0,
    message: '',
  });
  const [importError, setImportError] = useState<string>('');

  const [selection, setSelection] = useState<ExportSelectionItem[]>([]);
  const isMultiSelection = selection.length > 1;
  const defaultExportFileName = getDefaultExportFileName(selection[0]?.name ?? '');
  const batchFiles = useMemo(() => getBatchExportFiles(selection), [selection]);
  const [exportFileName, setExportFileName] = useState<string>('');
  const [exportScale, setExportScale] = useState<string>('3');
  const [ignoreHiddenLayers, setIgnoreHiddenLayers] = useState<boolean>(true);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [exportProgress, setExportProgress] = useState<ProgressState>({
    visible: false,
    percent: 0,
    message: '',
  });
  const [exportError, setExportError] = useState<string>('');

  const [copiedLog, setCopiedLog] = useState<boolean>(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);

  const isAutoFileNameRef = useRef<boolean>(true);
  const exportQueueRef = useRef<ExportQueue | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    localeRef.current = locale;
    document.documentElement.lang = getMessages(locale).htmlLang;
  }, [locale]);

  const handleToggleLocale = useCallback(() => {
    setLocale((prev) => {
      const next: Locale = prev === 'zh' ? 'en' : 'zh';
      const message: PluginMessage = { type: 'set-locale', locale: next };
      parent.postMessage({ pluginMessage: message }, '*');
      return next;
    });
  }, []);

  const batchRef = useRef({
    pendingFiles: [] as File[],
    isProcessing: false,
    batchTotal: 0,
    batchProcessed: 0,
    activeBatchOpen: false,
    batchSuccessCount: 0,
    batchErrorCount: 0,
    currentFileName: '',
  });

  const showImportProgress = useCallback((percent: number, message: string) => {
    setImportProgress({ visible: true, percent, message });
  }, []);

  const resetImportUI = useCallback(() => {
    setImportProgress({ visible: false, percent: 0, message: '' });
    setImportError('');
  }, []);

  const showExportProgress = useCallback((percent: number, message: string) => {
    setExportProgress({ visible: true, percent, message });
  }, []);

  const resetExportUI = useCallback(() => {
    setExportProgress({ visible: false, percent: 0, message: '' });
    setExportError('');
  }, []);

  const startNext = useCallback(async () => {
    const batch = batchRef.current;
    if (batch.isProcessing) return;
    const activeLocale = localeRef.current;
    const t = getMessages(activeLocale);
    const file = batch.pendingFiles.shift();
    if (!file) {
      if (batch.activeBatchOpen) {
        const endMsg: PluginMessage = { type: 'import-psd-batch-end' };
        parent.postMessage({ pluginMessage: endMsg }, '*');
        batch.activeBatchOpen = false;

        if (batch.batchTotal > 1) {
          const summary = t.batchSummary(batch.batchSuccessCount, batch.batchErrorCount);
          setImportProgress((prev) => ({ ...prev, visible: true, message: summary }));
          if (batch.batchErrorCount > 0) {
            setImportError(t.batchErrorNotice(batch.batchErrorCount));
          }
        }
        batch.batchTotal = 0;
        batch.batchProcessed = 0;
      }
      return;
    }

    batch.isProcessing = true;
    batch.currentFileName = file.name;
    const idx = batch.batchProcessed;
    const prefix = batch.batchTotal > 1 ? `[${idx + 1}/${batch.batchTotal}] ` : '';

    logger.info(`${prefix}Start import: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
    showImportProgress(0, `${prefix}${file.name} — ${t.readingFile}`);

    try {
      const buffer = await file.arrayBuffer();
      logger.info(`${prefix}File read into memory`);
      showImportProgress(5, `${prefix}${file.name} — ${t.parsingFile}`);

      const psd = await parsePsdFile(
        buffer,
        (progress) => {
          showImportProgress(progress.percent, `${prefix}${file.name} — ${progress.message}`);
        },
        activeLocale
      );

      logger.info(
        `${prefix}PSD parsed: ${psd.width}x${psd.height}, ${psd.layers.length} top-level layers, ${psd.images.length} images`
      );
      showImportProgress(90, `${prefix}${file.name} — ${t.sendingToMain}`);

      psd.name = file.name.replace(/\.psd$/i, '');
      const message: PluginMessage = {
        type: 'import-psd',
        data: psd,
        batchIndex: idx,
        batchTotal: batch.batchTotal,
        locale: activeLocale,
      };
      parent.postMessage({ pluginMessage: message }, '*');
      logger.info(`${prefix}PSD data sent to plugin main thread`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : t.unknownImportError;
      logger.error(`${prefix}PSD parse failed: ${errMsg}`);
      setImportError(t.parseFailed(prefix, file.name, errMsg));
      batch.batchErrorCount++;
      batch.batchProcessed++;
      batch.isProcessing = false;
      void startNext();
    }
  }, [showImportProgress]);

  const enqueueFiles = useCallback(
    (rawFiles: File[]) => {
      const batch = batchRef.current;
      const psdFiles = rawFiles.filter((file) => file.name.toLowerCase().endsWith('.psd'));
      const ignored = rawFiles.length - psdFiles.length;

      if (psdFiles.length === 0) {
        logger.warn(`Rejected ${rawFiles.length} file(s): no .psd`);
        if (!batch.activeBatchOpen) {
          setImportError(getMessages(localeRef.current).selectPsdFileError);
        }
        return;
      }
      if (ignored > 0) {
        logger.warn(`Ignored ${ignored} non-.psd file(s)`);
      }

      const isNewBatch = !batch.activeBatchOpen;
      if (isNewBatch) {
        logger.clear();
        resetImportUI();
        batch.batchTotal = 0;
        batch.batchProcessed = 0;
        batch.batchSuccessCount = 0;
        batch.batchErrorCount = 0;
        batch.activeBatchOpen = true;
      }

      for (const file of psdFiles) {
        batch.pendingFiles.push(file);
      }
      batch.batchTotal += psdFiles.length;

      logger.info(
        isNewBatch
          ? `Queued ${psdFiles.length} file(s)${ignored > 0 ? `, ignored ${ignored}` : ''}`
          : `Appended ${psdFiles.length} file(s) to current batch (total ${batch.batchTotal})`
      );

      if (isNewBatch) {
        const startMsg: PluginMessage = {
          type: 'import-psd-batch-start',
          total: batch.batchTotal,
        };
        parent.postMessage({ pluginMessage: startMsg }, '*');
      }

      void startNext();
    },
    [resetImportUI, startNext]
  );

  const handleFileInputChange = useCallback((event: Event) => {
    const input = event.currentTarget as HTMLInputElement | null;
    if (!input) return;
    setTimeout(() => {
      input.value = '';
    }, 0);
  }, []);

  const handleFileNameInput = useCallback((value: string) => {
    setExportFileName(value);
    isAutoFileNameRef.current = value.trim() === '';
  }, []);

  const reportExportProgress = useCallback((percent: number, message: string) => {
    const queue = exportQueueRef.current;
    if (!queue) return;
    const total = queue.files.length;
    const progress = (queue.index * 100 + percent) / total;
    const prefix = total > 1 ? `[${queue.index + 1}/${total}] ${queue.files[queue.index].fileName}.psd — ` : '';
    showExportProgress(progress, prefix + message);
  }, [showExportProgress]);

  const requestExportFile = useCallback((queue: ExportQueue) => {
    const { nodeId, fileName } = queue.files[queue.index];
    reportExportProgress(0, getMessages(queue.locale).exportStarting);
    logger.info(`Export started: ${fileName}.psd`);
    const message: PluginMessage = {
      type: 'export-psd',
      nodeId,
      scale: queue.scale,
      ignoreHiddenLayers: queue.ignoreHiddenLayers,
      locale: queue.locale,
    };
    parent.postMessage({ pluginMessage: message }, '*');
  }, [reportExportProgress]);

  const finishExportFile = useCallback((errorMessage?: string) => {
    const queue = exportQueueRef.current;
    if (!queue) return;
    const { fileName } = queue.files[queue.index];
    if (errorMessage !== undefined) {
      logger.error(`Export failed for ${fileName}.psd: ${errorMessage}`);
      queue.errors.push(queue.files.length === 1 ? errorMessage : `${fileName}.psd — ${errorMessage}`);
    } else {
      logger.info(`Export complete: ${fileName}.psd`);
    }
    queue.index++;
    if (queue.index < queue.files.length) {
      requestExportFile(queue);
      return;
    }
    exportQueueRef.current = null;
    setIsExporting(false);
    if (queue.files.length > 1) {
      const completed = queue.files.length - queue.errors.length;
      showExportProgress(100, getMessages(queue.locale).exportBatchSummary(completed, queue.files.length));
    }
    if (queue.errors.length > 0) setExportError(queue.errors.join('\n'));
  }, [requestExportFile, showExportProgress]);

  const handleExportClick = useCallback(() => {
    if (exportQueueRef.current || selection.length === 0) return;
    const files = isMultiSelection ? batchFiles : [{
      nodeId: selection[0].id,
      fileName: normalizePsdBasename(exportFileName) || defaultExportFileName,
    }];
    const queue: ExportQueue = {
      files,
      index: 0,
      errors: [],
      scale: Number(exportScale),
      ignoreHiddenLayers,
      locale: localeRef.current,
    };
    exportQueueRef.current = queue;
    setIsExporting(true);
    resetExportUI();
    requestExportFile(queue);
  }, [
    batchFiles,
    defaultExportFileName,
    exportFileName,
    exportScale,
    ignoreHiddenLayers,
    isMultiSelection,
    requestExportFile,
    resetExportUI,
    selection,
  ]);

  const handleCopyLog = useCallback(() => {
    const text = logger.toClipboardText();
    const markCopied = () => {
      setCopiedLog(true);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => {
        setCopiedLog(false);
        copyTimerRef.current = null;
      }, 1500);
    };

    if (navigator.clipboard?.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(markCopied)
        .catch(() => {
          if (fallbackCopyText(text)) markCopied();
        });
    } else if (fallbackCopyText(text)) {
      markCopied();
    }
  }, []);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const raw = event.data;
      const msg = (raw?.pluginMessage ?? raw) as PluginMessage;
      if (!msg || !msg.type) return;
      const batch = batchRef.current;

      switch (msg.type) {
        case 'locale-loaded':
          if (isLocale(msg.locale)) {
            setLocale(msg.locale);
          }
          break;
        case 'progress-update':
          showImportProgress(msg.percent, msg.message);
          break;
        case 'done': {
          const t = getMessages(localeRef.current);
          const prefix =
            batch.batchTotal > 1 ? `[${batch.batchProcessed + 1}/${batch.batchTotal}] ` : '';
          showImportProgress(100, `${prefix}${batch.currentFileName || ''} — ${t.fileDone}`);
          batch.batchSuccessCount++;
          batch.batchProcessed++;
          batch.isProcessing = false;
          void startNext();
          break;
        }
        case 'error': {
          const prefix =
            batch.batchTotal > 1 ? `[${batch.batchProcessed + 1}/${batch.batchTotal}] ` : '';
          logger.error(`${prefix}Plugin error: ${msg.message}`);
          setImportError(msg.message);
          batch.batchErrorCount++;
          batch.batchProcessed++;
          batch.isProcessing = false;
          void startNext();
          break;
        }
        case 'log':
          logger[msg.level](msg.message);
          break;
        case 'selection-changed': {
          setSelection(msg.items);
          if (msg.items.length === 1 && isAutoFileNameRef.current) {
            setExportFileName(getDefaultExportFileName(msg.items[0].name));
          }
          break;
        }
        case 'export-progress':
          reportExportProgress(msg.percent, msg.message);
          break;
        case 'export-psd-data': {
          const queue = exportQueueRef.current;
          if (!queue) break;
          const { fileName } = queue.files[queue.index];
          const t = getMessages(queue.locale);
          reportExportProgress(65, t.buildingPsd);

          void buildAndDownloadPsd(
            msg.nodes,
            msg.width,
            msg.height,
            fileName,
            reportExportProgress,
            msg.engineData,
            msg.patterns,
            msg.compositeBase64,
            queue.locale
          )
            .then(() => finishExportFile())
            .catch((err) => {
              finishExportFile(err instanceof Error ? err.message : t.psdBuildFailedFallback);
            });
          break;
        }
        case 'export-psd-error':
          finishExportFile(msg.message);
          break;
      }
    };

    window.addEventListener('message', handleMessage);
    const message: PluginMessage = { type: 'request-selection' };
    parent.postMessage({ pluginMessage: message }, '*');
    return () => window.removeEventListener('message', handleMessage);
  }, [finishExportFile, reportExportProgress, showImportProgress, startNext]);

  useEffect(() => {
    let cancelled = false;
    async function checkForUpdate() {
      try {
        const res = await fetch(
          `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`
        );
        if (!res.ok) return;
        const data = await res.json();
        const tag: string = data.tag_name ?? '';
        const latest = tag.replace(/^v/, '');
        if (!latest || compareVersions(latest, CURRENT_VERSION) <= 0 || cancelled) return;
        setUpdateInfo({
          version: latest,
          url: `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/tag/${tag}`,
        });
      } catch {
        // ignore network errors
      }
    }
    void checkForUpdate();
    return () => {
      cancelled = true;
    };
  }, []);

  const singleSelectionName = selection[0]?.name || messages.unnamedNode;
  const activeExport = exportQueueRef.current;
  const activeSingleFile = activeExport?.files.length === 1 ? activeExport.files[0] : null;

  const importPanel = (
    <div class="panel">
      <FileUploadDropzone
        multiple
        onChange={handleFileInputChange}
        onSelectedFiles={enqueueFiles}
      >
        <div class="dropzone-inner">
          <div class="dropzone-icon">
            <IconImport24 />
          </div>
          <Text align="center">
            <Bold>{messages.dropzoneTitle}</Bold>
          </Text>
          <Text align="center">
            <Muted>{messages.dropzoneHint}</Muted>
          </Text>
        </div>
      </FileUploadDropzone>
      <ProgressBar state={importProgress} />
      <ErrorNotice message={importError} />
    </div>
  );

  const exportPanel = (
    <div class="panel">
      <div
        class={isMultiSelection ? 'selection-card selection-card-multi' : 'selection-card'}
      >
        <div class="selection-icon" aria-hidden="true">
          {selection.length > 0 ? (
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.25"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M8 2.5 13.5 5.5 8 8.5 2.5 5.5 8 2.5Z M2.5 8 8 11l5.5-3 M2.5 10.5 8 13.5l5.5-3" />
            </svg>
          ) : <IconInfo16 />}
        </div>
        {selection.length === 0 ? (
          <Muted>{messages.selectionEmpty}</Muted>
        ) : isMultiSelection ? (
          <div class="selection-meta">
            <Bold>{messages.selectionCount(selection.length)}</Bold>
            <ul
              aria-label={messages.selectionListLabel}
              class="selection-list"
              tabIndex={batchFiles.length > 3 ? 0 : undefined}
            >
              {batchFiles.map(({ nodeId, fileName }) => (
                <li key={nodeId} class="truncate" title={`${fileName}.psd`}>{fileName}.psd</li>
              ))}
            </ul>
          </div>
        ) : (
          <div class="selection-single">
            <span class="selection-label">{messages.selectionLabel}</span>
            <span class="truncate" title={singleSelectionName}>{singleSelectionName}</span>
          </div>
        )}
      </div>

      {(activeSingleFile || (!isExporting && selection.length === 1)) && (
        <div class="field-group">
          <label class="field-label" for="export-file-name">{messages.exportFileNameLabel}</label>
          <div class="filename-input-row">
            <div class="filename-input-grow">
              <Textbox
                disabled={isExporting}
                id="export-file-name"
                onValueInput={handleFileNameInput}
                placeholder={defaultExportFileName}
                validateOnBlur={(value: string) => (
                  /\.psd\s*$/i.test(value) ? normalizePsdBasename(value) : true
                )}
                value={activeSingleFile?.fileName ?? exportFileName}
              />
            </div>
            <span class="filename-ext">.psd</span>
          </div>
        </div>
      )}
      {isMultiSelection && <span class="field-label">{messages.multiSelectionFileNameHint}</span>}

      <div class="field-group">
        <span class="field-label">{messages.exportScaleLabel}</span>
        <div class="scale-control">
          <SegmentedControl
            onValueChange={setExportScale}
            options={SCALE_OPTIONS}
            value={exportScale}
          />
        </div>
      </div>

      <Checkbox onValueChange={setIgnoreHiddenLayers} value={ignoreHiddenLayers}>
        <Text>{messages.ignoreHiddenLayers}</Text>
      </Checkbox>

      <Button
        disabled={selection.length === 0}
        fullWidth
        loading={isExporting}
        onClick={handleExportClick}
      >
        {isMultiSelection ? messages.exportButtonBatch(selection.length) : messages.exportButtonSingle}
      </Button>

      <ProgressBar state={exportProgress} />
      <ErrorNotice message={exportError} />
    </div>
  );

  const tabOptions: Array<TabsOption> = [
    { value: messages.tabExport, children: exportPanel },
    { value: messages.tabImport, children: importPanel },
  ];
  const activeTabLabel = activeTab === 'import' ? messages.tabImport : messages.tabExport;

  return (
    <div class="app-shell">
      <div class="app-main">
        <div class="tabs-shell">
          <Tabs
            onValueChange={(value: string) => setActiveTab(value === messages.tabImport ? 'import' : 'export')}
            options={tabOptions}
            value={activeTabLabel}
          />
          <button
            aria-label={messages.switchLanguageTitle}
            class="lang-toggle"
            onClick={handleToggleLocale}
            title={messages.switchLanguageTitle}
            type="button"
          >
            <span class={locale === 'zh' ? 'lang-option-active' : 'lang-option-inactive'}>中</span>
            <span class="lang-divider">/</span>
            <span class={locale === 'en' ? 'lang-option-active' : 'lang-option-inactive'}>EN</span>
          </button>
        </div>
      </div>

      <footer class="app-footer">
        <div class="footer-meta truncate">
          <a
            class="footer-link"
            href={`https://github.com/${REPO_OWNER}`}
            onClick={(event) => {
              event.preventDefault();
              window.open(`https://github.com/${REPO_OWNER}`, '_blank');
            }}
          >
            {REPO_OWNER}
          </a>
          <span>·</span>
          <a
            class="footer-link"
            href={`https://github.com/${REPO_OWNER}/${REPO_NAME}`}
            onClick={(event) => {
              event.preventDefault();
              window.open(`https://github.com/${REPO_OWNER}/${REPO_NAME}`, '_blank');
            }}
          >
            v{CURRENT_VERSION}
          </a>
          {updateInfo && (
            <Fragment>
              <span>·</span>
              <a
                class="footer-update-link"
                href={updateInfo.url}
                onClick={(event) => {
                  event.preventDefault();
                  window.open(updateInfo.url, '_blank');
                }}
                title={messages.updateAvailableTitle(updateInfo.version)}
              >
                v{updateInfo.version} ↑
              </a>
            </Fragment>
          )}
        </div>

        <button
          class={`footer-log-btn ${copiedLog ? 'footer-log-btn-copied' : ''}`}
          onClick={handleCopyLog}
          title={copiedLog ? messages.copiedLogLabel : messages.copyLogTitle}
          type="button"
        >
          <span class="footer-log-btn-icon" aria-hidden="true">
            {copiedLog ? <IconCheck24 /> : <IconClipboardSmall24 />}
          </span>
          <span>{copiedLog ? messages.copiedLogLabel : messages.copyLogLabel}</span>
        </button>
      </footer>
    </div>
  );
}

initThemeFallback();
render(<App />, document.getElementById('root')!);
