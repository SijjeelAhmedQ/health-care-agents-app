import { forwardRef, useState } from 'react';
import { Badge, Button, DatePicker, Dropdown, Input, Modal, Popover, Segmented, Select, Tooltip, type InputRef } from 'antd';
import { ArrowDownUp, Bookmark, BookmarkPlus, Keyboard, Rows2, Rows3, Search, SlidersHorizontal, Trash2, TriangleAlert, Users, X } from 'lucide-react';
import dayjs from 'dayjs';
import {
  activeFilterCount,
  filterChips,
  receivedLabels,
  sortLabels,
  type InboxDensity,
  type InboxFilters,
  type InboxSort,
  type ReceivedFilter,
} from './inboxFilters';

interface Props {
  value: InboxFilters;
  onChange: (next: Partial<InboxFilters>) => void;
  onReset: () => void;
  sort: InboxSort;
  onSort: (sort: InboxSort) => void;
  /** Distinct values from the items currently in scope. */
  options: { subjects: string[]; statuses: string[]; providers: string[]; senders: string[] };
  savedNames: string[];
  onSaveView: () => void;
  onLoadView: (name: string) => void;
  onDeleteView: (name: string) => void;
  canSave: boolean;
  compact: boolean;
  density: InboxDensity;
  onDensity: (density: InboxDensity) => void;
  /** One patient's items only (id), or every patient's (null). */
  patient: string | null;
  patientOptions: Array<{ value: string; label: string; search: string; mrn: string }>;
  onPatient: (id: string | null) => void;
}

const toOptions = (values: string[]) => values.map((v) => ({ value: v, label: v }));

/** A labelled row inside the filter popover. */
function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="ibx-ff">
      <label className="ibx-ff-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  );
}

export const shortcutList: Array<[string, string]> = [
  ['/', 'Search the inbox'],
  ['J  or  ↓', 'Next item'],
  ['K  or  ↑', 'Previous item'],
  ['E', 'File or unfile the open item'],
  ['Esc', 'Close the item / leave search'],
];

/**
 * Search, quick toggles, filters, sort and saved views — in that order of use.
 * Everything applies as it changes; there is no separate "Search" step.
 */
