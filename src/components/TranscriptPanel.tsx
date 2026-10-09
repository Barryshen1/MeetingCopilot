import { useEffect, useRef, useState } from 'react';
import type { TranscriptSegment } from '../../shared/transcript';
import type { PublicSettings } from '../../shared/protocol';
import { useT } from '../i18n';
import { nextStick } from '../../shared/stickToBottom';

/** the sentence being spoken right now (and, with 实时翻译, its translation so far) */
export interface LivePartial {
  text: string;
  translation?: string;
}

interface SelPopup {
  text: string;
  x: number;
  y: number;
}

/**
 * Scrollable, persistent transcript (R3). Dual-channel: 对方 (system audio,
 * left) vs 我 (mic, right). Each bubble is one VAD sentence; a long question
 * may span several bubbles, so besides per-bubble ⚡答, the user can drag-SELECT
 * exact text across bubbles → a popup answers precisely that selection.
 * Translation is INLINE (原文/译文 对照) and off-session, so it never pollutes
 * the answer context / wastes tokens. With 实时翻译 on, 对方 sentences arrive
 * already translated (Model Studio LiveTranslate) and the live bubble shows
 * the translation as it streams.
 */
export function TranscriptPanel({
  segments,
  partials,
  answersReady,
  answersHint,
  onAsk,
  onTranslate,
  onClear,
  onExport,
  exportNotice,
  onRevealExport,
  liveTranslate,
  onToggleLiveTranslate,
  oeai = false,
}: {
  segments: TranscriptSegment[];
  partials?: { them?: LivePartial; me?: LivePartial };
  /** false = no LLM configured; transcription keeps working, ⚡答 does not */
  answersReady: boolean;
  answersHint: string;
  onAsk: (text: string) => void;
  onTranslate: (seg: TranscriptSegment) => void;
  onClear: () => void;
  /** write the meeting record (transcript only) now */
  onExport?: () => void;
  /** result line after a manual or automatic export */
  exportNotice?: { text: string; path?: string; error?: boolean } | null;
  onRevealExport?: (path: string) => void;
  /** 实时翻译 state; the switch only shows when a Model Studio workspace + key are saved */
  liveTranslate?: PublicSettings['asr']['liveTranslate'];
  onToggleLiveTranslate?: () => void;
  /** OEAI oral-interview answer mode changes the hint, not answer controls. */
  oeai?: boolean;
}) {
  const t = useT();
  const boxRef = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const lastTop = useRef(0);
  const [sel, setSel] = useState<SelPopup | null>(null);

  // live partials grow for as long as someone keeps talking: follow them too
  useEffect(() => {
    const el = boxRef.current;
    if (stick && el) {
      el.scrollTop = el.scrollHeight;
      lastTop.current = el.scrollTop;
    }
  }, [
    segments,
    partials?.them?.text,
    partials?.them?.translation,
    partials?.me?.text,
    partials?.me?.translation,
    stick,
  ]);

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    setStick((stuck) => nextStick(stuck, lastTop.current, el));
    lastTop.current = el.scrollTop;
    setSel(null);
  };

  const captureSelection = () => {
    const s = window.getSelection();
    const text = s?.toString().trim() ?? '';
    if (!text || !s || s.rangeCount === 0) {
      setSel(null);
      return;
    }
    const box = boxRef.current;
    const anchor = s.anchorNode;
    if (!box || !anchor || !box.contains(anchor.nodeType === 3 ? anchor.parentNode : anchor)) return;
    const rect = s.getRangeAt(0).getBoundingClientRect();
    setSel({ text, x: rect.left + rect.width / 2, y: rect.top });
  };

  const answerSel = () => {
    if (sel) onAsk(sel.text);
    window.getSelection()?.removeAllRanges();
    setSel(null);
  };

  return (
    <section className="pane pane-transcript">
      <header className="pane-head">
        <span className="pane-title">{t.transcript.title}</span>
        <span className="pane-hint">{oeai ? t.transcript.oeaiHint : t.transcript.hint}</span>
        {liveTranslate?.available && onToggleLiveTranslate && (
          <button
            className={liveTranslate.enabled ? 'btn btn-sm btn-on' : 'btn btn-sm'}
            onClick={onToggleLiveTranslate}
            aria-pressed={liveTranslate.enabled}
            title={(liveTranslate.enabled ? t.transcript.liveTranslateOnTitle : t.transcript.liveTranslateOffTitle)(
              t.transcript.liveTranslateTargets[liveTranslate.target] ?? liveTranslate.target,
            )}
          >
            {t.transcript.liveTranslate}
          </button>
        )}
        {onExport && (
          <button className="btn btn-sm" onClick={onExport} title={t.transcript.exportTitle}>
            {t.transcript.export}
          </button>
        )}
        <button className="btn btn-sm" onClick={onClear} title={t.transcript.clearTitle}>
          {t.transcript.clear}
        </button>
      </header>
      {exportNotice && (
        <div className={exportNotice.error ? 'kb-notice export-notice export-notice-error' : 'kb-notice export-notice'}>
          <span title={exportNotice.text}>{exportNotice.text}</span>
          {exportNotice.path && onRevealExport && (
            <button className="btn btn-sm" onClick={() => onRevealExport(exportNotice.path!)}>
              {t.transcript.exportShow}
            </button>
          )}
        </div>
      )}
      <div className="transcript" ref={boxRef} onScroll={onScroll} onMouseUp={captureSelection}>
        {segments.length === 0 ? (
          <div className="pane-empty">{t.transcript.empty}</div>
        ) : (
          segments.map((s) => {
            const me = s.speaker === 'me';
            return (
              <div
                key={s.id}
                className={`bubble ${me ? 'bubble-me' : 'bubble-them'}`}
                title={t.transcript.bubbleTitle}
                onClick={() => {
                  if (!window.getSelection()?.toString().trim()) {
                    void navigator.clipboard.writeText(s.text);
                  }
                }}
              >
                <div className="bubble-role">{me ? t.transcript.me : t.transcript.them}</div>
                <div className="bubble-text">{s.text}</div>
                {(s.translation || s.translating) && (
                  <div className="bubble-trans">{s.translating ? t.transcript.translating : s.translation}</div>
                )}
                <div className="bubble-meta">
                  {new Date(s.endTs).toLocaleTimeString(t.locale, { hour12: false })}
                  {s.lang
                    ? ` · ${s.lang === 'chinese' ? t.transcript.langZh : s.lang === 'english' ? t.transcript.langEn : s.lang}`
                    : ''}
                  {s.e2eMs !== undefined ? ` · ${(s.e2eMs / 1000).toFixed(2)}s` : ''}
                </div>
                <div className="bubble-btns">
                  <button
                    className="bubble-ask"
                    title={t.transcript.translateTitle}
                    onClick={(e) => {
                      e.stopPropagation();
                      onTranslate(s);
                    }}
                  >
                    {t.transcript.translateBtn}
                  </button>
                  {!me && (
                    <button
                      className="bubble-ask"
                      disabled={!answersReady}
                      title={answersReady ? t.transcript.answerTitle : answersHint}
                      onClick={(e) => {
                        e.stopPropagation();
                        onAsk(s.text);
                      }}
                    >
                      {t.transcript.answerBtn}
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
        {partials?.them?.text && (
          <div className="bubble bubble-them bubble-live">
            <div className="bubble-role">{`${t.transcript.them} · ${t.transcript.live}`}</div>
            <div className="bubble-text">{partials.them.text}</div>
            {partials.them.translation && <div className="bubble-trans">{partials.them.translation}</div>}
          </div>
        )}
        {partials?.me?.text && (
          <div className="bubble bubble-me bubble-live">
            <div className="bubble-role">{`${t.transcript.me} · ${t.transcript.live}`}</div>
            <div className="bubble-text">{partials.me.text}</div>
            {partials.me.translation && <div className="bubble-trans">{partials.me.translation}</div>}
          </div>
        )}
        {!stick && (
          <button
            className="jump-bottom"
            onClick={() => {
              setStick(true);
              if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
            }}
          >
            {t.transcript.jumpLatest}
          </button>
        )}
      </div>
      {sel && (
        <div
          className="sel-popup"
          style={{ left: sel.x, top: sel.y }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button
            className="btn btn-sm btn-primary"
            disabled={!answersReady}
            title={answersReady ? undefined : answersHint}
            onClick={answerSel}
          >
            {t.transcript.answerSelection}
          </button>
        </div>
      )}
    </section>
  );
}
