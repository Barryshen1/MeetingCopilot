import { useEffect, useRef, useState } from 'react';
import {
  CLAUDE_CODE_EFFORTS,
  CLAUDE_CODE_MODELS,
  claudeCodeConfigKey,
  type ClaudeCodeEffort,
  type ClaudeCodeSettings,
  type ClaudeCodeStatus,
  type ClaudeCodeTestResult,
} from '../../shared/claudeCode';
import type { PublicSettings } from '../../shared/protocol';
import { useT } from '../i18n';
import { InWindowSelect } from './InWindowSelect';

/** Match the effective configuration, including the CLI's own defaults. */
const configKey = claudeCodeConfigKey;

export function ClaudeCodeProviderSettings({ config, saved, onChange, onSettingsRefreshed, onTestingChange }: {
  config: ClaudeCodeSettings;
  saved: PublicSettings;
  onChange: (config: ClaudeCodeSettings) => void;
  onSettingsRefreshed: (settings: PublicSettings) => void;
  onTestingChange: (testing: boolean) => void;
}) {
  const t = useT();
  const [status, setStatus] = useState<ClaudeCodeStatus>();
  const [checking, setChecking] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ key: string; value: ClaudeCodeTestResult }>();
  const [statusError, setStatusError] = useState('');
  const [customModel, setCustomModel] = useState(false);
  const requestId = useRef(0);
  const mounted = useRef(true);
  const key = configKey(config);
  const fresh = result?.key === key ? result.value : undefined;
  const verification = saved.llm.backend === 'claude-code-cli' && configKey(saved.llm.claudeCode) === key
    ? saved.llm.verification : undefined;
  const selectedModel = CLAUDE_CODE_MODELS.find((m) => m.id === config.model?.trim());

  const refresh = async () => {
    const id = ++requestId.current;
    setChecking(true);
    setStatus(undefined);
    setStatusError('');
    try {
      const next = await window.mc.claudeCodeStatus(config);
      if (mounted.current && id === requestId.current) setStatus(next);
    } catch (error) {
      if (mounted.current && id === requestId.current) setStatusError(String(error));
    } finally {
      if (mounted.current && id === requestId.current) setChecking(false);
    }
  };

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; requestId.current++; onTestingChange(false); };
  }, [onTestingChange]);

  useEffect(() => {
    // Discovery reads `claude --version` and `claude auth status`; it never generates text.
    setStatus(undefined);
    setChecking(true);
    requestId.current++;
    const timer = setTimeout(() => void refresh(), 350);
    return () => { clearTimeout(timer); requestId.current++; };
  }, [config.binaryPath]);

  const test = async () => {
    setTesting(true);
    onTestingChange(true);
    setResult(undefined);
    const started = Date.now();
    try {
      const value = await window.mc.claudeCodeTest(config);
      if (mounted.current) setResult({ key, value });
    } catch (error) {
      if (mounted.current) setResult({ key, value: { ok: false, message: String(error), latencyMs: Date.now() - started } });
    } finally {
      if (mounted.current) {
        try { onSettingsRefreshed(await window.mc.getSettings()); } catch { /* keep the test result */ }
        setTesting(false);
        onTestingChange(false);
      }
    }
  };

  return <>
    <div className="settings-hint">{t.settings.claudeCodeHint}</div>
    <div className="settings-row">
      <label>{t.settings.claudeCodeStatus}</label>
      <div className="key-status" role="status" aria-live="polite">
        {checking ? <span>{t.settings.claudeCodeChecking}</span> : status && <>
          <span className={status.installed ? 'tag' : 'tag tag-err'}>
            {status.installed ? t.settings.claudeCodeInstalled : t.settings.claudeCodeMissing}
          </span>
          {status.installed && status.version && <span className="settings-inline-hint">{t.settings.claudeCodeVersion(status.version)}</span>}
          {status.installed && !status.error && <span className={status.authenticated ? 'tag' : 'tag tag-err'}>
            {status.authenticated ? t.settings.claudeCodeSignedIn : t.settings.claudeCodeSignedOut}
          </span>}
          {status.authenticated && status.authMethod && <span className="settings-inline-hint">{status.authMethod}</span>}
        </>}
        <button className="btn btn-sm" disabled={checking || testing} onClick={() => void refresh()}>
          {t.settings.claudeCodeRefresh}
        </button>
      </div>
      {status?.authenticated && status.accountEmail && <div className="settings-inline-hint codex-path">
        {t.settings.claudeCodeAccountEmail}: {status.accountEmail}
      </div>}
      {status?.authenticated && status.subscriptionType && <div className="settings-inline-hint">
        {t.settings.claudeCodePlan}: {status.subscriptionType}
      </div>}
      {status?.binaryPath && <span className="settings-inline-hint codex-path">{status.binaryPath}</span>}
      {(status?.error || statusError) && <div className="settings-warn">{status?.error || statusError}</div>}
      <span className="settings-inline-hint">{t.settings.claudeCodeLoginHint}</span>
    </div>
    <div className="settings-row">
      <label htmlFor="claude-code-model">{t.settings.claudeCodeModel}</label>
      <InWindowSelect
        id="claude-code-model"
        value={customModel ? '__custom' : !config.model ? '' : selectedModel ? config.model : '__custom'}
        disabled={testing}
        onChange={(value) => {
          setCustomModel(value === '__custom');
          if (value !== '__custom') onChange({ ...config, model: value });
        }}
        options={[
          { value: '', label: t.settings.claudeCodeDefaultModel },
          ...CLAUDE_CODE_MODELS.map((m) => ({ value: m.id, label: `${m.displayName} (${m.id})` })),
          { value: '__custom', label: t.settings.claudeCodeCustomModel },
        ]}
      />
      {(customModel || (!!config.model && !selectedModel)) && <input
        aria-label={t.settings.claudeCodeCustomModel}
        value={config.model ?? ''}
        disabled={testing}
        onChange={(e) => { setCustomModel(true); onChange({ ...config, model: e.target.value }); }}
        placeholder={t.settings.claudeCodeDefaultModel}
        spellCheck={false}
      />}
    </div>
    <div className="settings-row">
      <label htmlFor="claude-code-effort">{t.settings.claudeCodeEffort}</label>
      <InWindowSelect
        id="claude-code-effort"
        value={config.effort ?? ''}
        disabled={testing}
        onChange={(value) => onChange({ ...config, effort: (value || undefined) as ClaudeCodeEffort | undefined })}
        options={[
          { value: '', label: t.settings.claudeCodeDefaultEffort },
          ...CLAUDE_CODE_EFFORTS.map((effort) => ({ value: effort, label: effort })),
        ]}
      />
      <span className="settings-inline-hint">{t.settings.claudeCodeEffortHint}</span>
    </div>
    <div className="settings-row">
      <div className="key-status">
        <button className="btn btn-sm" disabled={testing || checking} onClick={() => void test()}>
          {testing ? t.settings.testing : t.settings.testConnection}
        </button>
        <span className="settings-inline-hint">{verification?.lastTestAt
          ? verification.lastTestOk
            ? t.settings.testLastOk(new Date(verification.lastTestAt).toLocaleString(t.locale), verification.latencyMs)
            : t.settings.testLastFail(new Date(verification.lastTestAt).toLocaleString(t.locale))
          : t.settings.testNever}</span>
      </div>
      <span className="settings-inline-hint">{t.settings.claudeCodeTestHint}</span>
      {fresh && <div role="status" aria-live="polite">
        <span className={fresh.ok ? 'tag tag-ok' : 'tag tag-err'}>
          {fresh.ok ? t.settings.testSuccessTag(fresh.latencyMs) : t.settings.testFailedTag}
        </span>
        <div className="settings-inline-hint">{fresh.message}</div>
        {fresh.ok && (saved.llm.backend !== 'claude-code-cli' || configKey(saved.llm.claudeCode) !== key) &&
          <div className="settings-inline-hint">{t.settings.claudeCodeUnsavedTest}</div>}
      </div>}
    </div>
    <details className="settings-advanced">
      <summary>{t.settings.claudeCodeAdvanced}</summary>
      <div className="settings-row">
        <label htmlFor="claude-code-binary">{t.settings.claudeCodeBinary}</label>
        <input id="claude-code-binary" value={config.binaryPath ?? ''} disabled={testing} spellCheck={false}
          onChange={(e) => onChange({ ...config, binaryPath: e.target.value })}
          placeholder={t.settings.claudeCodeAutomatic} />
        <span className="settings-inline-hint">{t.settings.claudeCodeBinaryHint}</span>
      </div>
    </details>
  </>;
}