export const InboxToolbar = forwardRef<InputRef, Props>(function InboxToolbar(
  { value, onChange, onReset, sort, onSort, options, savedNames, onSaveView, onLoadView, onDeleteView, canSave, compact, density, onDensity, patient, patientOptions, onPatient },
  searchRef,
) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const count = activeFilterCount(value);
  const chips = filterChips(value);

  const filterPanel = (
    <div className="ibx-filterpanel" role="group" aria-label="Filters">
      <Field label="Filing">
        <Segmented
          block
          size="small"
          value={value.filed}
          onChange={(v) => onChange({ filed: v as InboxFilters['filed'] })}
          options={[
            { value: 'all', label: 'All' },
            { value: 'unfiled', label: 'Unfiled' },
            { value: 'filed', label: 'Filed' },
          ]}
        />
      </Field>
      <Field label="Priority & AI">
        <Segmented
          block
          size="small"
          value={value.ai}
          onChange={(v) => onChange({ ai: v as InboxFilters['ai'] })}
          options={[
            { value: 'all', label: 'All' },
            { value: 'attention', label: 'Attention' },
            { value: 'suggestions', label: 'Suggestions' },
          ]}
        />
      </Field>
      <Field label="Received" htmlFor="ibx-f-received">
        <Select
          id="ibx-f-received"
          value={value.received}
          onChange={(v: ReceivedFilter) => onChange({ received: v, ...(v !== 'custom' ? { from: undefined, to: undefined } : {}) })}
          options={(Object.keys(receivedLabels) as ReceivedFilter[]).map((k) => ({ value: k, label: receivedLabels[k] }))}
          getPopupContainer={(n) => n.parentElement ?? document.body}
        />
        {value.received === 'custom' && (
          <DatePicker.RangePicker
            className="ibx-ff-range"
            format="DD/MM/YYYY"
            allowEmpty={[true, true]}
            value={[value.from ? dayjs(value.from) : null, value.to ? dayjs(value.to) : null]}
            onChange={(range) => onChange({ from: range?.[0]?.format('YYYY-MM-DD'), to: range?.[1]?.format('YYYY-MM-DD') })}
            getPopupContainer={(n) => n.parentElement ?? document.body}
            aria-label="Received between"
          />
        )}
      </Field>
      <Field label="Status" htmlFor="ibx-f-status">
        <Select
          id="ibx-f-status"
          allowClear
          placeholder="Any status"
          value={value.status}
          onChange={(v) => onChange({ status: v })}
          options={toOptions(options.statuses)}
          getPopupContainer={(n) => n.parentElement ?? document.body}
        />
      </Field>
      <Field label="Subject" htmlFor="ibx-f-subject">
        <Select
          id="ibx-f-subject"
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder="Any subject"
          value={value.subject}
          onChange={(v) => onChange({ subject: v })}
          options={toOptions(options.subjects)}
          getPopupContainer={(n) => n.parentElement ?? document.body}
        />
      </Field>
      <div className="ibx-ff-pair">
        <Field label="Provider" htmlFor="ibx-f-provider">
          <Select
            id="ibx-f-provider"
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="Any provider"
            value={value.provider}
            onChange={(v) => onChange({ provider: v })}
            options={toOptions(options.providers)}
            getPopupContainer={(n) => n.parentElement ?? document.body}
          />
        </Field>
        <Field label="From" htmlFor="ibx-f-sender">
          <Select
            id="ibx-f-sender"
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="Any sender"
            value={value.sender}
            onChange={(v) => onChange({ sender: v })}
            options={toOptions(options.senders)}
            getPopupContainer={(n) => n.parentElement ?? document.body}
          />
        </Field>
      </div>
      <div className="ibx-filterpanel-foot">
        <Button type="text" size="small" onClick={onReset} disabled={!count && !value.query}>
          Clear all
        </Button>
        <Button type="primary" size="small" onClick={() => setFiltersOpen(false)}>
          Done
        </Button>
      </div>
    </div>
  );

  const savedMenu = {
    items: [
      { key: '__save', icon: <BookmarkPlus size={14} />, label: 'Save current view', disabled: !canSave },
      ...(savedNames.length ? [{ type: 'divider' as const }] : []),
      ...savedNames.map((name) => ({
        key: name,
        icon: <Bookmark size={14} />,
        label: (
          <span className="ibx-saved-item">
            <span>{name}</span>
            <button
              type="button"
              className="ibx-saved-del"
              aria-label={`Delete saved view ${name}`}
              onClick={(e) => {
                e.stopPropagation();
                onDeleteView(name);
              }}
            >
              <Trash2 size={13} />
            </button>
          </span>
        ),
      })),
    ],
    onClick: ({ key }: { key: string }) => (key === '__save' ? onSaveView() : onLoadView(key)),
  };

  return (
    <div className="ibx-toolbar">
      <div className="ibx-toolbar-row">
        <Input
          ref={searchRef}
          allowClear
          className="ibx-search"
          prefix={<Search size={15} aria-hidden className="ibx-search-icon" />}
          suffix={!compact && !value.query ? <kbd aria-hidden>/</kbd> : undefined}
          placeholder={compact ? 'Search patient, NHI, test…' : 'Search patient, NHI, phone, test, sender or date'}
          value={value.query}
          onChange={(e) => onChange({ query: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
          }}
          aria-label="Search the inbox"
        />

        {/* Whose records: every patient's unless one is chosen here — never the patient selected elsewhere. */}
        <Select
          className="ibx-patient-filter"
          showSearch
          allowClear
          value={patient ?? undefined}
          placeholder={
            <span className="ibx-patient-filter-ph">
              <Users size={14} aria-hidden /> All patients
            </span>
          }
          onChange={(v) => onPatient((v as string | undefined) ?? null)}
          options={patientOptions.map((o) => ({ value: o.value, label: o.label, search: o.search, mrn: o.mrn }))}
          optionRender={(o) => (
            <span className="ibx-patient-option">
              <span>{o.data.label}</span>
              <span className="ibx-patient-option-mrn">{(o.data as { mrn?: string }).mrn}</span>
            </span>
          )}
          filterOption={(input, o) => String((o as { search?: string } | undefined)?.search ?? '').includes(input.toLowerCase())}
          notFoundContent="No patient with Inbox items"
          aria-label="Filter by patient"
          popupMatchSelectWidth={false}
        />

        <div className="ibx-quick" role="group" aria-label="Quick filters">
          <button
            type="button"
            className={`ibx-toggle ${value.filed === 'unfiled' ? 'is-on' : ''}`}
            aria-pressed={value.filed === 'unfiled'}
            onClick={() => onChange({ filed: value.filed === 'unfiled' ? 'all' : 'unfiled' })}
          >
            <span className="ibx-toggle-dot" aria-hidden />
            Unfiled
          </button>
          <button
            type="button"
            className={`ibx-toggle is-attention ${value.ai === 'attention' ? 'is-on' : ''}`}
            aria-pressed={value.ai === 'attention'}
            onClick={() => onChange({ ai: value.ai === 'attention' ? 'all' : 'attention' })}
          >
            <TriangleAlert size={13} aria-hidden />
            {compact ? 'Urgent' : 'Needs attention'}
          </button>
        </div>

        <div className="ibx-toolbar-end">
          {compact ? (
            <>
              <Button
                icon={<SlidersHorizontal size={15} />}
                className={count ? 'ibx-btn-active' : undefined}
                aria-label={`Filters${count ? `, ${count} active` : ''}`}
                onClick={() => setFiltersOpen(true)}
              >
                {count > 0 && <Badge count={count} size="small" className="ibx-btn-badge" />}
              </Button>
              {/* On small screens the filters get a dialog of their own rather than a cramped popover. */}
              <Modal open={filtersOpen} onCancel={() => setFiltersOpen(false)} title="Filters" footer={null} width={400} className="ibx-filter-modal" destroyOnHidden>
                {filterPanel}
              </Modal>
            </>
          ) : (
            <Popover
              trigger="click"
              placement="bottomRight"
              open={filtersOpen}
              onOpenChange={setFiltersOpen}
              content={filterPanel}
              arrow={false}
              overlayClassName="ibx-filter-popover"
            >
              <Button icon={<SlidersHorizontal size={15} />} className={count ? 'ibx-btn-active' : undefined} aria-label={`Filters${count ? `, ${count} active` : ''}`}>
                Filters
                {count > 0 && <Badge count={count} size="small" className="ibx-btn-badge" />}
              </Button>
            </Popover>
          )}

          <Dropdown
            trigger={['click']}
            menu={{
              selectable: true,
              selectedKeys: [sort],
              items: (Object.keys(sortLabels) as InboxSort[]).map((k) => ({ key: k, label: sortLabels[k] })),
              onClick: ({ key }) => onSort(key as InboxSort),
            }}
          >
            <Button icon={<ArrowDownUp size={15} />} aria-label={`Sort: ${sortLabels[sort]}`}>
              {!compact && <span className="ibx-sort-label">{sortLabels[sort]}</span>}
            </Button>
          </Dropdown>

          <Tooltip title={density === 'compact' ? 'Show previews (comfortable rows)' : 'Hide previews (compact rows)'}>
            <Button
              icon={density === 'compact' ? <Rows2 size={15} /> : <Rows3 size={15} />}
              aria-label="Compact rows"
              aria-pressed={density === 'compact'}
              className={density === 'compact' ? 'ibx-btn-active' : undefined}
              onClick={() => onDensity(density === 'compact' ? 'comfortable' : 'compact')}
            />
          </Tooltip>

          <Dropdown trigger={['click']} menu={savedMenu}>
            <Button icon={<Bookmark size={15} />} aria-label="Saved views">
              {!compact && 'Saved'}
            </Button>
          </Dropdown>

          {!compact && (
            <Popover
              trigger={['hover', 'click']}
              placement="bottomRight"
              title="Keyboard shortcuts"
              content={
                <dl className="ibx-shortcuts">
                  {shortcutList.map(([keys, what]) => (
                    <div key={keys}>
                      <dt>
                        {keys.split('  or  ').map((k, i) => (
                          <span key={k}>
                            {i > 0 && <span className="muted"> or </span>}
                            <kbd>{k}</kbd>
                          </span>
                        ))}
                      </dt>
                      <dd>{what}</dd>
                    </div>
                  ))}
                </dl>
              }
            >
              <Button type="text" icon={<Keyboard size={16} />} aria-label="Keyboard shortcuts" className="ibx-kbd-btn" />
            </Popover>
          )}
        </div>
      </div>

      {chips.length > 0 && (
        <div className="ibx-chips" aria-label="Filters in use">
          {chips.map((chip) => (
            <Tooltip key={chip.key} title="Remove this filter">
              <button type="button" className="ibx-chip" onClick={() => onChange(chip.clear)} aria-label={`Remove filter ${chip.label}`}>
                {chip.label}
                <X size={12} aria-hidden />
              </button>
            </Tooltip>
          ))}
          <button type="button" className="ibx-chip-clear" onClick={onReset}>
            Clear all
          </button>
        </div>
      )}
    </div>
  );
});
