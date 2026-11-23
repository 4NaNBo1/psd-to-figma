export type Locale = 'zh' | 'en';

export interface Messages {
  htmlLang: string;
  tabImport: string;
  tabExport: string;
  switchLanguageTitle: string;
  dropzoneTitle: string;
  dropzoneHint: string;
  selectPsdFileError: string;
  selectionEmpty: string;
  selectionCount: (count: number) => string;
  selectionLabel: string;
  selectionListLabel: string;
  unnamedNode: string;
  exportFileNameLabel: string;
  multiSelectionFileNameHint: string;
  exportScaleLabel: string;
  ignoreHiddenLayers: string;
  exportButtonSingle: string;
  exportButtonBatch: (count: number) => string;
  exportBatchSummary: (succeeded: number, total: number) => string;
  exportNodeUnavailable: string;
  copyLogLabel: string;
  copyLogTitle: string;
  copiedLogLabel: string;
  updateAvailableTitle: (version: string) => string;

  // Import flow
  readingFile: string;
  parsingFile: string;
  sendingToMain: string;
  fileDone: string;
  parseFailed: (prefix: string, fileName: string, errMsg: string) => string;
  batchSummary: (successCount: number, errorCount: number) => string;
  batchErrorNotice: (errorCount: number) => string;
  parsingPsdStructure: string;
  psdParsedProcessingLayers: string;
  processingLayer: (current: number, total: number, name: string) => string;
  encodingImage: (name: string) => string;
  encodingCanvas: (name: string) => string;
  layersProcessedTransferring: string;
  buildingIrTree: string;
  creatingLayers: string;
  creatingLayersProgress: (current: number, total: number) => string;
  importCompleteNotify: string;
  importBatchCompleteNotify: (total: number) => string;
  importFailedNotify: string;
  unknownImportError: string;

  // Export flow
  exportStarting: string;
  exportingNode: (current: number, total: number, name: string) => string;
  buildingPsd: string;
  buildingPsdStructure: string;
  buildingLayer: (current: number, total: number, name: string) => string;
  generatingPsdFile: string;
  preparingDownload: string;
  exportComplete: string;
  exportFailedFallback: string;
  psdBuildFailedFallback: string;
  noSelectionError: string;
  allHiddenSelectionError: string;
  invalidScaleError: string;
  importedPsdScaleError: string;
  rawPsdDataScaleError: string;
  emptyExpandedSelectionError: string;
  exportSizeTooLargeError: (width: number, height: number) => string;
  groupDepthExceededError: (layerName: string) => string;
}

const ZH_MESSAGES: Messages = {
  htmlLang: 'zh-CN',
  tabImport: '导入 PSD',
  tabExport: '导出 PSD',
  switchLanguageTitle: '切换为英文',
  dropzoneTitle: '拖入或点击选择 .psd',
  dropzoneHint: 'RGB 模式 · 支持多文件队列',
  selectPsdFileError: '请选择 .psd 文件',
  selectionEmpty: '在画布中选中节点以导出',
  selectionCount: (count) => `已选中 ${count} 个节点`,
  selectionLabel: '已选中',
  selectionListLabel: '导出文件',
  unnamedNode: '未命名节点',
  exportFileNameLabel: '导出文件名',
  multiSelectionFileNameHint: '多选时沿用原文件名。',
  exportScaleLabel: '导出倍率',
  ignoreHiddenLayers: '忽略隐藏图层',
  exportButtonSingle: '导出 PSD',
  exportButtonBatch: (count) => `导出 ${count} 个 PSD`,
  exportBatchSummary: (succeeded, total) => succeeded === total
    ? `已生成 ${total} 个 PSD`
    : `已生成 ${succeeded} / ${total} 个 PSD`,
  exportNodeUnavailable: '此节点已不存在。',
  copyLogLabel: '复制日志',
  copyLogTitle: '复制调试日志',
  copiedLogLabel: '已复制',
  updateAvailableTitle: (version) => `发现新版本 v${version}`,

  readingFile: '读取中...',
  parsingFile: '解析中...',
  sendingToMain: '发送到主线程...',
  fileDone: '完成',
  parseFailed: (prefix, fileName, errMsg) => `${prefix}${fileName} 解析失败：${errMsg}`,
  batchSummary: (successCount, errorCount) =>
    `共 ${successCount} 个成功${errorCount > 0 ? ` / ${errorCount} 失败` : ''}`,
  batchErrorNotice: (errorCount) => `${errorCount} 个文件失败，详见日志`,
  parsingPsdStructure: '解析 PSD 结构...',
  psdParsedProcessingLayers: '已解析结构，正在处理图层...',
  processingLayer: (current, total, name) => `处理图层 ${current}/${total}: ${name}`,
  encodingImage: (name) => `编码图像: ${name}`,
  encodingCanvas: (name) => `编码画布: ${name}`,
  layersProcessedTransferring: '图层处理完成，准备传输...',
  buildingIrTree: '构建图层树...',
  creatingLayers: '创建图层中...',
  creatingLayersProgress: (current, total) => `创建图层中... (${current}/${total})`,
  importCompleteNotify: 'PSD 导入完成',
  importBatchCompleteNotify: (total) => `PSD 导入完成：${total} 个文件`,
  importFailedNotify: 'PSD 导入失败',
  unknownImportError: '导入过程中发生未知错误',

  exportStarting: '开始导出...',
  exportingNode: (current, total, name) => `导出节点 ${current}/${total}: ${name}`,
  buildingPsd: '构建 PSD 文件...',
  buildingPsdStructure: '构建 PSD 图层结构...',
  buildingLayer: (current, total, name) => `构建图层 ${current}/${total}: ${name}`,
  generatingPsdFile: '生成 PSD 文件...',
  preparingDownload: '准备下载...',
  exportComplete: '导出完成！',
  exportFailedFallback: '导出失败',
  psdBuildFailedFallback: 'PSD 生成失败',
  noSelectionError: '没有选中任何节点',
  allHiddenSelectionError: '选中的图层均不可见。请显示图层或取消勾选「忽略隐藏图层」。',
  invalidScaleError: '请选择 1× 至 5× 的 PSD 导出倍率',
  importedPsdScaleError: '选区含从 PSD 导入的图层。请用 1× 导出以保留原始 PSD 数据。',
  rawPsdDataScaleError: '选区含原始 PSD 数据。请用 1× 导出以保留原始 PSD 数据。',
  emptyExpandedSelectionError: '选中的节点展开后为空',
  exportSizeTooLargeError: (width, height) => `导出尺寸 ${width} × ${height} px 过大，请降低 PSD 导出倍率。`,
  groupDepthExceededError: (layerName) =>
    `「${layerName}」的独立效果或蒙版需要超过 Photoshop 支持的组嵌套深度。请减少嵌套后再导出。`,
};

