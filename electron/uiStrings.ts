import type { UiLang } from '../shared/protocol';
import type { TrayMenuLabels } from '../shared/trayMenu';

/**
 * Main-process user-facing strings (dialogs, overlay tip, high-visibility
 * errors). The renderer chrome has its own dictionary in src/i18n.tsx; deep
 * engine diagnostics stay untranslated on purpose.
 */
const zh = {
  regionTip: '拖动框选要识别的区域 · Esc 取消',
  screenshotBusy: '正在截取屏幕，请稍后重试。',
  screenshotDialogOpen: '文件选择窗口仍打开。请先关闭它，再截取屏幕。',
  screenshotUnavailable: '无法截取鼠标所在的屏幕，请检查屏幕连接和系统录屏权限后重试。',
  kbImportTitle: '导入个人知识库（.md / .txt）',
  exportFolderTitle: '选择会议记录保存位置',
  docFilter: '文档',
  pickResumeTitle: '导入我的简历（md/txt/docx/pdf）',
  pickJdTitle: '导入岗位JD（md/txt/docx/pdf）',
  pickAttachmentTitle: '添加参考文件（文档、文本或代码）',
  docTooLarge: '文件过大，无法导入。请选择小于 20 MB 的文件。',
  docTextTooLong: '提取的文字过长，无法导入。请将文件缩短到 20 万字以内。',
  docUnsupported: '不支持此文件格式。请选择 PDF、Word 或受支持的文本、数据、代码文件。',
  docReadFailed: '无法读取该文件。请检查文件是否完整，然后重试。',
  docFilesSkipped: (count: number) => `${count} 个文件未导入。请检查格式、文件内容和大小（每个文件不超过 20 MB、20 万字符；每次最多选择 20 个）。扫描版 PDF 需要先做文字识别。`,
  noApiKey: '未设置 API Key，请在设置里填入后重试',
  noApiKeyShort: '未设置 API Key',
  noVision: '未配置视觉模型：请在设置里填 Vision Base URL / 模型 / Key（如 MiMo / Gemini）',
  sidecarFail: (msg: string) => `本地 ASR 引擎启动失败：${msg}`,
  /** wraps the ASR worker's own (English, log-friendly) engine diagnostics */
  asrEngineFail: (msg: string) => `语音识别引擎异常：${msg}`,
  setupQuitTitle: '尚未完成配置',
  setupQuitMessage: '配置尚未完成，确定退出吗？可稍后从设置中重新打开向导。',
  setupQuitConfirm: '退出',
  setupQuitCancel: '继续配置',
  tray: {
    brand: 'MeetingCopilot',
    showWindow: '显示窗口',
    hideWindow: '隐藏窗口',
    startCapture: '开始转写',
    stopCapture: '停止转写',
    newSession: '新建会话',
    settings: '设置',
    serviceStatus: '服务状态',
    help: '帮助与教程',
    checkUpdates: '检查更新',
    quit: '退出',
    capturing: '转写中',
  } satisfies TrayMenuLabels,
  trayNoticeTitle: 'MeetingCopilot 仍在运行',
  trayNoticeBody: '窗口已隐藏，可从系统托盘图标重新打开；托盘菜单里也能直接退出。',
};

type MainDict = typeof zh;

const en: MainDict = {
  regionTip: 'Drag to select a region · Esc to cancel',
  screenshotBusy: 'A screen capture is in progress. Please try again shortly.',
  screenshotDialogOpen: 'Close the file picker before taking a screenshot.',
  screenshotUnavailable: 'Could not capture the display under the pointer. Check the display connection and screen recording permission, then retry.',
  kbImportTitle: 'Import personal knowledge base (.md / .txt)',
  exportFolderTitle: 'Choose where meeting records are saved',
  docFilter: 'Documents',
  pickResumeTitle: 'Import my resume (md/txt/docx/pdf)',
  pickJdTitle: 'Import the job description (md/txt/docx/pdf)',
  pickAttachmentTitle: 'Add a reference file (document, text, or code)',
  docTooLarge: 'This file is too large. Choose one under 20 MB.',
  docTextTooLong: 'The extracted text is too long. Shorten the file to 200,000 characters or less.',
  docUnsupported: 'Unsupported file format. Choose a PDF, Word, or supported text, data, or code file.',
  docReadFailed: 'Could not read this file. Check that it is intact and try again.',
  docFilesSkipped: (count: number) => `${count} file(s) were not imported. Check format, content, and size (up to 20 MB and 200,000 characters each; up to 20 per selection). Scanned PDFs need OCR first.`,
  noApiKey: 'API Key not set — add one in Settings and retry',
  noApiKeyShort: 'API Key not set',
  noVision: 'Vision model not configured: set the Vision Base URL / model / key in Settings (e.g. MiMo / Gemini)',
  sidecarFail: (msg: string) => `Local ASR engine failed to start: ${msg}`,
  asrEngineFail: (msg: string) => `Speech recognition engine error: ${msg}`,
  setupQuitTitle: 'Setup is not finished',
  setupQuitMessage:
    'Setup is not finished. Quit anyway? You can reopen the wizard later from Settings.',
  setupQuitConfirm: 'Quit',
  setupQuitCancel: 'Keep setting up',
  tray: {
    brand: 'MeetingCopilot',
    showWindow: 'Show window',
    hideWindow: 'Hide window',
    startCapture: 'Start transcription',
    stopCapture: 'Stop transcription',
    newSession: 'New session',
    settings: 'Settings',
    serviceStatus: 'Service status',
    help: 'Help & guides',
    checkUpdates: 'Check for updates',
    quit: 'Quit',
    capturing: 'transcribing',
  },
  trayNoticeTitle: 'MeetingCopilot is still running',
  trayNoticeBody:
    'The window is hidden — reopen it from the tray icon. The tray menu also has Quit.',
};

const dicts: Record<UiLang, MainDict> = { zh, en };

export function mainStrings(lang: UiLang | undefined, fallback: UiLang): MainDict {
  return dicts[lang ?? fallback];
}
