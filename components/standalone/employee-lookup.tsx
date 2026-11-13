'use client';

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
};

/**
 * Backend-driven employee lookup. The server caps every response at ten
 * suggestions; this component only projects those results and never invents an
 * identifier. The verified identifier is `employees.employee_mobile`.
 */
export function EmployeeLookup({id, label, placeholder, value, onChange, onSelect, required}: Props) {
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

  async function load(query: string) {
    const ticket = ++request.current;
    setLoading(true);
    try {
      const response = await fetch(
        `/api/employees?lookup=1&q=${encodeURIComponent(query)}`,
        {credentials: 'same-origin', cache: 'no-store'},
      );
      if (!response.ok) {
        if (ticket === request.current) setSuggestions([]);
        return;
      }
      const body = (await response.json()) as {suggestions?: EmployeeSuggestion[]};
      if (ticket !== request.current) return;
      setSuggestions((body.suggestions ?? []).slice(0, 10));
      setOpen(true);
      setActive(-1);
    } catch {
      if (ticket === request.current) setSuggestions([]);
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
    if (event.key === 'Enter' && open && active >= 0 && suggestions[active]) {
      event.preventDefault();
      select(suggestions[active]);
    }
  }

  const listId = `${id}-suggestions`;

  return (
    <div className="cash-lookup" ref={wrapperRef}>
      <label htmlFor={id} className="cash-lookup__label">{label}</label>
      <input
        id={id}
        name={id}
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
              <span className="cash-lookup__mobile">{employee.employee_mobile}</span>
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
  onEmployeeSelect, initialMobile = '', initialName = '', disabled = false, layout = 'vertical',
}: {
  onEmployeeSelect: (mobile: string, name: string) => void;
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

  function search(nextField: 'name' | 'mobile', value: string) {
    setField(nextField);
    setQuery(value);
    if (timer.current) clearTimeout(timer.current);
    const minimum = nextField === 'name' ? 2 : 3;
    if (value.trim().length < minimum) { setSuggestions([]); setOpen(false); return; }
    timer.current = setTimeout(async () => {
      try {
        const response = await fetch(`/api/employees/lookup?q=${encodeURIComponent(value)}&field=${nextField}`, {cache: 'no-store'});
        if (!response.ok) return;
        const body = await response.json() as {rows?: DualSuggestion[]};
        setSuggestions(body.rows ?? []);
        setOpen(Boolean(body.rows?.length));
        setActive(0);
      } catch { /* keep the field usable when lookup is offline */ }
    }, 300);
  }

  function choose(item: DualSuggestion) {
    setName(item.name);
    setMobile(item.mobile);
    setOpen(false);
    setSuggestions([]);
    onEmployeeSelect(item.mobile, item.name);
  }

  function keyDown(event: React.KeyboardEvent) {
    if (!open) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((index) => Math.min(index + 1, suggestions.length - 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((index) => Math.max(index - 1, 0)); }
    else if (event.key === 'Enter' && suggestions[active]) { event.preventDefault(); choose(suggestions[active]); }
    else if (event.key === 'Escape') setOpen(false);
  }

  return (
    <div ref={root} style={{position: 'relative', display: 'grid', gridTemplateColumns: layout === 'horizontal' ? '1fr 1fr' : '1fr', gap: 8}}>
      <label className="text-sm" style={{position: 'relative'}}>
        Employee Name
        <input
          value={name} disabled={disabled} autoComplete="off"
          onChange={(event) => { setName(event.target.value); search('name', event.target.value); }}
          onFocus={() => { if (suggestions.length) setOpen(true); }}
          onKeyDown={keyDown}
          placeholder="Type 2+ characters"
          style={{width: '100%'}}
        />
      </label>
      <label className="text-sm" style={{position: 'relative'}}>
        Employee Mobile
        <input
          value={mobile} disabled={disabled} autoComplete="off" inputMode="tel"
          onChange={(event) => { setMobile(event.target.value); search('mobile', event.target.value); }}
          onFocus={() => { if (suggestions.length) setOpen(true); }}
          onKeyDown={keyDown}
          placeholder="Type 3+ digits"
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

