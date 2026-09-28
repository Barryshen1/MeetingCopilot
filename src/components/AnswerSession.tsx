import { useEffect, useRef, useState } from 'react';
import type { KbSlot, ScreenshotMode, StoredSession } from '../../shared/protocol';
import { useT } from '../i18n';
import { InWindowSelect } from './InWindowSelect';

export type TurnKind = 'segment' | 'continuous' | 'free' | 'translate' | 'vision';

export interface AnswerTurn {
  id: string;
  kind: TurnKind;
  label: string;
  text: string;
  status: 'streaming' | 'done' | 'error';
  error?: string;
}

/**
 * 智能体 conversation panel (R4) with a multi-session bar. Answers ACCUMULATE
 * as a scrolling session (never replaced); each meeting is its own session
 * with its own knowledge base. The 📷 screenshot button only appears in
 * multimodal mode (it needs a vision model).
 */
export function AnswerSession({
  sessions,
  currentId,
  turns,
  resumeName,
  resumeChars,
  jdName,
  jdChars,
  referenceFiles,
  notice,
  visionReady,
  answersReady,
  answersHint,
  onSwitch,
  onNew,
  onDelete,
  onRename,
  onPickKb,
  onClearKb,
  onAddReference,
  onRemoveReference,
  onCancel,
  onClear,
  onFreeAsk,
  onShotAsk,
  screenshotMode,
  onScreenshotModeChange,
  codexModel,
  codexEffort,
  onConfigureCodex,
}: {
  sessions: StoredSession[];
  currentId: string;
  turns: AnswerTurn[];
  resumeName?: string;
  resumeChars: number;
  jdName?: string;
  jdChars: number;
  referenceFiles: { id: string; name: string; chars: number }[];
  /** transient parse warning (e.g. scanned PDF with no text layer) */
  notice?: string | null;
  visionReady: boolean;
  /** false = no LLM configured; asking is disabled with an explanation */
  answersReady: boolean;
  answersHint: string;
  onSwitch: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onPickKb: (slot: KbSlot) => void;
  onClearKb: (slot: KbSlot) => void;
  onAddReference: () => void;
  onRemoveReference: (id: string) => void;
  onCancel: (id: string) => void;
  onClear: () => void;
  onFreeAsk: (question: string) => void;
  onShotAsk: (question: string, imageDataUrl?: string) => void;
  screenshotMode: ScreenshotMode;
  onScreenshotModeChange: (mode: ScreenshotMode) => void;
  /** Present only when Codex CLI generates answers. */
  codexModel?: string;
  codexEffort?: string;
  onConfigureCodex?: () => void;
}) {
  const t = useT();
  const boxRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const currentName = sessions.find((s) => s.id === currentId)?.name ?? '';

  useEffect(() => {
    if (stick.current && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  });

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  const submit = () => {
    const q = inputRef.current?.value.trim();
    if (!q) return;
    onFreeAsk(q);
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <section className="pane pane-answer">
      <header className="pane-head session-bar">
        {editing ? (
          <input
            className="session-select"
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => {
              onRename(currentId, nameDraft);
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                onRename(currentId, nameDraft);
                setEditing(false);
              } else if (e.key === 'Escape') {
                setEditing(false);
              }
            }}
          />
        ) : (
          <InWindowSelect
            className="session-select"
            value={currentId}
            onChange={onSwitch}
            ariaLabel={t.answer.switchTitle}
            options={sessions.map((s) => ({ value: s.id, label: s.name }))}
          />
        )}
        <button
          className="btn btn-sm"
          onClick={() => {
            setNameDraft(currentName);
            setEditing(true);
          }}
          title={t.answer.renameTitle}
        >
          ✎
        </button>
        <button className="btn btn-sm" onClick={onNew} title={t.answer.newTitle}>
          ＋
        </button>
        <button className="btn btn-sm" onClick={() => onDelete(currentId)} title={t.answer.deleteTitle}>
          🗑
        </button>
        <span className="session-spacer" />
        <button className="btn btn-sm" onClick={onClear} title={t.answer.clearTitle}>
          {t.answer.clear}
        </button>
      </header>
      <div className="material-bar" role="group" aria-label={t.answer.materialsLabel}>
        <div className="material-slot">
          <button
            className={resumeChars > 0 ? 'btn btn-sm btn-on material-file-name' : 'btn btn-sm material-file-name'}
            onClick={() => onPickKb('resume')}
            title={
              resumeChars > 0
                ? t.answer.resumeSetTitle(resumeName ?? '', resumeChars)
                : t.answer.resumeEmptyTitle
            }
          >
            📄{resumeChars > 0 ? resumeName ?? t.answer.resume : t.answer.resume}
          </button>
          {resumeChars > 0 && (
            <button
              className="btn btn-sm"
              onClick={() => onClearKb('resume')}
              title={t.answer.resumeRemoveTitle}
              aria-label={t.answer.resumeRemoveTitle}
            >
              ×
            </button>
          )}
        </div>
        <div className="material-slot">
          <button
            className={jdChars > 0 ? 'btn btn-sm btn-on material-file-name' : 'btn btn-sm material-file-name'}
            onClick={() => onPickKb('jd')}
            title={jdChars > 0 ? t.answer.jdSetTitle(jdName ?? '', jdChars) : t.answer.jdEmptyTitle}
          >
            📋{jdChars > 0 ? jdName ?? t.answer.jd : t.answer.jd}
          </button>
          {jdChars > 0 && (
            <button
              className="btn btn-sm"
              onClick={() => onClearKb('jd')}
              title={t.answer.jdRemoveTitle}
              aria-label={t.answer.jdRemoveTitle}
            >
              ×
            </button>
          )}
        </div>
        <button className="btn btn-sm" onClick={onAddReference} title={t.answer.addReferenceTitle}>
          {t.answer.addReference}
        </button>
        {window.mc.platform === 'darwin' && (
          <span className="material-share-hint">{t.answer.filePickerShareHint}</span>
        )}
        {referenceFiles.length > 0 && (
          <div className="reference-file-list" role="list" aria-label={t.answer.referenceFilesLabel}>
            {referenceFiles.map((file) => (
              <div className="material-slot" role="listitem" key={file.id}>
                <span className="reference-file-name" title={t.answer.referenceFileTitle(file.name, file.chars)}>
                  📎{file.name}
                </span>
                <button
                  className="btn btn-sm"
                  onClick={() => onRemoveReference(file.id)}
                  title={t.answer.removeReferenceTitle(file.name)}
                  aria-label={t.answer.removeReferenceTitle(file.name)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      {notice && <div className="kb-notice">{notice}</div>}
      <div className="session" ref={boxRef} onScroll={onScroll}>
        {turns.length === 0 ? (
          <div className="pane-empty">
            {t.answer.empty}
            {resumeChars === 0 && jdChars === 0 && referenceFiles.length === 0 && t.answer.emptyKbHint}
          </div>
        ) : (
          turns.map((turn) => (
            <div key={turn.id} className={`turn turn-${turn.kind}`}>
              <div className="turn-head">
                <span className="turn-tag">{t.answer.kindTag[turn.kind]}</span>
                <span className="turn-label" title={turn.label}>
                  {turn.label}
                </span>
                {turn.status === 'streaming' ? (
                  <button className="btn btn-sm" onClick={() => onCancel(turn.id)}>
                    {t.answer.stop}
                  </button>
                ) : (
                  <button
                    className="btn btn-sm"
                    onClick={() => void navigator.clipboard.writeText(turn.text)}
                    title={t.answer.copyTitle}
                  >
                    {t.answer.copy}
                  </button>
                )}
              </div>
              <div className="turn-body">
                {turn.status === 'error' ? (
                  <span className="answer-error">{turn.error}</span>
                ) : (
                  <>
                    {turn.text || (turn.kind === 'vision' ? t.answer.visionWaiting : t.answer.genWaiting)}
                    {turn.status === 'streaming' && <span className="cursor">▍</span>}
                  </>
                )}
              </div>
            </div>
          ))
        )}
      </div>
      {!answersReady && <div className="kb-notice">{answersHint}</div>}
      {onConfigureCodex && <div className="answer-model-row">
        <span>{t.answer.codexModelLabel}</span>
        <button type="button" className="btn btn-sm answer-model-button"
          onClick={onConfigureCodex} title={t.answer.changeCodexModel}>
          {codexModel || t.answer.codexDefaultModel}{codexEffort ? ` · ${codexEffort}` : ''} ▾
        </button>
      </div>}
      {visionReady && (
        <div className="screenshot-mode-row">
          <span>{t.answer.screenshotModeLabel}</span>
          <div className="screenshot-mode-options" role="group" aria-label={t.answer.screenshotModeTitle}>
            <button
              type="button"
              className={screenshotMode === 'general' ? 'btn btn-sm btn-on' : 'btn btn-sm'}
              aria-pressed={screenshotMode === 'general'}
              onClick={() => onScreenshotModeChange('general')}
            >
              {t.answer.screenshotGeneral}
            </button>
            <button
              type="button"
              className={screenshotMode === 'coding-test' ? 'btn btn-sm btn-on' : 'btn btn-sm'}
              aria-pressed={screenshotMode === 'coding-test'}
              onClick={() => onScreenshotModeChange('coding-test')}
            >
              {t.answer.screenshotCodingTest}
            </button>
          </div>
        </div>
      )}
      <div className="answer-input">
        <input
          ref={inputRef}
          disabled={!answersReady}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit();
          }}
          placeholder={answersReady ? t.answer.freePlaceholder : answersHint}
        />
        <button
          className="btn btn-primary"
          disabled={!answersReady}
          title={answersReady ? undefined : answersHint}
          onClick={submit}
        >
          {t.answer.ask}
        </button>
        {visionReady && (
          <>
            <button
              className="btn"
              aria-label={t.answer.shotTitle}
              onClick={() => {
                const q = inputRef.current?.value.trim() ?? '';
                if (inputRef.current) inputRef.current.value = '';
                onShotAsk(q);
              }}
            >
              📷
            </button>
            <button
              className="btn btn-sm"
              aria-label={t.answer.regionShotTitle}
              onClick={async () => {
                const q = inputRef.current?.value.trim() ?? '';
                const img = await window.mc.pickRegion();
                if (!img) return; // cancelled
                if (inputRef.current) inputRef.current.value = '';
                onShotAsk(q, img);
              }}
            >
              {t.answer.regionShot}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
