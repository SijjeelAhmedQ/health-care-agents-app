import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Button, Radio, Tooltip, message, type InputRef } from 'antd';
import { ArrowRight, CircleAlert, Inbox as InboxIcon, Mic, MousePointerClick, RefreshCw, TriangleAlert } from 'lucide-react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { useAppDispatch, useAppSelector } from '@/store';
import { fetchInbox, inboxActions } from '@/store/slices/inboxSlice';
import { patientSelectors } from '@/store/slices/patientSlice';
import { useLocalStorage, useResponsive } from '@/hooks';
import { inboxViews, isInboxView, type InboxItem, type InboxView } from '@/services/inbox/inboxModel';
import { priorityOf } from '@/services/inbox/inboxInsights';
import {
  applyFilters,
  emptyFilters,
  filterChips,
  groupItems,
  isFiltered as filtersInUse,
  normalizeSaved,
  providerOf,
  sortItems,
  type InboxDensity,
  type InboxFilters,
  type InboxSort,
} from '@/components/inbox/inboxFilters';
import { InboxCategoryNav, type ViewCounts } from '@/components/inbox/InboxCategoryNav';
import { InboxToolbar, shortcutList } from '@/components/inbox/InboxToolbar';
import { InboxList } from '@/components/inbox/InboxList';
import { InboxDetail, type ItemFlags } from '@/components/inbox/InboxDetail';
import { viewLabel } from '@/components/inbox/inboxUi';
import { InboxVoiceRegistry, getConfirmFiling, setConfirmFiling, subscribeConfirmFiling } from '@/services/inbox/inboxVoice';
import { voiceActions } from '@/store/slices/voiceSlice';
import { scrollMainToTop } from '@/utils/scroll';

const noFlags: ItemFlags = { portal: false, confidential: false, inactive: false };

/** Typing in a field must never trigger a single-key shortcut. */
const isTyping = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  const el = target;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || !!el.closest('.ant-select, .ant-picker, [role="dialog"], .ant-dropdown, .ant-popover');
};

/**
 * The Inbox: one workspace for lab results, radiology reports, referrals and
 * discharge summaries. Queues across the top, search and filters beneath, the
 * list on the left and the open item on the right. On smaller screens the list
 * and the item take turns.
 */
