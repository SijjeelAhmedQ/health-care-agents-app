/**
 * The agents as a network: the provider, the master, and the specialists, with a line for every pair
 * that shook hands — how often, how it went, and whether work is passing over it right now. Below it, the
 * selected request's tasks in dependency order: what ran first, and what waited for whom.
 */
import { useMemo, useState } from 'react';
import { Select } from 'antd';
import { ArrowRight, Network } from 'lucide-react';
import type { MonitorAgentKey, MonitorParty } from '@/types/monitor';
import { isAgent, networkEdges, partyTitle, taskDepth, tasksOf, type NetworkEdge } from '@/services/ai/monitor/views';
import { AgentLabel, AgentStatusPill, fmtTime, MonCard, Nothing, PartyIcon, TaskLink, TaskStatusPill, useMonitorView } from './parts';

/** The specialists in two rows: the app's areas above, a patient's records (one agent per kind) below. */
const TOP_ROW: readonly MonitorAgentKey[] = ['dashboard', 'patients', 'appointments', 'patient_appointments', 'inbox', 'summary'];
const BOTTOM_ROW: readonly MonitorAgentKey[] = ['medications', 'diagnoses', 'tasks', 'recalls', 'notes'];
const SPECIALISTS: readonly MonitorAgentKey[] = [...TOP_ROW, ...BOTTOM_ROW];
const R = 34;
const GAP = 162;
const POS = {
  ...Object.fromEntries(TOP_ROW.map((a, i) => [a, { x: 500 - ((TOP_ROW.length - 1) / 2) * GAP + i * GAP, y: 365 }])),
  ...Object.fromEntries(BOTTOM_ROW.map((a, i) => [a, { x: 500 - ((BOTTOM_ROW.length - 1) / 2) * GAP + i * GAP, y: 560 }])),
  provider: { x: 500, y: 58 },
  master: { x: 500, y: 200 },
  // Beside the master: the Planning Agent gathers what each action needs; the Safety Agent checks every call.
  planning: { x: 215, y: 200 },
  safety: { x: 785, y: 200 },
} as Record<MonitorParty, { x: number; y: number }>;

/** The line between two nodes, from rim to rim; specialists side by side are joined by an arc below them. */
function edgePath(from: MonitorParty, to: MonitorParty): { d: string; label: { x: number; y: number } } {
  const a = POS[from];
  const b = POS[to];
  if (a.y === b.y) {
    // A → B and B → A both dip below; the second one deeper, so the two never lie on each other.
    const dip = (70 + Math.abs(b.x - a.x) * 0.12) * (a.x < b.x ? 1 : 1.35);
    const mx = (a.x + b.x) / 2;
    return { d: `M ${a.x} ${a.y + R} Q ${mx} ${a.y + R + dip * 2} ${b.x} ${b.y + R}`, label: { x: mx, y: a.y + R + dip } };
  }
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const x1 = a.x + ux * (R + 4);
  const y1 = a.y + uy * (R + 4);
  const x2 = b.x - ux * (R + 10);
  const y2 = b.y - uy * (R + 10);
  return { d: `M ${x1} ${y1} L ${x2} ${y2}`, label: { x: (x1 + x2) / 2 + (dx === 0 ? 30 : 0), y: (y1 + y2) / 2 } };
}

function Edge({ edge }: { edge: NetworkEdge }) {
  const { d, label } = edgePath(edge.from, edge.to);
  const state = edge.active ? 'active' : edge.rejected ? 'failed' : edge.pending ? 'pending' : 'ok';
  const title = `${partyTitle(edge.from)} → ${partyTitle(edge.to)}: ${edge.total} handshake${edge.total === 1 ? '' : 's'} (${edge.accepted} successful${edge.rejected ? `, ${edge.rejected} failed` : ''}${edge.cancelled ? `, ${edge.cancelled} cancelled` : ''}${edge.pending ? `, ${edge.pending} pending` : ''}) — last ${fmtTime(edge.last)}`;
  return (
    <g className="mon-edge" data-state={state}>
      <title>{title}</title>
      <path d={d} className="mon-edge-line" markerEnd={`url(#mon-arrow-${state})`} />
      <g transform={`translate(${label.x}, ${label.y})`} className="mon-edge-label">
        <rect x={-26} y={-11} width={52} height={22} rx={11} />
        <text textAnchor="middle" dy={4}>
          {edge.rejected ? `✓${edge.accepted} ✗${edge.rejected}` : `✓ ${edge.accepted}${edge.pending ? '…' : ''}`}
        </text>
      </g>
    </g>
  );
}

