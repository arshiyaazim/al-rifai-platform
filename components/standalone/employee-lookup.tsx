'use client';

import {displayMobile} from '@/lib/display-mobile';
import {Search} from 'lucide-react';
import {useEffect, useRef, useState} from 'react';

export type EmployeeSuggestion = {
  employee_mobile: string;
  preferred_name: string;
  name_aliases: string[];
  designation: string | null;
  state: string;
};

type Props = {
  id: string;
  label: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  onSelect: (employee: EmployeeSuggestion) => void;
  required?: boolean;
  /** Hide the visible label but keep it for screen readers. */
  hideLabel?: boolean;
  /** Draw a magnifying glass inside the input (compact search bar). */
  showIcon?: boolean;
  inputClassName?: string;
};

/**
 * Backend-driven employee lookup. The server caps every response at ten
 * suggestions; this component only projects those results and never invents an
 * identifier. The verified identifier is `employees.employee_mobile`.
 */
export function EmployeeLookup({id, label, placeholder, value, onChange, onSelect, required, hideLabel = false, showIcon = false, inputClassName = ''}: Props) {
  const [suggestions, setSuggestions] = useState<EmployeeSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const request = useRef(0);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  async function load(query: string): Promise<EmployeeSuggestion[]> {
    const ticket = ++request.current;
    setLoading(true);
    try {
      const response = await fetch(
        `/api/employees?lookup=1&q=${encodeURIComponent(query)}`,
        {credentials: 'same-origin', cache: 'no-store'},
      );
      if (!response.ok) {
        if (ticket === request.current) setSuggestions([]);
        return [];
      }
      const body = (await response.json()) as {suggestions?: EmployeeSuggestion[]};
      if (ticket !== request.current) return [];
      const items = (body.suggestions ?? []).slice(0, 10);
      setSuggestions(items);
      setOpen(true);
      setActive(-1);
      return items;
    } catch {
      if (ticket === request.current) setSuggestions([]);
      return [];
    } finally {
      if (ticket === request.current) setLoading(false);
    }
  }

  function update(next: string) {
    onChange(next);
    if (timer.current) clearTimeout(timer.current);
    const query = next.trim();
    if (!query) {
      request.current += 1;
      setSuggestions([]);
      setOpen(false);
      setActive(-1);
      setLoading(false);
      return;
    }
    timer.current = setTimeout(() => { void load(query); }, 200);
  }

  function select(employee: EmployeeSuggestion) {
    onSelect(employee);
    setOpen(false);
    setActive(-1);
    setSuggestions([]);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) {
        if (suggestions.length) setOpen(true);
        return;
      }
      setActive((index) => Math.min(index + 1, suggestions.length - 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      if (open && suggestions.length) {
        event.preventDefault();
        select(suggestions[active >= 0 ? active : 0]);
        return;
      }
      // Enter without an open list: look the typed value up and take the first
      // match so the paired ID/name field fills immediately.
      const query = value.trim();
      if (query.length >= 2) {
        event.preventDefault();
        void load(query).then((list) => {
          if (list[0]) select(list[0]);
        });
      }
    }
  }

  const listId = `${id}-suggestions`;

  return (
    <div className={showIcon ? 'cash-lookup cash-lookup--icon' : 'cash-lookup'} ref={wrapperRef}>
      <label htmlFor={id} className={hideLabel ? 'sr-only' : 'cash-lookup__label'}>{label}</label>
      {showIcon ? <Search className="cash-lookup__icon" aria-hidden="true" /> : null}
      <input
        id={id}
        name={id}
        className={inputClassName}
        value={value}
        onChange={(event) => update(event.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => { if (suggestions.length) setOpen(true); }}
        onBlur={(event) => {
          if (!wrapperRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
        }}
        placeholder={placeholder}
        required={required}
        autoComplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
      />
      {open ? (
        <div className="cash-lookup__menu" id={listId} role="listbox" aria-label="Employee suggestions">
          <div className="cash-lookup__head" aria-hidden="true">
            <span>Name</span><span>Mobile / Employee ID</span>
          </div>
          {suggestions.map((employee, index) => (
            <button
              type="button"
              key={employee.employee_mobile}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              className="cash-lookup__option"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => select(employee)}
              onMouseEnter={() => setActive(index)}
            >
              <span className="cash-lookup__name">
                {employee.preferred_name}
                {employee.designation ? <small>{employee.designation}</small> : null}
              </span>
              <span className="cash-lookup__mobile">{displayMobile(employee.employee_mobile)}</span>
            </button>
          ))}
          {!suggestions.length ? (
            <div className="cash-lookup__empty">{loading ? 'Searching…' : 'No matching employee.'}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ── Dual-field (name + mobile) lookup used by the Attendance form ──────────
export type DualSuggestion = {mobile: string; name: string; designation: string | null};

function Highlight({text, query}: {text: string; query: string}) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const index = text.toLowerCase().indexOf(q.toLowerCase());
  if (index < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + q.length)}</mark>
      {text.slice(index + q.length)}
    </>
  );
}

/**
 * Two-field attendance lookup. Typing in either field searches the matching
 * column; selecting a row fills both fields and notifies the caller.
 */
export function EmployeeLookupDual({
  onEmployeeSelect, onChange, initialMobile = '', initialName = '', disabled = false,
  layout = 'vertical', inputClassName = '',
}: {
  onEmployeeSelect: (mobile: string, name: string) => void;
  onChange?: (mobile: string, name: string) => void;
  inputClassName?: string;
  initialMobile?: string;
  initialName?: string;
  disabled?: boolean;
  layout?: 'horizontal' | 'vertical';
}) {
  const [name, setName] = useState(initialName);
  const [mobile, setMobile] = useState(initialMobile);
  const [suggestions, setSuggestions] = useState<DualSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState('');
  const [field, setField] = useState<'name' | 'mobile'>('name');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  async function fetchSuggestions(nextField: 'name' | 'mobile', value: string): Promise<DualSuggestion[]> {
    try {
      const response = await fetch(`/api/employees/lookup?q=${encodeURIComponent(value)}&field=${nextField}`, {cache: 'no-store'});
      if (!response.ok) return [];
      const body = await response.json() as {rows?: DualSuggestion[]};
      return body.rows ?? [];
    } catch { return []; }
  }

  function search(nextField: 'name' | 'mobile', value: string) {
    setField(nextField);
    setQuery(value);
    if (timer.current) clearTimeout(timer.current);
    const minimum = nextField === 'name' ? 2 : 3;
    if (value.trim().length < minimum) { setSuggestions([]); setOpen(false); return; }
    timer.current = setTimeout(async () => {
      const items = await fetchSuggestions(nextField, value);
      setSuggestions(items);
      setOpen(Boolean(items.length));
      setActive(0);
    }, 300);
  }

  function choose(item: DualSuggestion) {
    setName(item.name);
    setMobile(item.mobile);
    setOpen(false);
    setSuggestions([]);
    onEmployeeSelect(item.mobile, item.name);
    onChange?.(item.mobile, item.name);
  }

  function keyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') { setOpen(false); return; }
    if (!open) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((index) => Math.min(index + 1, suggestions.length - 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((index) => Math.max(index - 1, 0)); }
    else if (event.key === 'Enter' && suggestions.length) {
      event.preventDefault();
      choose(suggestions[active] ?? suggestions[0]);
    }
  }

  /** Enter on a typed value with no open list: look up and take the first hit. */
  function enterToFill(event: React.KeyboardEvent, nextField: 'name' | 'mobile', value: string) {
    if (event.key !== 'Enter' || open) return;
    const minimum = nextField === 'name' ? 2 : 3;
    if (value.trim().length < minimum) return;
    event.preventDefault();
    void fetchSuggestions(nextField, value).then((items) => {
      if (items[0]) choose(items[0]);
    });
  }

  return (
    <div ref={root} style={{position: 'relative', display: 'grid', gridTemplateColumns: layout === 'horizontal' ? '1fr 1fr' : '1fr', gap: 8}}>
      <label className="text-sm" style={{position: 'relative'}}>
        Employee Name
        <input
          value={name} disabled={disabled} autoComplete="off"
          onChange={(event) => { const next = event.target.value; setName(next); onChange?.(mobile, next); search('name', next); }}
          onFocus={() => { if (suggestions.length) setOpen(true); }}
          onKeyDown={(event) => { enterToFill(event, 'name', name); keyDown(event); }}
          placeholder="Type 2+ characters"
          className={inputClassName}
          style={{width: '100%'}}
        />
      </label>
      <label className="text-sm" style={{position: 'relative'}}>
        Employee Mobile
        <input
          value={mobile} disabled={disabled} autoComplete="off" inputMode="tel"
          onChange={(event) => { const next = event.target.value; setMobile(next); onChange?.(next, name); search('mobile', next); }}
          onFocus={() => { if (suggestions.length) setOpen(true); }}
          onKeyDown={(event) => { enterToFill(event, 'mobile', mobile); keyDown(event); }}
          placeholder="Type 3+ digits"
          className={inputClassName}
          style={{width: '100%'}}
        />
      </label>
      {open && suggestions.length ? (
        <div style={{position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, background: '#fff', border: '1px solid #d1d5db', borderRadius: 6, boxShadow: '0 8px 24px rgba(15,23,42,.15)', maxHeight: 240, overflowY: 'auto', marginTop: 4}}>
          {suggestions.map((item, index) => (
            <button
              key={item.mobile} type="button"
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(item)}
              style={{display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', background: index === active ? '#dbeafe' : 'transparent', border: 0, cursor: 'pointer', fontSize: 13}}
            >
              {field === 'mobile'
                ? <><Highlight text={item.mobile} query={query} /> <span className="muted">({item.name})</span></>
                : <><Highlight text={item.name} query={query} /> <span className="muted">({item.mobile})</span></>}
              {item.designation ? <span className="pill" style={{marginLeft: 6, fontSize: 10}}>{item.designation}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