export default function InboxPage() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const { category: viewParam } = useParams<{ category?: string }>();
  const [params, setParams] = useSearchParams();
  const { isDesktop, isMobile } = useResponsive();
  const searchRef = useRef<InputRef>(null);

  const view: InboxView = isInboxView(viewParam) ? viewParam : 'all';
  const openId = params.get('item') ?? undefined;
  /** The patient filter (toolbar, or a voice command): only that patient's items. Never the selected patient. */
  const scopeId = params.get('patient') ?? null;

  const allItems = useAppSelector((s) => s.inbox.items);
  const items = useMemo(() => (scopeId ? allItems.filter((i) => i.patientId === scopeId) : allItems), [allItems, scopeId]);
  const micOn = useAppSelector((s) => s.voice.micActive);
  /** "What can I say?" — opened from the header button or by voice. */
  const confirmFiling = useSyncExternalStore(subscribeConfirmFiling, getConfirmFiling);
  const status = useAppSelector((s) => s.inbox.status);
  const loadError = useAppSelector((s) => s.inbox.error);
  const filedIds = useAppSelector((s) => s.inbox.reviewedIds);
  const patients = useAppSelector(patientSelectors.selectAll);

  const [filters, setFilters] = useState<InboxFilters>(() => emptyFilters(view));
  const [sort, setSort] = useLocalStorage<InboxSort>('careflow.inbox.sort', 'newest');
  const [savedSearches, setSavedSearches] = useLocalStorage<Record<string, Partial<InboxFilters> & Record<string, unknown>>>('careflow.inbox.savedSearches', {});
  const [flags, setFlags] = useLocalStorage<Record<string, ItemFlags>>('careflow.inbox.viewFlags', {});
  /** Row density is a personal reading preference: three lines with a preview, or two for fast triage. */
  const [density, setDensity] = useLocalStorage<InboxDensity>('careflow.inbox.density', 'comfortable');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  /** When the queue was last loaded — so "is this up to date?" never needs a guess. */
  const [checkedAt, setCheckedAt] = useState<string | null>(null);

  useEffect(() => {
    if (status === 'idle') void dispatch(fetchInbox());
    if (status === 'succeeded') setCheckedAt(dayjs().format('HH:mm'));
  }, [dispatch, status]);

  // The route owns the category, so a bookmark or a voice command lands correctly.
  useEffect(() => {
    setFilters((f) => (f.category === view ? f : { ...f, category: view }));
    setChecked(new Set());
  }, [view]);

  const filedSet = useMemo(() => new Set(filedIds), [filedIds]);
  const patientById = useMemo(() => new Map(patients.map((p) => [p.id, p])), [patients]);
  const inView = useMemo(() => (view === 'all' ? items : items.filter((i) => i.category === view)), [items, view]);

  const options = useMemo(
    () => ({
      subjects: [...new Set(inView.map((i) => i.subject))].sort().slice(0, 60),
      statuses: [...new Set(inView.map((i) => i.status))].sort(),
      providers: [...new Set(inView.map(providerOf).filter(Boolean))].sort().slice(0, 60),
      senders: [...new Set(inView.map((i) => i.from))].sort().slice(0, 60),
    }),
    [inView],
  );

  const filtered = useMemo(
    () => sortItems(applyFilters(items, filters, { filed: filedSet, patientById }), sort),
    [items, filters, filedSet, patientById, sort],
  );
  const groups = useMemo(() => groupItems(filtered, sort), [filtered, sort]);

  /** Per-queue numbers for the switcher: how much is left, and how much is pressing. */
  const viewCounts = useMemo(() => {
    const counts = Object.fromEntries(inboxViews.map((v) => [v, { total: 0, unfiled: 0, attention: 0 }])) as Record<InboxView, ViewCounts>;
    for (const item of items) {
      const unfiled = !filedSet.has(item.id);
      for (const v of ['all', item.category] as InboxView[]) {
        counts[v].total += 1;
        if (unfiled) counts[v].unfiled += 1;
        if (unfiled && item.attention) counts[v].attention += 1;
      }
    }
    return counts;
  }, [items, filedSet]);

  /** Header overview — what is still waiting, across every queue. */
  const overview = useMemo(() => {
    const waiting = items.filter((i) => !filedSet.has(i.id));
    return {
      unfiled: waiting.length,
      critical: waiting.filter((i) => priorityOf(i) === 'critical').length,
      high: waiting.filter((i) => priorityOf(i) === 'high').length,
    };
  }, [items, filedSet]);

  const openItem = useMemo(() => filtered.find((i) => i.id === openId) ?? allItems.find((i) => i.id === openId), [filtered, allItems, openId]);
  const openIndex = useMemo(() => filtered.findIndex((i) => i.id === openId), [filtered, openId]);
  const openPatient = openItem ? patientById.get(openItem.patientId) : undefined;
  const unfiledCount = useMemo(() => filtered.filter((i) => !filedSet.has(i.id)).length, [filtered, filedSet]);
  const anyFilter = filtersInUse(filters);

  // Read the latest URL through a ref so this (and every row's onSelect) keeps one identity —
  // otherwise opening an item would re-render every row in the list.
  const urlRef = useRef({ params, setParams });
  urlRef.current = { params, setParams };
  const setParam = useCallback((key: string, value?: string) => {
    const next = new URLSearchParams(urlRef.current.params);
    if (value) next.set(key, value);
    else next.delete(key);
    urlRef.current.setParams(next, { replace: true });
  }, []);

  const select = useCallback((item: InboxItem) => setParam('item', item.id), [setParam]);
  const step = useCallback(
    (delta: number) => {
      const next = openIndex < 0 ? filtered[0] : filtered[openIndex + delta];
      if (next) select(next);
    },
    [filtered, openIndex, select],
  );

  const onFilterChange = (next: Partial<InboxFilters>) => setFilters((f) => ({ ...f, ...next }));
  const resetFilters = () => setFilters(emptyFilters(view));

  const goToView = (next: InboxView) => {
    if (next === view) return;
    // Keep the open item only if it belongs to the queue being opened; a patient scope always stays.
    const keep = new URLSearchParams();
    if (openItem && (next === 'all' || openItem.category === next)) keep.set('item', openItem.id);
    if (scopeId) keep.set('patient', scopeId);
    const query = keep.toString();
    navigate(`/inbox/${next}${query ? `?${query}` : ''}`);
  };

  // ---- filing, with an undo on every change ------------------------------------------------
  const fileIds = useCallback(
    (ids: string[], file: boolean) => {
      const changing = ids.filter((id) => filedSet.has(id) !== file);
      if (!changing.length) return;
      dispatch(file ? inboxActions.markReviewed(changing) : inboxActions.markUnreviewed(changing));
      const key = `ibx-file-${Date.now()}`;
      const noun = `${changing.length} item${changing.length === 1 ? '' : 's'}`;
      message.open({
        key,
        type: 'success',
        duration: 5,
        content: (
          <span className="ibx-toast">
            {file ? `${noun} filed` : `${noun} moved back to unfiled`}
            <button
              type="button"
              className="ibx-toast-undo"
              onClick={() => {
                dispatch(file ? inboxActions.markUnreviewed(changing) : inboxActions.markReviewed(changing));
                message.destroy(key);
              }}
            >
              Undo
            </button>
          </span>
        ),
      });
    },
    [dispatch, filedSet],
  );

  const toggleFiled = useCallback((item: InboxItem) => fileIds([item.id], !filedSet.has(item.id)), [fileIds, filedSet]);

  const fileAndNext = (item: InboxItem) => {
    const next = filtered[openIndex + 1];
    fileIds([item.id], true);
    if (next) select(next);
  };

  const onBulkFile = (ids: string[], file: boolean) => {
    fileIds(ids, file);
    setChecked(new Set());
  };

  const onCheck = useCallback(
    (ids: string[], on: boolean) =>
      setChecked((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
        return next;
      }),
    [],
  );

  const itemFlags = openItem ? (flags[openItem.id] ?? noFlags) : noFlags;
  const toggleFlag = (flag: keyof ItemFlags) => {
    if (!openItem) return;
    const current = flags[openItem.id] ?? noFlags;
    setFlags({ ...flags, [openItem.id]: { ...current, [flag]: !current[flag] } });
  };

  // ---- saved views ---------------------------------------------------------------------------
  const saveView = () => {
    const parts = [viewLabel[filters.category], ...filterChips(filters).map((c) => c.label), filters.query ? `“${filters.query.trim()}”` : ''].filter(Boolean);
    let name = parts.join(' · ');
    if (savedSearches[name]) name = `${name} (${Object.keys(savedSearches).length + 1})`;
    setSavedSearches({ ...savedSearches, [name]: filters as unknown as Record<string, unknown> });
    message.success(`Saved view “${name}”`);
  };
  const loadView = (name: string) => {
    const saved = savedSearches[name];
    if (!saved) return;
    const next = normalizeSaved(saved, view);
    setFilters(next);
    if (next.category !== view) navigate(`/inbox/${next.category}`);
  };
  const deleteView = (name: string) => {
    const next = { ...savedSearches };
    delete next[name];
    setSavedSearches(next);
  };

  // ---- keyboard ------------------------------------------------------------------------------
  const keyState = useRef({ step, toggleFiled, openItem, isDesktop });
  keyState.current = { step, toggleFiled, openItem, isDesktop };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (e.key === 'Escape' && !isTyping(e.target) && !keyState.current.isDesktop && keyState.current.openItem) {
        setParam('item', undefined);
        return;
      }
      if (isTyping(e.target)) return;
      // Arrow keys belong to the list and the tab strip while they have focus.
      const inList = e.target instanceof HTMLElement && !!e.target.closest('.ibx-msglist, .ibx-cats');
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === 'j' || (e.key === 'ArrowDown' && !inList && keyState.current.openItem)) {
        e.preventDefault();
        keyState.current.step(1);
      } else if (e.key === 'k' || (e.key === 'ArrowUp' && !inList && keyState.current.openItem)) {
        e.preventDefault();
        keyState.current.step(-1);
      } else if ((e.key === 'e' || e.key === 'E') && keyState.current.openItem) {
        e.preventDefault();
        keyState.current.toggleFiled(keyState.current.openItem);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setParam]);

  // ---- voice ----------------------------------------------------------------------------------
  // The voice assistant drives this page through the very handlers the rows, buttons and
  // shortcuts use (select, fileIds, goToView, the search box) — read through a ref so the
  // registration stays put while the page re-renders.
  const voiceRef = useRef({ view, filtered, openItem, openIndex, filedSet, filters, scopeId, checked, status, select, fileIds, goToView });
  voiceRef.current = { view, filtered, openItem, openIndex, filedSet, filters, scopeId, checked, status, select, fileIds, goToView };
  useEffect(
    () =>
      InboxVoiceRegistry.register({
        snapshot: () => {
          const v = voiceRef.current;
          return {
            view: v.view,
            items: v.filtered,
            openItem: v.openItem,
            openIndex: v.openIndex,
            isFiled: (id: string) => v.filedSet.has(id),
            query: v.filters.query,
            scopePatientId: v.scopeId,
            checkedIds: [...v.checked],
            loading: v.status === 'idle' || v.status === 'loading',
          };
        },
        setView: (next) => voiceRef.current.goToView(next),
        setQuery: (query) => setFilters((f) => ({ ...f, query })),
        open: (item) => voiceRef.current.select(item),
        close: () => setParam('item', undefined),
        file: (ids, file) => voiceRef.current.fileIds(ids, file),
        setPatientScope: (patientId) => setParam('patient', patientId ?? undefined),
        showOnly: ({ status, filed, attention }) => {
          setParam('item', undefined);
          setFilters({ ...emptyFilters(voiceRef.current.view), status, filed: filed ?? 'all', ai: attention ? 'attention' : 'all' });
        },
      }),
    [setParam],
  );

  // On one-column layouts the item replaces the list, so it should start at the top.
  useEffect(() => {
    if (!isDesktop && openId) scrollMainToTop();
  }, [openId, isDesktop]);

  const loading = status === 'loading' && !items.length;
  const reading = !isDesktop && !!openItem;
  const firstUrgent = filtered.find((i) => !filedSet.has(i.id) && i.attention) ?? filtered.find((i) => !filedSet.has(i.id));
  /** The patient filter offers every patient with something in the Inbox. */
  const patientOptions = useMemo(() => {
    const ids = new Set(allItems.map((i) => i.patientId).filter(Boolean));
    return patients
      .filter((p) => ids.has(p.id))
      .sort((a, b) => a.fullName.localeCompare(b.fullName))
      .map((p) => ({ value: p.id, label: p.fullName, search: `${p.fullName} ${p.mrn}`.toLowerCase(), mrn: p.mrn }));
  }, [allItems, patients]);

  return (
    <div className={`ibx ${density === 'compact' ? 'is-compact' : ''}`}>
      <header className={`ibx-head ${reading ? 'is-hidden-sm' : ''}`}>
        <div className="ibx-head-text">
          <h1>Inbox</h1>
          <p>
            Lab results, radiology reports, referrals and discharge summaries waiting for review
            {checkedAt && <span className="ibx-head-updated"> · Updated {checkedAt}</span>}
          </p>
        </div>
        <div className="ibx-head-stats" aria-label="Waiting for review">
          {/* Always on screen: whose records the list shows. */}

          <button type="button" className="ibx-stat" onClick={() => setFilters({ ...emptyFilters(view), filed: 'unfiled' })}>
            <InboxIcon size={14} aria-hidden />
            <b>{overview.unfiled}</b> unfiled
          </button>
          {overview.critical > 0 && (
            <button type="button" className="ibx-stat is-critical" onClick={() => { setSort('priority'); setFilters({ ...emptyFilters(view), filed: 'unfiled' }); }}>
              <CircleAlert size={14} aria-hidden />
              <b>{overview.critical}</b> Critical
            </button>
          )}
          {overview.high > 0 && (
            <button type="button" className="ibx-stat is-high" onClick={() => setFilters({ ...emptyFilters(view), filed: 'unfiled', ai: 'attention' })}>
              <TriangleAlert size={14} aria-hidden />
              <b>{overview.high}</b> High priority
            </button>
          )}
          <span className="ibx-head-sep" aria-hidden />
          <Tooltip title={confirmFiling ? 'Voice asks “File this record?” before filing or unfiling' : 'Voice files straight away — Undo stays available'}>
            <div className="ibx-voice-setting">
              <span>Voice filing</span>
              <Radio.Group
                className="choice-bar is-sm"
                optionType="button"
                size="small"
                value={confirmFiling}
                onChange={(e) => setConfirmFiling(e.target.value as boolean)}
                aria-label="Ask before filing by voice"
                options={[
                  { value: true, label: 'Ask first' },
                  { value: false, label: 'File at once' },
                ]}
              />
            </div>
          </Tooltip>
          <Tooltip title="What the assistant can do">
            <Button size="small" icon={<Mic size={14} />} onClick={() => dispatch(voiceActions.setHelpOpen(true))} className="ibx-voice-help-btn" aria-label="What the assistant can do">
              <span className="ibx-voice-help-text">Assistant</span>
            </Button>
          </Tooltip>
          <Tooltip title="Check for new items">
            <Button
              type="text"
              icon={<RefreshCw size={15} className={status === 'loading' ? 'spin' : undefined} />}
              onClick={() => void dispatch(fetchInbox())}
              aria-label="Refresh the inbox"
              disabled={status === 'loading'}
            />
          </Tooltip>
        </div>
      </header>

      <div className={`ibx-shell ${reading ? 'is-reading' : ''}`}>
        <div className="ibx-controls">
          <InboxCategoryNav active={view} counts={viewCounts} onSelect={goToView} />
          <InboxToolbar
            ref={searchRef}
            value={filters}
            onChange={onFilterChange}
            onReset={resetFilters}
            sort={sort}
            onSort={setSort}
            options={options}
            savedNames={Object.keys(savedSearches)}
            onSaveView={saveView}
            onLoadView={loadView}
            onDeleteView={deleteView}
            canSave={anyFilter}
            compact={!isDesktop}
            density={density}
            onDensity={setDensity}
            patient={scopeId}
            patientOptions={patientOptions}
            onPatient={(id) => setParam('patient', id ?? undefined)}
          />
        </div>

        <div className="ibx-split">
          <section className="ibx-pane ibx-pane-list" aria-label="Inbox items">
            <InboxList
              groups={groups}
              view={view}
              showType={view === 'all'}
              loading={loading}
              error={status === 'failed' ? (loadError ?? 'Failed to load the inbox') : null}
              onRetry={() => void dispatch(fetchInbox())}
              selectedId={openId}
              filed={filedSet}
              patientById={patientById}
              onSelect={select}
              checked={checked}
              onCheck={onCheck}
              onBulkFile={onBulkFile}
              unfiledCount={unfiledCount}
              emptyReason={{
                anyAtAll: items.length > 0,
                anyInView: inView.length > 0,
                query: filters.query.trim(),
                filtered: filterChips(filters).length > 0 && !(filterChips(filters).length === 1 && filters.filed === 'unfiled'),
                onlyUnfiled: filters.filed === 'unfiled' && !filters.query.trim() && filterChips(filters).length === 1,
              }}
              onClearSearch={() => onFilterChange({ query: '' })}
              onClearFilters={resetFilters}
              onShowFiled={() => onFilterChange({ filed: 'all' })}
              showPositions={micOn}
            />
          </section>

          <section className="ibx-pane ibx-pane-detail" aria-label="Selected item">
            {openItem ? (
              <InboxDetail
                item={openItem}
                patient={openPatient}
                filed={filedSet.has(openItem.id)}
                onToggleFiled={toggleFiled}
                onFileAndNext={fileAndNext}
                position={{ index: openIndex >= 0 ? openIndex + 1 : 0, total: filtered.length }}
                onPrevious={() => step(-1)}
                onNext={() => step(1)}
                flags={itemFlags}
                onToggleFlag={toggleFlag}
                onBack={() => setParam('item', undefined)}
                showBack={!isDesktop}
                unfiledCount={unfiledCount}
              />
            ) : (
              <div className="ibx-noselect">
                <span className="ibx-noselect-icon">
                  <MousePointerClick size={26} aria-hidden />
                </span>
                <h2>Select an item to read it</h2>
                <p>The full result or letter opens here, with the patient it belongs to and the follow-up you can raise from it.</p>
                {firstUrgent && !loading && (
                  <Button type="primary" onClick={() => select(firstUrgent)}>
                    {firstUrgent.attention ? 'Open the first item needing attention' : 'Open the first unfiled item'} <ArrowRight size={14} aria-hidden />
                  </Button>
                )}
                {!isMobile && (
                  <dl className="ibx-shortcuts is-inline">
                    {shortcutList.slice(0, 4).map(([keys, what]) => (
                      <div key={keys}>
                        <dt>
                          <kbd>{keys.split('  or  ')[0]}</kbd>
                        </dt>
                        <dd>{what}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            )}
          </section>
        </div>
      </div>

    </div>
  );
}