function Node({ party, off }: { party: MonitorParty; off: boolean }) {
  const { m } = useMonitorView();
  const p = POS[party];
  const agent = isAgent(party) ? m.agents[party] : undefined;
  const status = off ? 'off' : (agent?.status ?? (m.requests[0]?.status === 'running' ? 'running' : 'idle'));
  const task = agent?.taskKey ? m.tasks[agent.taskKey] : undefined;
  const sub = off ? 'Off · single-agent mode' : agent ? `${agent.status[0].toUpperCase()}${agent.status.slice(1)}${task && agent.status !== 'idle' ? ` · ${task.label}` : ''}` : 'Speaks to the assistant';
  return (
    <g className="mon-node" data-status={status} transform={`translate(${p.x}, ${p.y})`}>
      <title>{`${partyTitle(party)} — ${sub}${agent?.activity ? ` — ${agent.activity}` : ''}`}</title>
      {status === 'running' && <circle r={R + 9} className="mon-node-halo" />}
      <circle r={R} className="mon-node-disc" />
      <g transform="translate(-12, -12)" className="mon-node-icon">
        <PartyIcon party={party} size={24} />
      </g>
      <text y={R + 20} textAnchor="middle" className="mon-node-name">
        {partyTitle(party)}
      </text>
      <text y={R + 37} textAnchor="middle" className="mon-node-sub">
        {sub}
      </text>
    </g>
  );
}

export function NetworkView() {
  const { m } = useMonitorView();
  const withTasks = m.requests.filter((r) => m.handshakes.some((h) => h.requestId === r.id));
  const [scope, setScope] = useState<string>('all');
  const requestId = scope === 'all' ? undefined : scope;
  const edges = useMemo(() => networkEdges(m, requestId), [m, requestId]);
  const single = m.mode === 'single';
  const flowRequest = requestId ?? withTasks.find((r) => tasksOf(m).some((t) => t.requestId === r.id))?.id;
  const flowTasks = tasksOf(m).filter((t) => t.requestId === flowRequest);
  const columns: (typeof flowTasks)[] = [];
  for (const t of flowTasks) (columns[taskDepth(t, m)] ??= []).push(t);

  return (
    <div className="mon-stack">
      <MonCard
        title="Agent network"
        icon={<Network size={16} />}
        extra={
          <Select
            className="mon-select"
            value={scope}
            onChange={setScope}
            popupMatchSelectWidth={false}
            aria-label="Which requests"
            options={[{ value: 'all', label: 'All requests' }, ...withTasks.slice(0, 30).map((r) => ({ value: r.id, label: `${fmtTime(r.startedAt)} · “${r.said.length > 48 ? `${r.said.slice(0, 48)}…` : r.said}”` }))]}
          />
        }
      >
        <div className="mon-network-wrap">
          <svg className="mon-network" viewBox="0 0 1000 680" role="img" aria-label="Agents and the handshakes between them">
            <defs>
              {(['ok', 'active', 'failed', 'pending'] as const).map((s) => (
                <marker key={s} id={`mon-arrow-${s}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" className={`mon-arrow is-${s}`} />
                </marker>
              ))}
            </defs>
            {/* Every possible line, faint: who could talk to whom. */}
            <g className="mon-edge-ghosts">
              <path d={edgePath('provider', 'master').d} />
              {SPECIALISTS.map((a) => (
                <path key={a} d={edgePath('master', a).d} />
              ))}
            </g>
            {edges.map((e) => (
              <Edge key={`${e.from}>${e.to}`} edge={e} />
            ))}
            <Node party="provider" off={false} />
            <Node party="master" off={false} />
            <Node party="planning" off={single} />
            <Node party="safety" off={false} />
            {SPECIALISTS.map((a) => (
              <Node key={a} party={a} off={single} />
            ))}
          </svg>
        </div>
        <ul className="mon-legend" aria-label="Legend">
          <li data-state="active">Work passing now</li>
          <li data-state="ok">Handshakes succeeded</li>
          <li data-state="failed">A handshake failed</li>
          <li data-state="pending">Waiting for an answer</li>
        </ul>
        {single && <p className="mon-hint">Single-agent mode: the Master Agent does everything itself. Turn on multi-agent mode (Configuration → Agents) to see work handed between agents.</p>}
      </MonCard>

      <MonCard title="Task flow" icon={<ArrowRight size={16} />} extra={flowRequest ? <span className="muted">“{m.requests.find((r) => r.id === flowRequest)?.said}”</span> : undefined}>
        {flowTasks.length ? (
          <div className="mon-flowgrid">
            {columns.map((col, i) => (
              <div key={i} className="mon-flowcol">
                <div className="mon-flowcol-head">{i === 0 ? 'Runs first' : `Step ${i + 1} — after what it needs`}</div>
                {col.map((t) => {
                  const agent = m.agents[t.agent];
                  return (
                    <div key={t.key} className="mon-flowcard" data-status={t.status}>
                      <div className="mon-flowcard-top">
                        <TaskLink taskKey={t.key} label={t.label} />
                        <TaskStatusPill status={t.status} />
                      </div>
                      <AgentLabel party={t.agent} />
                      <p>{t.instruction}</p>
                      {t.dependsOn.length > 0 && <div className="muted">needs {t.dependsOn.map((k) => m.tasks[k]?.label ?? '?').join(', ')}</div>}
                      {t.reassignments.length > 0 && <div className="mon-warn-text">reassigned from {t.reassignments.map((r) => partyTitle(r.from)).join(', ')}</div>}
                      {agent?.taskKey === t.key && agent.status === 'running' && <AgentStatusPill status="running" />}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        ) : (
          <Nothing>No tasks yet. In multi-agent mode each request the master plans shows here as its tasks, in the order they can run.</Nothing>
        )}
      </MonCard>
    </div>
  );
}
