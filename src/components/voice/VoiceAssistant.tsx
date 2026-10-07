import { useEffect, useRef, useState } from 'react';
import { Button, Input, Tooltip } from 'antd';
import {
  AlertCircle,
  Bot,
  Bug,
  Check,
  CheckCircle2,
  CircleHelp,
  Keyboard,
  Loader2,
  MessageCircleQuestion,
  Minus,
  Mic,
  MicOff,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/store';
import { voiceActions, type VoiceStatus } from '@/store/slices/voiceSlice';
import { AGENT_TITLES } from '@/services/ai/agents/taskGraph';
import { uiActions } from '@/store/slices/uiSlice';
import { getVoiceController } from '@/services/ai/voiceController';
import { aiConfig } from '@/services/ai/config';
import { getSpeakReplies, isSpeechSupported, setSpeakReplies, stopSpeaking } from '@/services/ai/speech';

const statusMeta: Record<VoiceStatus, { label: string; color: string }> = {
  idle: { label: 'Ready', color: '#5d6478' },
  listening: { label: 'Listening…', color: '#e5484d' },
  transcribing: { label: 'Transcribing…', color: '#c26a00' },
  processing: { label: 'Understanding…', color: '#148fde' },
  executing: { label: 'Executing…', color: '#0780d8' },
  confirmation_required: { label: 'Waiting for confirmation', color: '#c26a00' },
  completed: { label: 'Completed', color: '#0f9d63' },
  error: { label: 'Error', color: '#e5484d' },
  cancelled: { label: 'Cancelled', color: '#5d6478' },
};

/** A few things worth trying — shown before the first request, as examples to say, not buttons. */
const examples = ['Show my dashboard summary', 'Select patient Liam Thompson', 'Add a task to call the lab tomorrow'];

/** The panel sits above antd's default tooltip layer (1070), so its tooltips must sit higher still. */
const TOOLTIP_Z = 1300;

export function VoiceAssistant() {
  const dispatch = useAppDispatch();
  const voice = useAppSelector((s) => s.voice);
  const [typed, setTyped] = useState('');
  const [showTyping, setShowTyping] = useState(false);
  // Answers and questions are spoken unless the user mutes them.
  const [speakReplies, setSpeak] = useState(getSpeakReplies);
  const meta = statusMeta[voice.status];
  const busy = voice.status === 'processing' || voice.status === 'executing' || voice.status === 'transcribing';
  // The microphone switch is owned by the user (micActive) — not by the transcription lifecycle.
  const micOn = voice.micActive;
  const controller = getVoiceController();
  const bodyRef = useRef<HTMLDivElement>(null);
  // A ticking clock while the assistant works, so a slow request never looks frozen.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!voice.busySince && voice.model.status !== 'loading' && voice.model.status !== 'warming') return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [voice.busySince, voice.model.status]);
  const elapsed = voice.busySince ? Math.max(0, Math.round((now - voice.busySince) / 1000)) : 0;
  const preparingFor = (voice.model.status === 'loading' || voice.model.status === 'warming') && voice.model.since ? Math.round((now - voice.model.since) / 1000) : 0;
  // Say nothing about a warm-up that takes a moment; explain one that takes long.
  const showLoading = (voice.model.status === 'loading' && preparingFor >= 3) || (voice.model.status === 'warming' && preparingFor >= 8);
  const modelName = voice.llmProvider.split(':').slice(1).join(':') || 'the model';

  const heard = voice.interimTranscript || voice.transcript;
  const botText = voice.response ? (voice.error ?? voice.response) : voice.error;
  const pending = voice.pendingConfirmation;
  const hasConversation = !!heard || !!botText || !!pending || !!voice.pendingSlot || voice.history.length > 0;
  // The latest finished turn is the exchange on screen; the list below it is what came before.
  const earlier = voice.history.filter((h, i) => !(i === 0 && h.transcript === voice.transcript)).slice(0, 4).reverse();

  // Follow the conversation down, the way a chat keeps its newest message in view.
  useEffect(() => {
    const node = bodyRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [voice.panelOpen, heard, botText, pending, voice.pendingSlot, voice.history.length, busy]);

  // Typing or changing the spoken-reply setting means the user is not talking: the mic goes off.
  const micOffForOtherInput = () => {
    if (controller.isMicActive) controller.stopListening();
  };

  const submitTyped = () => {
    if (!typed.trim()) return;
    void controller.handleTranscript(typed.trim());
    setTyped('');
  };

  const orbState = micOn ? 'is-live' : busy ? 'is-busy' : voice.status === 'error' ? 'is-error' : '';
  const headline = micOn && voice.status === 'idle' ? 'Listening…' : meta.label;

  return (
    <>
      {voice.panelOpen && (
        <div className="voice-panel" role="dialog" aria-label="Voice assistant">
          <div className="va-head">
            <div className="va-head-row">
              <span className={`va-orb ${micOn ? 'is-live' : busy ? 'is-busy' : ''}`} aria-hidden>
                <Sparkles size={19} color="#fff" />
                <span className={`va-orb-dot ${orbState}`} />
              </span>
              <div className="va-title">
                <strong>Assistant</strong>
                <span>
                  {headline}
                  <span className="va-title-tail"> · ask in your own words</span>
                </span>
              </div>
              <div className="va-head-actions">
                <Tooltip title="What the assistant can do" zIndex={TOOLTIP_Z}>
                  <Button type="text" size="small" className="va-head-btn" icon={<CircleHelp size={16} />} onClick={() => dispatch(voiceActions.setHelpOpen(true))} aria-label="What the assistant can do" />
                </Tooltip>
                {aiConfig.enableDebugPanel && (
                  <Tooltip title="Debug" zIndex={TOOLTIP_Z}>
                    <Button type="text" size="small" className="va-head-btn" icon={<Bug size={16} />} onClick={() => dispatch(uiActions.setDebugPanelOpen(true))} aria-label="Open debug panel" />
                  </Tooltip>
                )}
                <Button type="text" size="small" className="va-head-btn" icon={<X size={18} />} onClick={() => dispatch(voiceActions.setPanelOpen(false))} aria-label="Close voice assistant" />
              </div>
            </div>
            <div className="va-chips">
              {micOn && (
                <span className="va-chip is-live">
                  <Mic size={12} aria-hidden /> Mic on
                </span>
              )}
              {voice.llmProvider && (
                <span className="va-chip" title={voice.llmProvider}>
                  <Bot size={12} aria-hidden /> <span>{voice.llmProvider}</span>
                </span>
              )}
              <span className="va-chip">
                <ShieldCheck size={12} aria-hidden /> Saves and deletes need your OK
              </span>
            </div>
          </div>

          <div className="va-status" style={{ color: meta.color }} role="status">
            {voice.status === 'listening' || (micOn && voice.status === 'idle') ? (
              <span className="voice-waveform">
                <span />
                <span />
                <span />
                <span />
                <span />
              </span>
            ) : busy ? (
              <Loader2 size={16} className="spin" />
            ) : voice.status === 'completed' ? (
              <CheckCircle2 size={16} />
            ) : voice.status === 'error' ? (
              <AlertCircle size={16} />
            ) : voice.status === 'confirmation_required' ? (
              <AlertCircle size={16} />
            ) : (
              <Mic size={16} />
            )}
            <span>{headline}</span>
            {voice.currentAction && voice.currentAction !== meta.label && <span className="muted">· {voice.currentAction}</span>}
            {elapsed >= 2 && <span className="muted">· {elapsed} s</span>}
            {micOn && voice.status !== 'listening' && voice.status !== 'idle' && <span className="muted" style={{ fontSize: 12 }}>· mic still on</span>}
          </div>

          <div className="va-body" ref={bodyRef}>
            {showLoading && (
              <div className="voice-model-note">
                {voice.model.status === 'loading'
                  ? voice.llmProvider.startsWith('vllm:')
                    ? `Loading ${modelName} into the GPU's memory · ${preparingFor} s — after the notebook starts or the model changes this takes 1–3 minutes; a load that gets stuck is restarted by the server on its own. After that, requests take a few seconds.`
                    : `Loading ${modelName} into memory · ${preparingFor} s — this happens after starting the computer or switching models (about 1–2 minutes on this GPU). After that, requests take a few seconds.`
                  : `Preparing ${modelName} · ${preparingFor} s — it is reading the assistant's instructions again (after an app update this takes 1–2 minutes). After that, requests take a few seconds.`}
              </div>
            )}
            {voice.model.status === 'error' && <div className="voice-model-note is-error">The model could not be loaded: {voice.model.error}</div>}

            {!hasConversation && !micOn ? (
              <div className="va-empty">
                <span className="va-empty-orb" aria-hidden>
                  <Sparkles size={26} />
                </span>
                <h3>How can I help?</h3>
                <p>{voice.micSupported ? 'Tap the microphone and ask in your own words…' : 'Microphone not supported here — type your request below.'}</p>
                <div className="va-suggest" aria-label="Things you can say">
                  {examples.map((e) => (
                    <span key={e} className="va-suggest-chip">
                      “{e}”
                    </span>
                  ))}
                </div>
                <Button type="link" size="small" icon={<CircleHelp size={14} />} style={{ paddingInline: 0, marginTop: 4 }} onClick={() => dispatch(voiceActions.setHelpOpen(true))}>
                  What can the assistant do?
                </Button>
              </div>
            ) : (
              <>
                {earlier.length > 0 && (
                  <div className="va-history">
                    <div className="va-history-title">Recent</div>
                    {earlier.map((h) => (
                      <div key={h.id} className="va-history-item">
                        <span className="va-history-dot" style={{ background: h.status === 'error' ? '#e5484d' : h.status === 'confirmation' ? '#d97706' : '#0f9d63' }} aria-hidden />
                        <span>
                          {h.transcript && <b>“{h.transcript}” </b>}
                          <span>{h.response.split('\n')[0]}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {heard ? (
                  <div className="va-msg is-user">
                    <div className={`va-bubble ${voice.interimTranscript ? 'is-interim' : ''}`}>“{heard}”</div>
                  </div>
                ) : micOn ? (
                  <div className="va-msg is-user">
                    <div className="va-bubble is-interim">Listening — speak whenever you are ready. The mic turns off after a 10 second pause.</div>
                  </div>
                ) : null}

                {voice.plan && voice.plan.length > 1 && (
                  <div className="va-plan" aria-label="Steps of this request">
                    <div className="va-plan-head">
                      {busy ? `Step ${Math.min(voice.plan.filter((s) => s.status !== 'pending').length, voice.plan.length)} of ${voice.plan.length}` : `${voice.plan.length} steps`}
                    </div>
                    <ol>
                      {voice.plan.map((s, i) => (
                        <li key={i} className={`is-${s.status}`}>
                          <span className="va-plan-mark" aria-hidden>
                            {s.status === 'running' ? (
                              <Loader2 size={13} className="spin" />
                            ) : s.status === 'done' ? (
                              <Check size={13} />
                            ) : s.status === 'waiting' ? (
                              <AlertCircle size={13} />
                            ) : s.status === 'failed' ? (
                              <X size={13} />
                            ) : s.status === 'cancelled' ? (
                              <Minus size={13} />
                            ) : (
                              i + 1
                            )}
                          </span>
                          <span>
                            {s.text}
                            {s.agent && <span className="va-plan-agent">{AGENT_TITLES[s.agent]}</span>}
                          </span>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}

                {busy && !botText && (
                  <div className="va-msg is-bot">
                    <span className="va-msg-avatar" aria-hidden>
                      <Sparkles size={13} />
                    </span>
                    <div className="va-bubble va-typing" aria-label="Working">
                      <span />
                      <span />
                      <span />
                    </div>
                  </div>
                )}

                {botText && (
                  <div className="va-msg is-bot">
                    <span className="va-msg-avatar" aria-hidden>
                      <Sparkles size={13} />
                    </span>
                    <div className={`va-bubble ${voice.error ? 'is-error' : ''}`}>{botText}</div>
                  </div>
                )}

                {voice.pendingSlot && voice.status !== 'error' && (
                  <div className="va-card is-question">
                    <div className="va-card-head">
                      <span className="va-card-icon" aria-hidden>
                        <MessageCircleQuestion size={15} />
                      </span>
                      Question
                    </div>
                    <div>{voice.pendingSlot.question}</div>
                    <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                      Answer by voice or type below.
                    </div>
                  </div>
                )}

                {/* Records being added (medications, diagnoses, tasks, recalls, appointments, the care plan) and
                    appointment changes are reviewed and saved in their own dialog, not confirmed again here. */}
                {pending && !(pending.kind === 'form' && pending.formId !== 'patient') && (
                  <div className={`va-card ${pending.kind === 'delete' ? 'is-danger' : 'is-confirm'}`}>
                    <div className="va-card-head">
                      <span className="va-card-icon" aria-hidden>
                        {pending.kind === 'delete' ? <Trash2 size={15} /> : <ShieldCheck size={15} />}
                      </span>
                      {pending.kind === 'delete' ? `${pending.formTitle} — confirm deletion` : pending.kind === 'inbox_file' ? pending.formTitle : `${pending.formTitle} — ready to save`}
                    </div>
                    <div className="va-summary">
                      {pending.summary.slice(0, 8).map((s) => (
                        <div key={s.label} style={{ display: 'contents' }}>
                          <span className="muted">{s.label}</span>
                          <strong>{s.value}</strong>
                        </div>
                      ))}
                      {pending.summary.length > 8 && <span className="muted">+{pending.summary.length - 8} more</span>}
                    </div>
                    <div className="va-card-note">
                      {pending.kind === 'delete'
                        ? 'This cannot be undone. Confirm here, or tell the assistant.'
                        : pending.kind === 'inbox_file'
                          ? 'Confirm here, or tell the assistant.'
                          : 'Review the form, then confirm here or tell the assistant.'}
                    </div>
                    <div className="va-card-actions">
                      <Button type="primary" danger={pending.kind === 'delete'} icon={<Check size={15} />} onClick={() => void controller.resolvePending(true)}>
                        {pending.kind === 'delete' ? 'Delete' : pending.kind === 'inbox_file' ? (pending.inboxFile === false ? 'Yes, unfile' : 'Yes, file') : 'Save'}
                      </Button>
                      <Button onClick={() => void controller.resolvePending(false)}>Cancel</Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="va-composer">
            <div className="va-composer-main">
              {showTyping || !voice.micSupported ? (
                <Input.Search
                  className="va-input"
                  placeholder="Ask the assistant…"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  onSearch={submitTyped}
                  enterButton={<Send size={15} />}
                  autoFocus
                  aria-label="Type a request for the assistant"
                />
              ) : (
                <>
                  <button
                    type="button"
                    className={`va-mic-btn ${micOn ? 'is-live' : ''}`}
                    onClick={() => controller.toggleListening()}
                    disabled={!micOn && busy}
                    aria-pressed={micOn}
                  >
                    <span className="va-mic-btn-icon" aria-hidden>
                      {micOn ? <MicOff size={17} /> : <Mic size={18} />}
                    </span>
                    {micOn ? 'Mic Off' : 'Speak'}
                  </button>
                  {(busy || micOn) && (
                    <Button className="va-ghost-btn" icon={<X size={15} />} onClick={() => controller.cancel()}>
                      Cancel
                    </Button>
                  )}
                </>
              )}
            </div>
            {isSpeechSupported() && (
              <Tooltip title={speakReplies ? 'Spoken replies on — click to mute' : 'Spoken replies muted'} zIndex={TOOLTIP_Z}>
                <Button
                  type="text"
                  className="va-tool-btn"
                  icon={speakReplies ? <Volume2 size={17} /> : <VolumeX size={17} />}
                  onClick={() => {
                    micOffForOtherInput();
                    const next = !speakReplies;
                    setSpeak(next);
                    setSpeakReplies(next);
                    if (!next) stopSpeaking();
                  }}
                  aria-label={speakReplies ? 'Mute spoken replies' : 'Enable spoken replies'}
                  aria-pressed={speakReplies}
                />
              </Tooltip>
            )}
            {voice.micSupported && (
              <Tooltip title={showTyping ? 'Use microphone' : 'Type instead'} zIndex={TOOLTIP_Z}>
                <Button
                  type="text"
                  className="va-tool-btn"
                  icon={showTyping ? <Mic size={17} /> : <Keyboard size={17} />}
                  onClick={() => {
                    if (!showTyping) micOffForOtherInput();
                    setShowTyping((v) => !v);
                  }}
                  aria-label="Toggle typing mode"
                />
              </Tooltip>
            )}
          </div>
        </div>
      )}

      <Tooltip title={micOn ? 'Turn microphone off' : 'Turn microphone on (Ctrl+Shift+V)'} placement="left" zIndex={TOOLTIP_Z}>
        <button
          type="button"
          className={`voice-fab ${micOn ? 'listening' : ''}`}
          onClick={() => {
            // Explicit user toggle.
            if (micOn) controller.stopListening();
            else if (voice.micSupported) controller.startListening();
            else dispatch(voiceActions.setPanelOpen(!voice.panelOpen));
          }}
          aria-label={micOn ? 'Turn microphone off' : 'Turn microphone on'}
          aria-pressed={micOn}
        >
          {micOn ? <MicOff size={24} /> : voice.micSupported ? <Mic size={24} /> : <Keyboard size={24} />}
        </button>
      </Tooltip>
    </>
  );
}
