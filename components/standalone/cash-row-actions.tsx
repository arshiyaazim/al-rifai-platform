'use client';

import Link from 'next/link';
import {useEffect, useRef, useState} from 'react';

type Props = {
  sourceMessageId: string | null;
  employeeMobile: string | null;
  employeeName: string;
  payoutMobile: string | null;
};

/**
 * Three-dot transaction menu containing only implemented, read-only actions.
 * Edit, Cancel, Delete and Save are intentionally absent: their backend
 * semantics and audit guarantees are not implemented for posted payments.
 */
export function CashRowActions({sourceMessageId, employeeMobile, employeeName, payoutMobile}: Props) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{top: number; left: number}>({top: 0, left: 0});
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  function toggle() {
    if (!open) {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) {
        setPosition({
          top: rect.bottom + 4,
          left: Math.max(8, Math.min(rect.right - 224, window.innerWidth - 232)),
        });
      }
    }
    setOpen((value) => !value);
  }

  useEffect(() => {
    if (!open) return;
    const first = menuRef.current?.querySelector<HTMLAnchorElement>('a');
    first?.focus();

    const onPointerDown = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)
        && !menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const close = () => setOpen(false);
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  const paymentQuery = new URLSearchParams();
  if (employeeName) paymentQuery.set('employeeName', employeeName);
  if (employeeMobile) paymentQuery.set('employeeMobile', employeeMobile);
  if (payoutMobile) paymentQuery.set('payoutMobile', payoutMobile);
  paymentQuery.set('openPayment', '1');
  const addHref = `/cash?${paymentQuery.toString()}#new-payment`;

  return (
    <div className="cash-row-actions" ref={wrapperRef}>
      <button
        ref={triggerRef}
        type="button"
        className="cash-row-actions__trigger"
        aria-label="Transaction actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open ? (
        <div
          className="cash-row-actions__menu"
          role="menu"
          ref={menuRef}
          aria-label="Transaction actions"
          style={{top: position.top, left: position.left}}
        >
          {sourceMessageId ? (
            <Link role="menuitem" href={`/messages?q=${encodeURIComponent(sourceMessageId)}`}>
              View source evidence
            </Link>
          ) : null}
          {employeeMobile ? (
            <Link role="menuitem" href={`/transactions/employee/${encodeURIComponent(employeeMobile)}`}>
              View employee transactions
            </Link>
          ) : null}
          <Link role="menuitem" href={addHref}>
            Add new transaction
          </Link>
        </div>
      ) : null}
    </div>
  );
}
