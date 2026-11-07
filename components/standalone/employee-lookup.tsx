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
