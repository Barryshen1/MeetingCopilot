import { useEffect, useRef, useState } from 'react';
import { codexConfigKey, type CodexReasoningEffort, type CodexSettings, type CodexStatus, type CodexTestResult } from '../../shared/codex';
import type { PublicSettings } from '../../shared/protocol';
import { useT } from '../i18n';

const EFFORTS: CodexReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

/** Match the effective configuration, including the CLI's own defaults. */
const configKey = codexConfigKey;

export function CodexProviderSettings({ config, saved, onChange, onSettingsRefreshed, onTestingChange }: {
  config: CodexSettings;
  saved: PublicSettings;
  onChange: (config: CodexSettings) => void;
  onSettingsRefreshed: (settings: PublicSettings) => void;
  onTestingChange: (testing: boolean) => void;
}) {
  const t = useT();
  const [status, setStatus] = useState<CodexStatus>();
  const [checking, setChecking] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ key: string; value: CodexTestResult }>();
  const [statusError, setStatusError] = useState('');
  const [customModel, setCustomModel] = useState(false);
  const requestId = useRef(0);
  const mounted = useRef(true);
  const key = configKey(config);
  const fresh = result?.key === key ? result.value : undefined;
  const verification = saved.llm.backend === 'codex-cli' && configKey(saved.llm.codex) === key
    ? saved.llm.verification : undefined;
  const selectedModel = status?.models.find((m) => m.id === config.model?.trim());
  const effortModel = selectedModel ?? (!config.model?.trim() ? status?.models.find((m) => m.isDefault) : undefined);
  const efforts = effortModel ? effortModel.supportedReasoningEfforts.map((e) => e.reasoningEffort) : EFFORTS;

  const refresh = async () => {
    const id = ++requestId.current;
    setChecking(true);
    setStatus(undefined);
    setStatusError('');
    try {
      const next = await window.mc.codexStatus(config);
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
    // Discovery reads installation/account/model information; it never generates text.
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
      const value = await window.mc.codexTest(config);
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
    <div className="settings-hint">{t.settings.codexHint}</div>
    <div className="settings-row">
      <label>{t.settings.codexStatus}</label>
      <div className="key-status" role="status" aria-live="polite">
        {checking ? <span>{t.settings.codexChecking}</span> : status && <>
          <span className={status.installed ? 'tag' : 'tag tag-err'}>
            {status.installed ? t.settings.codexInstalled : t.settings.codexMissing}
          </span>
          {status.installed && !status.error && <span className={status.authenticated ? 'tag' : 'tag tag-err'}>
            {status.authenticated ? t.settings.codexSignedIn : t.settings.codexSignedOut}
          </span>}
          {status.authenticated && status.accountType && <span className="settings-inline-hint">{status.accountType}</span>}
        </>}
        <button className="btn btn-sm" disabled={checking || testing} onClick={() => void refresh()}>
          {t.settings.codexRefresh}
        </button>
      </div>
      {status?.authenticated && status.accountEmail && <div className="settings-inline-hint codex-path">
        {t.settings.codexAccountEmail}: {status.accountEmail}
      </div>}
      {status?.authenticated && status.accountPlan && <div className="settings-inline-hint">
        {t.settings.codexAccountPlan}: {status.accountPlan}
      </div>}
      {status?.binaryPath && <span className="settings-inline-hint codex-path">{status.binaryPath}</span>}
      {(status?.error || statusError) && <div className="settings-warn">{status?.error || statusError}</div>}
      <span className="settings-inline-hint">{t.settings.codexLoginHint}</span>
    </div>
    <div className="settings-row">
      <label htmlFor="codex-model">{t.settings.codexModel}</label>
      <select
        id="codex-model"
        value={customModel ? '__custom' : !config.model ? '' : selectedModel ? config.model : '__custom'}
        disabled={testing}
        onChange={(e) => {
          setCustomModel(e.target.value === '__custom');
          if (e.target.value !== '__custom') onChange({ ...config, model: e.target.value, reasoningEffort: undefined });
        }}
      >
        <option value="">{t.settings.codexDefaultModel}</option>
        {(status?.models ?? []).map((m) => <option key={m.id} value={m.id}>{m.displayName} ({m.id})</option>)}
        <option value="__custom">{t.settings.codexCustomModel}</option>
      </select>
      {(customModel || (!!config.model && !selectedModel)) && <input
        aria-label={t.settings.codexCustomModel}
        value={config.model ?? ''}
        disabled={testing}
        onChange={(e) => { setCustomModel(true); onChange({ ...config, model: e.target.value }); }}
        placeholder={t.settings.codexDefaultModel}
        spellCheck={false}
      />}
    </div>
    <div className="settings-row">
      <label htmlFor="codex-effort">{t.settings.codexEffort}</label>
      <select
        id="codex-effort"
        value={config.reasoningEffort ?? ''}
        disabled={testing}
        onChange={(e) => onChange({ ...config, reasoningEffort: (e.target.value || undefined) as CodexReasoningEffort | undefined })}
      >
        <option value="">{t.settings.codexDefaultEffort}</option>
        {config.reasoningEffort && !efforts.includes(config.reasoningEffort) &&
          <option value={config.reasoningEffort}>{config.reasoningEffort} ({t.settings.codexUnsupportedEffort})</option>}
        {efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
      </select>
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
      <span className="settings-inline-hint">{t.settings.codexTestHint}</span>
      {fresh && <div role="status" aria-live="polite">
        <span className={fresh.ok ? 'tag tag-ok' : 'tag tag-err'}>
          {fresh.ok ? t.settings.testSuccessTag(fresh.latencyMs) : t.settings.testFailedTag}
        </span>
        <div className="settings-inline-hint">{fresh.message}</div>
        {fresh.ok && (saved.llm.backend !== 'codex-cli' || configKey(saved.llm.codex) !== key) &&
          <div className="settings-inline-hint">{t.settings.codexUnsavedTest}</div>}
      </div>}
    </div>
    <details className="settings-advanced">
      <summary>{t.settings.codexAdvanced}</summary>
      <div className="settings-row">
        <label htmlFor="codex-binary">{t.settings.codexBinary}</label>
        <input id="codex-binary" value={config.binaryPath ?? ''} disabled={testing} spellCheck={false}
          onChange={(e) => onChange({ ...config, binaryPath: e.target.value })}
          placeholder={t.settings.codexAutomatic} />
        <span className="settings-inline-hint">{t.settings.codexBinaryHint}</span>
      </div>
    </details>
  </>;
}