const EN_MESSAGES: Messages = {
  htmlLang: 'en',
  tabImport: 'Import PSD',
  tabExport: 'Export PSD',
  switchLanguageTitle: 'Switch to Chinese',
  dropzoneTitle: 'Drop or click to select .psd',
  dropzoneHint: 'RGB mode · Batch queue supported',
  selectPsdFileError: 'Please select a .psd file',
  selectionEmpty: 'Select layer(s) on canvas to export',
  selectionCount: (count) => `${count} layers selected`,
  selectionLabel: 'Selected',
  selectionListLabel: 'Export files',
  unnamedNode: 'Unnamed layer',
  exportFileNameLabel: 'File name',
  multiSelectionFileNameHint: 'Each PSD uses its layer name.',
  exportScaleLabel: 'Scale',
  ignoreHiddenLayers: 'Ignore hidden layers',
  exportButtonSingle: 'Export PSD',
  exportButtonBatch: (count) => `Export ${count} PSDs`,
  exportBatchSummary: (succeeded, total) => succeeded === total
    ? `${total} PSDs created`
    : `${succeeded} of ${total} PSDs created`,
  exportNodeUnavailable: 'This layer no longer exists.',
  copyLogLabel: 'Copy log',
  copyLogTitle: 'Copy debug log',
  copiedLogLabel: 'Copied',
  updateAvailableTitle: (version) => `New version v${version} available`,

  readingFile: 'Reading...',
  parsingFile: 'Parsing...',
  sendingToMain: 'Sending to Figma...',
  fileDone: 'Done',
  parseFailed: (prefix, fileName, errMsg) => `${prefix}${fileName} failed to parse: ${errMsg}`,
  batchSummary: (successCount, errorCount) =>
    `${successCount} succeeded${errorCount > 0 ? `, ${errorCount} failed` : ''}`,
  batchErrorNotice: (errorCount) => `${errorCount} file(s) failed — see log`,
  parsingPsdStructure: 'Parsing PSD structure...',
  psdParsedProcessingLayers: 'Structure parsed. Processing layers...',
  processingLayer: (current, total, name) => `Processing layer ${current}/${total}: ${name}`,
  encodingImage: (name) => `Encoding image: ${name}`,
  encodingCanvas: (name) => `Encoding canvas: ${name}`,
  layersProcessedTransferring: 'Layers processed. Preparing transfer...',
  buildingIrTree: 'Building layer tree...',
  creatingLayers: 'Creating layers...',
  creatingLayersProgress: (current, total) => `Creating layers... (${current}/${total})`,
  importCompleteNotify: 'PSD import complete',
  importBatchCompleteNotify: (total) => `PSD import complete: ${total} file(s)`,
  importFailedNotify: 'PSD import failed',
  unknownImportError: 'Unknown error during import',

  exportStarting: 'Starting export...',
  exportingNode: (current, total, name) => `Exporting layer ${current}/${total}: ${name}`,
  buildingPsd: 'Building PSD...',
  buildingPsdStructure: 'Building PSD layer structure...',
  buildingLayer: (current, total, name) => `Building layer ${current}/${total}: ${name}`,
  generatingPsdFile: 'Generating PSD file...',
  preparingDownload: 'Preparing download...',
  exportComplete: 'Export complete!',
  exportFailedFallback: 'Export failed',
  psdBuildFailedFallback: 'Failed to generate PSD',
  noSelectionError: 'No layers selected',
  allHiddenSelectionError: 'All selected layers are hidden. Make them visible or uncheck "Ignore hidden layers".',
  invalidScaleError: 'Please choose an export scale between 1× and 5×',
  importedPsdScaleError: 'Selection contains layers imported from PSD. Export at 1× to preserve original PSD data.',
  rawPsdDataScaleError: 'Selection contains original PSD data. Export at 1× to preserve original PSD data.',
  emptyExpandedSelectionError: 'Selection is empty after expanding wrappers',
  exportSizeTooLargeError: (width, height) => `Export size ${width} × ${height} px is too large. Please lower the export scale.`,
  groupDepthExceededError: (layerName) =>
    `"${layerName}" requires deeper group nesting than Photoshop supports. Reduce nesting and try again.`,
};

export const MESSAGES: Record<Locale, Messages> = {
  zh: ZH_MESSAGES,
  en: EN_MESSAGES,
};

export function isLocale(value: unknown): value is Locale {
  return value === 'zh' || value === 'en';
}

export function detectDefaultLocale(): Locale {
  if (typeof navigator !== 'undefined' && typeof navigator.language === 'string') {
    return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  }
  return 'zh';
}

export function getMessages(locale: Locale = 'zh'): Messages {
  return MESSAGES[locale] ?? ZH_MESSAGES;
}
