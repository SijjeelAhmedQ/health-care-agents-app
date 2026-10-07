import { Button, Skeleton, Tooltip } from 'antd';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowUpRight, BookOpenText, Bot, Database, ListTree, Sparkles, Volume2, X } from 'lucide-react';
import dayjs from 'dayjs';
import { useAppDispatch, useAppSelector } from '@/store';
import { uiActions } from '@/store/slices/uiSlice';
import { speak } from '@/services/ai/speech';
import { useDockWidth } from '@/hooks/useDockWidth';
import type { FactTone } from '@/services/ai/summary/summaryFacts';

/** A tone as the dock's stat cards name it. */
const STAT_TONE: Record<FactTone, string> = { primary: 'is-primary', info: 'is-info', success: 'is-success', warning: 'is-warning', error: 'is-error', neutral: 'is-neutral' };

/** The summary text: paragraphs, and "- " lines as a list. */
function SummaryText({ text }: { text: string }) {
  const blocks: Array<{ list: boolean; lines: string[] }> = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const item = /^[-•]\s+/.test(line);
    const last = blocks[blocks.length - 1];
    if (last && last.list === item && item) last.lines.push(line.replace(/^[-•]\s+/, ''));
    else blocks.push({ list: item, lines: [item ? line.replace(/^[-•]\s+/, '') : line] });
  }
  return (
    <>
      {blocks.map((b, i) =>
        b.list ? (
          <ul key={i} className="sum-dock-points">
            {b.lines.map((l, j) => (
              <li key={j}>{l}</li>
            ))}
          </ul>
        ) : (
          <p key={i}>{b.lines[0]}</p>
        ),
      )}
    </>
  );
}

/**
 * The Summary panel: what the Summary Agent wrote, docked to the right of any page. The figures and lists the
 * app gathered show at once; the text follows as soon as the model has written it (or, without one, from the
 * same data). The assistant itself only says one line — the summary is here.
 */
export function SummaryDock() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const summary = useAppSelector((s) => s.ui.summary);
  const { startDrag } = useDockWidth('careflow.summaryPanel.width', 400);
  if (!summary) return null;
  const { facts } = summary;
  const close = () => dispatch(uiActions.setSummaryPanelOpen(false));
  const writing = summary.status === 'writing';
  const by = summary.source === 'model' ? `Written by ${summary.model ?? 'the Summary Agent'} from CareFlow's records` : "Written from CareFlow's records";

  return (
    <aside className="dash-dock sum-dock" aria-label="Summary" data-status={summary.status}>
      <div className="dash-dock-resize" role="separator" aria-orientation="vertical" aria-label="Resize the summary panel" onPointerDown={startDrag} />
      <header className="dash-dock-head">
        <span className="dash-dock-mark" aria-hidden>
          <Sparkles size={15} />
        </span>
        <div className="dash-dock-title">
          <strong>{facts.title}</strong>
          <span title={facts.scope}>{facts.scope}</span>
        </div>
        <Tooltip title="Read it aloud">
          <Button type="text" size="small" className="dash-dock-icon-btn" aria-label="Read the summary aloud" icon={<Volume2 size={15} />} disabled={writing || !summary.text} onClick={() => summary.text && speak(summary.text, { force: true })} />
        </Tooltip>
        <Tooltip title="Close">
          <Button type="text" size="small" className="dash-dock-icon-btn" aria-label="Close the summary" icon={<X size={16} />} onClick={close} />
        </Tooltip>
      </header>

      <div className="dash-dock-body">
        <section className="dash-dock-narrative sum-dock-text" aria-live="polite" aria-busy={writing}>
          <h3>
            <BookOpenText size={13} aria-hidden /> Summary
          </h3>
          {writing ? (
            <div className="sum-dock-writing">
              <Skeleton active title={false} paragraph={{ rows: 4, width: ['100%', '96%', '88%', '62%'] }} />
              <span className="sum-dock-writing-note">
                <Bot size={13} aria-hidden /> The Summary Agent is writing…
              </span>
            </div>
          ) : (
            <SummaryText text={summary.text ?? ''} />
          )}
          {!writing && (
            <p className="sum-dock-source" title={summary.note}>
              {summary.source === 'model' ? <Bot size={12} aria-hidden /> : <Database size={12} aria-hidden />}
              <span>{by}</span>
              <span className="sum-dock-time">{dayjs(summary.at).format('h:mm A')}</span>
            </p>
          )}
        </section>

        {summary.request && (
          <p className="sum-dock-asked">
            You asked: <q>{summary.request}</q>
          </p>
        )}

        {facts.stats.length > 0 && (
          <section className="dash-dock-stats sum-dock-stats" aria-label="In numbers">
            {facts.stats.map((s) => (
              <div key={s.label} className={`dash-dock-stat ${STAT_TONE[s.tone ?? 'neutral']}`}>
                <span className="dash-dock-stat-value">{s.value}</span>
                <span className="dash-dock-stat-label">{s.label}</span>
              </div>
            ))}
          </section>
        )}

        {facts.sections
          .filter((s) => s.title !== 'In brief')
          .map((s) => (
            <section key={s.title} className="dash-dock-section">
              <h3>
                <ListTree size={13} aria-hidden /> {s.title} <span className="dash-dock-count">{s.items.length + (s.more ?? 0)}</span>
              </h3>
              <ul className="sum-dock-items">
                {s.items.map((item, i) => (
                  <li key={i} data-tone={item.tone ?? 'neutral'}>
                    <strong>{item.text}</strong>
                    {item.detail && <span className="muted">{item.detail}</span>}
                  </li>
                ))}
              </ul>
              {!!s.more && <p className="dash-dock-more">…and {s.more} more</p>}
            </section>
          ))}
      </div>

      {facts.link && (
        <footer className="dash-dock-foot">
          <Button size="small" onClick={close}>
            Close
          </Button>
          {location.pathname !== facts.link.path.split('?')[0] && (
            <Button size="small" type="primary" icon={<ArrowUpRight size={14} />} iconPosition="end" onClick={() => navigate(facts.link!.path)}>
              {facts.link.label}
            </Button>
          )}
        </footer>
      )}
    </aside>
  );
}
