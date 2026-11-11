'use client';

import {useEffect, useRef, useState} from 'react';

export type RowAction = {label: string; onClick: () => void; danger?: boolean};

/** Compact ⋮ menu rendered in a fixed layer so table overflow cannot clip it. */
export function RowActionsMenu({items, label = 'Actions'}: {items: RowAction[]; label?: string}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{top: number; left: number}>({top: 0, left: 0});
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  function show() {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({top: rect.bottom + 4, left: Math.max(8, rect.right - 180)});
    setOpen(true);
    setActive(0);
  }

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (menu.current && !menu.current.contains(event.target as Node)
        && trigger.current && !trigger.current.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); }
      if (event.key === 'ArrowDown') { event.preventDefault(); setActive((i) => Math.min(i + 1, items.length - 1)); }
      if (event.key === 'ArrowUp') { event.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
      if (event.key === 'Enter' && open) { event.preventDefault(); items[active]?.onClick(); setOpen(false); }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key); };
  }, [open, active, items]);

  return (
    <>
      <button ref={trigger} type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open}
        onClick={() => (open ? setOpen(false) : show())}
        style={{border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', cursor: 'pointer', padding: '2px 7px', lineHeight: 1.2, fontSize: 15}}>
        ⋮
      </button>
      {open ? (
        <div ref={menu} role="menu" aria-label={label}
          style={{position: 'fixed', top: position.top, left: position.left, zIndex: 80, width: 180, background: '#fff', border: '1px solid #d1d5db', borderRadius: 8, boxShadow: '0 10px 28px rgba(15,23,42,.18)', padding: 4}}>
          {items.map((item, index) => (
            <button key={item.label} type="button" role="menuitem"
              onMouseEnter={() => setActive(index)}
              onClick={() => { setOpen(false); item.onClick(); }}
              style={{display: 'block', width: '100%', textAlign: 'left', border: 0, borderRadius: 5,
                padding: '7px 10px', cursor: 'pointer', fontSize: 13, background: index === active ? '#eff6ff' : 'transparent',
                color: item.danger ? '#b91c1c' : '#111827'}}>
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}
