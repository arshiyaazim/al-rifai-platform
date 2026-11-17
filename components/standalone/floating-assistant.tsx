'use client';

import {displayMobile} from '@/lib/display-mobile';
import {ASSISTANT_DENIAL} from '@/lib/standalone/ai-assistant-prompt';
import {buildNavigation, isBlockedQuestion, isConfidentMatch, suppressesModelBubble} from '@/lib/standalone/ai-assistant-functions';
import {ASSISTANT_TEMPLATES} from '@/lib/standalone/ai-assistant-templates';
import {transliterate} from '@/lib/standalone/transliterate';
import {useEffect, useReducer, useRef, useState} from 'react';
import {usePathname, useRouter} from 'next/navigation';
import {
  isPanelVisible, reduceWindowState, type AssistantWindowAction, type AssistantWindowState,
} from '@/lib/standalone/ai-assistant-window-state';

/**
 * Floating, read-only assistant.
 *
 * The model never executes anything. The server returns a deterministic
 * `function_call`; this component runs it against the existing authenticated,
 * read-only APIs (employees, cash, attendance, vessel) and renders the result.
 * Navigation and sidebar actions wait for an explicit "হ্যাঁ"/"yes".
 */
type TableData = {columns: string[]; rows: string[][]};
type Chip = {label: string; value: string};
type ActionChip = {label: string; href: string};
type Message = {
  role: 'user' | 'assistant'; text: string; table?: TableData; more?: number; note?: string;
  suggestions?: string[]; actions?: ActionChip[]; chips?: Chip[];
};

type Pending =
  | {kind: 'navigate'; url: string; label: string}
  | {kind: 'sidebar'; page: string; action: string; mobile?: string};

type FunctionCall = {
  name: string;
  arguments?: Record<string, unknown>;
  requires_confirmation?: boolean;
  follow_up?: 'cash' | 'attendance' | 'vessel';
  range?: {from?: string; to?: string};
};

type LookupRow = {
  employee_mobile: string; preferred_name: string; designation: string | null;
  similarity_score: number | string; match_type: string;
};
type CashRow = {
  date?: string; eventAt?: string; createdAt?: string; amount?: string; amountMinor?: string;
  method?: string | null; state?: string;
};
type AttendanceRow = {
  attendance_date: string; shift: string; client_name: string | null; location: string | null;
};
type VesselRow = {
  mother_vessel: string; lighter_vessel: string; start_date: string; end_date: string | null; state: string;
};

const AFFIRM = /^(হ্যাঁ|হা|হ|yes|y|ok|okay|sure|যাও|করো|চলো|নে[য়া]?)/i;
const DENY = /^(না|ন|no|n|cancel|থাক|বাতিল)/i;
const MOBILE_MINIMISE_HINT = '💡 আমাকে মিনিমাইজ করলে আপনি ডাটাসমূহ দেখতে পাবেন।';

function bengali(value: number, digits = 0): string {
  return new Intl.NumberFormat('bn-BD', {minimumFractionDigits: digits, maximumFractionDigits: digits}).format(value);
}

function money(minor: number): string {
  return `৳${bengali(minor / 100, 2)}`;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const day = value.slice(0, 10);
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return new Intl.DateTimeFormat('en-GB', {day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC'}).format(date);
}

async function apiJson<T>(url: string): Promise<T | null> {
  const response = await fetch(url, {credentials: 'same-origin', cache: 'no-store'});
  if (!response.ok) return null;
  return response.json() as Promise<T>;
}

function slice<T>(rows: T[]): {rows: T[]; more: number} {
  return {rows: rows.slice(0, 5), more: Math.max(0, rows.length - 5)};
}

function badge(row: LookupRow): string {
  if (row.match_type === 'mobile_exact') return 'Exact';
  const score = Number(row.similarity_score);
  return `${score >= 0.95 ? '★' : '~'}${Math.round(score * 100)}%`;
}

async function csrfToken(): Promise<string> {
  const response = await fetch('/api/auth/session', {credentials: 'same-origin', cache: 'no-store'});
  const body = await response.json() as {csrf?: string};
  if (!body.csrf) throw new Error('SESSION_EXPIRED');
  return body.csrf;
}

const ERROR_TEXT: Record<string, string> = {
  ASSISTANT_DISABLED: 'The assistant has been turned off by the administrator.',
  RATE_LIMITED: 'Hourly limit reached. Please try again later.',
  SESSION_EXPIRED: 'Your session expired. Reload the page and sign in again.',
};

const MOBILE_HINT = 'আমাকে মিনিমাইজ করলে আপনি ডাটাসমূহ দেখতে পাবেন';

export function FloatingAssistant() {
  const pathname = usePathname();
  const router = useRouter();
  const [windowState, dispatchWindow] = useReducer(reduceWindowState, 'closed' as AssistantWindowState);
  const windowAction = (action: AssistantWindowAction) => dispatchWindow(action);
  const visible = isPanelVisible(windowState);
  const maximized = windowState === 'maximized';
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const launcherRef = useRef<HTMLButtonElement | null>(null);
  const wasVisible = useRef(false);
  const hintShown = useRef(false);
  const contextRef = useRef<string | null>(null);

  useEffect(() => {
    if (!visible || messages.length) return;
    setMessages([{
      role: 'assistant',
      text: 'আসসালামু আলাইকুম। আমি আল-রিফাঈ সহকারী। কর্মী খোঁজা, ক্যাশ/উপস্থিতি/ভেসেলের সারসংক্ষেপ বা পেইজে নিয়ে যাওয়া — কী করতে চান?',
    }]);
  }, [visible, messages.length]);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, busy, visible]);

  useEffect(() => {
    if (visible) {
      inputRef.current?.focus();
      wasVisible.current = true;
    } else if (wasVisible.current) {
      launcherRef.current?.focus();
      wasVisible.current = false;
    }
  }, [visible]);

  function closePanel() {
    windowAction('close');
    setMessages([]);
    setPending(null);
    setInput('');
  }

  function push(message: Message) {
    setMessages((current) => [...current, message]);
  }

  function runAction(action: Pending) {
    // Collapse the panel so the opened page/form is never left covered.
    windowAction('minimize');
    if (action.kind === 'navigate') {
      push({role: 'assistant', text: `ঠিক আছে — ${action.label} পেইজে নিয়ে যাচ্ছি। প্যানেলটি মিনিমাইজ করা হলো।`});
      router.push(action.url);
      mobileHint();
      return;
    }
    const payload = JSON.stringify({page: action.page, action: action.action, employee_mobile: action.mobile ?? null});
    try { sessionStorage.setItem('alrifai:open-sidebar', payload); } catch { /* private mode */ }
    window.dispatchEvent(new CustomEvent('alrifai:open-sidebar', {detail: {page: action.page, action: action.action, employee_mobile: action.mobile}}));
    push({role: 'assistant', text: `ঠিক আছে — ${action.page} ফর্ম খুলছি। প্যানেলটি মিনিমাইজ করা হলো।`});
    router.push(`/${action.page}`);
    mobileHint();
  }

  /** One mobile hint per session, only after a navigate/form-open. */
  function mobileHint() {
    if (hintShown.current) return;
    if (typeof window === 'undefined' || !window.matchMedia('(max-width: 520px)').matches) return;
    try {
      if (sessionStorage.getItem('alrifai:mobile-hint') === '1') return;
      sessionStorage.setItem('alrifai:mobile-hint', '1');
    } catch { /* private mode: still show once per mount */ }
    hintShown.current = true;
    push({role: 'assistant', text: MOBILE_MINIMISE_HINT});
  }

  async function summary(kind: 'cash' | 'attendance' | 'vessel', mobile: string, range?: {from?: string; to?: string}, name?: string) {
    const who = name || displayMobile(mobile);
    if (kind === 'cash') {
      const params = new URLSearchParams({employee_mobile: mobile, limit: '10000'});
      if (range?.from) params.set('from', range.from);
      if (range?.to) params.set('to', range.to);
      const body = await apiJson<{transactions?: CashRow[]; total?: number}>(`/api/cash/transactions?${params}`);
      const raw = body?.transactions ?? [];
      const list = raw.filter((row) => row.state !== 'REVERSED');
      if (!list.length) { push({role: 'assistant', text: `${who} এর কোনো ক্যাশ লেনদেন পাওয়া যায়নি।`}); return; }
      // `total` is the server count for the same filters. Never call the sum of
      // a partial page the employee's total.
      const truncated = typeof body?.total === 'number' && body.total > raw.length;
      const total = list.reduce((sum, row) => sum + Number(row.amountMinor ?? row.amount ?? 0), 0);
      const dates = list.map((row) => String(row.eventAt ?? row.date ?? row.createdAt ?? '').slice(0, 10)).filter(Boolean).sort();
      const shown = slice(list);
      const text = truncated
        ? `${who} এর দেখানো ${bengali(raw.length)} টি ট্রানজেকশনের পরিমাণ ${money(total)} — মোট ${bengali(body?.total ?? 0)} টি থাকায় এটি সর্বমোট নয়।`
        : `${who} মোট ${money(total)} পেয়েছেন (${bengali(list.length)} টি ট্রানজেকশন, ${formatDate(dates[0])} থেকে ${formatDate(dates[dates.length - 1])})।`;
      push({
        role: 'assistant',
        text,
        table: {
          columns: ['তারিখ', 'পরিমাণ', 'মাধ্যম', 'স্টেট'],
          rows: shown.rows.map((row) => [
            formatDate(row.eventAt ?? row.date ?? row.createdAt),
            money(Number(row.amountMinor ?? row.amount ?? 0)),
            String(row.method ?? '—'),
            String(row.state ?? '—'),
          ]),
        },
        more: shown.more,
        note: MOBILE_HINT,
      });
      return;
    }
    if (kind === 'attendance') {
      const params = new URLSearchParams({employee_mobile: mobile, limit: '10000'});
      if (range?.from) params.set('date_from', range.from);
      if (range?.to) params.set('date_to', range.to);
      const body = await apiJson<{rows?: AttendanceRow[]}>(`/api/attendance?${params}`);
      const list = body?.rows ?? [];
      if (!list.length) { push({role: 'assistant', text: `${who} এর কোনো উপস্থিতি পাওয়া যায়নি।`}); return; }
      const days = new Set(list.map((row) => row.attendance_date));
      const dates = [...days].sort();
      const shown = slice(list);
      const truncated = list.length >= 10000;
      push({
        role: 'assistant',
        text: truncated
          ? `${who} এর সর্বশেষ ${bengali(list.length)} টি উপস্থিতি রেকর্ড দেখানো হচ্ছে — মোট দিন নিশ্চিত নই।`
          : `${who} ${bengali(days.size)} দিন উপস্থিত (${formatDate(dates[0])} থেকে ${formatDate(dates[dates.length - 1])})।`,
        table: {
          columns: ['তারিখ', 'শিফট', 'ক্লায়েন্ট'],
          rows: shown.rows.map((row) => [formatDate(row.attendance_date), row.shift, row.client_name ?? row.location ?? '—']),
        },
        more: shown.more,
        note: MOBILE_HINT,
      });
      return;
    }
    const params = new URLSearchParams({limit: '10000'});
    params.set('escort_mobile', mobile);
    if (range?.from) params.set('from', range.from);
    if (range?.to) params.set('to', range.to);
    const body = await apiJson<{rows?: VesselRow[]; total?: number}>(`/api/vessel?${params}`);
    const list = body?.rows ?? [];
    if (!list.length) { push({role: 'assistant', text: `${who} এর কোনো ভেসেল প্রোগ্রাম পাওয়া যায়নি।`}); return; }
    const shown = slice(list);
    const truncated = typeof body?.total === 'number' && body.total > list.length;
    push({
      role: 'assistant',
      text: truncated
        ? `${who} এর ${bengali(list.length)} টি প্রোগ্রাম দেখানো হচ্ছে (মোট ${bengali(body?.total ?? 0)}) — এটি সম্পূর্ণ তালিকা নয়।`
        : `${who} এর ${bengali(list.length)} টি ভেসেল প্রোগ্রাম আছে।`,
      table: {
        columns: ['মাদার ভেসেল', 'লাইটার', 'শুরু', 'শেষ', 'স্টেট'],
        rows: shown.rows.map((row) => [row.mother_vessel, row.lighter_vessel, formatDate(row.start_date), formatDate(row.end_date), row.state]),
      },
      more: shown.more,
      note: MOBILE_HINT,
    });
  }

  async function execute(call: FunctionCall, suggestions?: string[]) {
    const args = call.arguments ?? {};
    const str = (key: string) => (typeof args[key] === 'string' ? String(args[key]) : undefined);
    try {
      if (call.name === 'searchEmployee') {
        const query = str('query') ?? '';
        if (!query) return;
        const rows = await apiJson<LookupRow[]>(`/api/employees/search?expand=1&q=${encodeURIComponent(query)}`);
        const list = Array.isArray(rows) ? rows : [];
        if (!list.length) {
          push({role: 'assistant', text: `"${query}" এর জন্য কোনো কর্মী পাওয়া যায়নি।`});
          return;
        }
        const shown = slice(list);
        push({
          role: 'assistant',
          text: `${bengali(list.length)} জন কর্মী পাওয়া গেছে।`,
          table: {
            columns: ['নাম', 'মোবাইল', 'মিল'],
            rows: shown.rows.map((row) => [row.preferred_name, displayMobile(row.employee_mobile), badge(row)]),
          },
          more: shown.more,
          note: MOBILE_HINT,
        });
        const top = list[0];
        if (call.follow_up && isConfidentMatch(top, list.length)) {
          await summary(call.follow_up, top.employee_mobile, call.range, top.preferred_name);
        } else if (call.follow_up) {
          push({role: 'assistant', text: 'একাধিক কর্মী মিলেছে — কোনজনের হিসাব দেখাব? মোবাইল নম্বরটি বলুন।'});
        }
        return;
      }
      if (call.name === 'fetchCashSummary' || call.name === 'fetchAttendanceSummary' || call.name === 'fetchVesselSummary') {
        const mobile = str('employee_mobile');
        const kind = call.name === 'fetchCashSummary' ? 'cash'
          : call.name === 'fetchAttendanceSummary' ? 'attendance' : 'vessel';
        if (kind === 'vessel' && !mobile) { push({role: 'assistant', text: 'কোন কর্মীর নাম বা মোবাইল বললে ভেসেল প্রোগ্রাম দেখাতে পারি।'}); return; }
        if (!mobile) { push({role: 'assistant', text: 'কর্মীর মোবাইল নম্বরটি বলুন।'}); return; }
        const range = {
          from: call.range?.from ?? str('from'),
          to: call.range?.to ?? str('to'),
        };
        await summary(kind, mobile, range);
        return;
      }
      if (call.name === 'navigateToPage') {
        const page = str('page') ?? '';
        const filters = (args.filters ?? {}) as Record<string, string>;
        // The vessel page searches stored Latin escort/vessel names; a Bangla
        // query must be transliterated before it becomes a URL filter.
        if (page === 'vessel' && filters.q) filters.q = transliterate(filters.q);
        const nav = buildNavigation(page, filters);
        if (!nav) { push({role: 'assistant', text: 'এই পেইজটি এখনো সমর্থিত নয়।'}); return; }
        const label = page === 'cash' ? 'ক্যাশ' : page === 'cash/transactions' ? 'ক্যাশ লেনদেন'
          : page === 'vessel' ? 'ভেসেল' : page === 'attendance' ? 'উপস্থিতি' : 'কর্মী';
        setPending({kind: 'navigate', url: nav.url, label});
        push({
          role: 'assistant',
          text: `আপনাকে কি ${label} পেইজে নিয়ে যাব?${nav.description !== label ? ` (${nav.description})` : ''}`,
          chips: [{label: 'হ্যাঁ', value: 'হ্যাঁ'}, {label: 'না', value: 'না'}],
          suggestions,
        });
        return;
      }
      if (call.name === 'openSidebar') {
        const page = str('page') ?? 'employees';
        const action = str('action') ?? 'add';
        const mobile = str('employee_mobile');
        setPending({kind: 'sidebar', page, action, mobile});
        push({
          role: 'assistant',
          text: action === 'add' ? 'নতুন কর্মী যোগ করার ফর্ম খুলব?' : 'কর্মীর বিবরণ খুলব?',
          chips: [{label: 'হ্যাঁ', value: 'হ্যাঁ'}, {label: 'না', value: 'না'}],
          suggestions,
        });
        return;
      }
      if (call.name === 'isBlockedQuestion') {
        push({role: 'assistant', text: ASSISTANT_DENIAL});
      }
    } catch {
      push({role: 'assistant', text: 'ডেটা আনতে সমস্যা হয়েছে। আবার চেষ্টা করুন।'});
    }
  }

  async function ask(text: string) {
    try {
      const token = await csrfToken();
      const response = await fetch('/api/assistant/chat', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': token},
        body: JSON.stringify({message: text, page: pathname, context: contextRef.current ?? undefined}),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) {
        const code = String(body.error ?? `HTTP_${response.status}`);
        throw new Error(ERROR_TEXT[code] ?? code);
      }
      contextRef.current = typeof body.context === 'string' ? body.context : null;
      const call = body.function_call as FunctionCall | undefined;
      const suggestions = Array.isArray(body.suggestions)
        ? (body.suggestions as unknown[]).slice(0, 4).map(String) : undefined;
      const actions = Array.isArray(body.actions) ? (body.actions as ActionChip[]) : undefined;
      // A navigate/form confirmation is rendered once by execute() with হ্যাঁ/না
      // chips — the model's own confirmation sentence is suppressed here.
      if (!suppressesModelBubble(call)) {
        const chips = Array.isArray(body.chips)
          ? (body.chips as Array<{label?: unknown; value?: unknown}>)
            .filter((chip) => chip && typeof chip.label === 'string' && typeof chip.value === 'string')
            .map((chip) => ({label: String(chip.label), value: String(chip.value)}))
          : undefined;
        push({role: 'assistant', text: String(body.answer ?? ''), suggestions, actions, chips});
      }
      if (call) await execute(call, suggestions);
    } catch (cause) {
      const message = cause instanceof Error ? ERROR_TEXT[cause.message] ?? cause.message : 'Something went wrong.';
      push({role: 'assistant', text: `Sorry — ${message}`});
    }
  }

  async function send(question: string) {
    const text = question.trim();
    if (!text || busy) return;
    push({role: 'user', text});
    setInput('');
    setBusy(true);
    try {
      if (pending) {
        const action = pending;
        if (AFFIRM.test(text)) {
          setPending(null);
          runAction(action);
          return;
        }
        if (DENY.test(text)) {
          setPending(null);
          push({role: 'assistant', text: 'ঠিক আছে, বাতিল করা হলো।'});
          return;
        }
        setPending(null);
      }
      if (isBlockedQuestion(text)) {
        push({role: 'assistant', text: ASSISTANT_DENIAL});
        return;
      }
      await ask(text);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <style>{`
        @keyframes alrifai-pulse {0%{box-shadow:0 0 0 0 rgba(249,115,22,.45)}70%{box-shadow:0 0 0 14px rgba(249,115,22,0)}100%{box-shadow:0 0 0 0 rgba(249,115,22,0)}}
        @keyframes alrifai-blink {0%,80%,100%{opacity:.25}40%{opacity:1}}
        .alrifai-fab{animation:alrifai-pulse 2.6s infinite}
        .alrifai-fab:hover{transform:translateY(-2px)}
        .alrifai-dot{animation:alrifai-blink 1.2s infinite}
        .alrifai-table{width:100%;border-collapse:collapse;margin-top:6px;font-size:11px}
        .alrifai-table th,.alrifai-table td{border-bottom:1px solid var(--line,#e2e8f0);padding:3px 4px;text-align:left}
        .alrifai-mobile-note{display:none}
        .alrifai-panel{transition:width .18s ease,height .18s ease,inset .18s ease}
        .alrifai-ctrl{border:1px solid var(--line,#e2e8f0);background:transparent;color:inherit;border-radius:8px;width:28px;height:28px;cursor:pointer;display:grid;place-items:center;font-size:15px;line-height:1}
        .alrifai-ctrl:focus-visible,.alrifai-fab:focus-visible,.alrifai-input:focus-visible{outline:2px solid var(--accent,#0f766e);outline-offset:2px}
        @media (max-width: 520px){
          .alrifai-panel:not(.alrifai-max){left:calc(8px + env(safe-area-inset-left)) !important;right:calc(8px + env(safe-area-inset-right)) !important;bottom:calc(8px + env(safe-area-inset-bottom)) !important;width:auto !important;height:min(76dvh,560px) !important}
          .alrifai-label{display:none !important}
          .alrifai-mobile-note{display:block;font-size:10px;margin-top:4px}
          .alrifai-ctrl{width:36px;height:36px;font-size:17px}
          .alrifai-input{font-size:16px !important}
        }
        @media (prefers-reduced-motion: reduce){
          .alrifai-fab,.alrifai-dot{animation:none !important}
          .alrifai-panel{transition:none !important}
        }
      `}</style>

      {visible ? (
        <section
          role="dialog"
          aria-label="Al-Rifa'i assistant"
          aria-modal={maximized ? true : undefined}
          className={maximized ? 'alrifai-panel alrifai-max' : 'alrifai-panel'}
          onKeyDown={(event) => { if (event.key === 'Escape') windowAction('minimize'); }}
          style={maximized ? {
            position: 'fixed', zIndex: 80,
            top: 'calc(12px + env(safe-area-inset-top))', right: 'calc(12px + env(safe-area-inset-right))',
            bottom: 'calc(12px + env(safe-area-inset-bottom))', left: 'calc(12px + env(safe-area-inset-left))',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
            background: 'var(--panel, #ffffff)', color: 'var(--ink, #0f172a)',
            border: '1px solid var(--line, #e2e8f0)', borderRadius: 16,
            boxShadow: '0 24px 48px rgba(15, 23, 42, .22)',
          } : {
            position: 'fixed', zIndex: 80,
            right: 'calc(16px + env(safe-area-inset-right))', bottom: 'calc(16px + env(safe-area-inset-bottom))',
            width: 'min(380px, calc(100vw - 24px))', height: 'min(560px, calc(100dvh - 110px))',
            maxWidth: 'calc(100vw - 24px)', maxHeight: 'calc(100dvh - 24px)',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
            background: 'var(--panel, #ffffff)', color: 'var(--ink, #0f172a)',
            border: '1px solid var(--line, #e2e8f0)', borderRadius: 16,
            boxShadow: '0 24px 48px rgba(15, 23, 42, .22)',
          }}
        >
          <header style={{display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderBottom: '1px solid var(--line, #e2e8f0)'}}>
            <div style={{flex: 1, minWidth: 0, fontWeight: 600, fontSize: 13}}>Help: Al-Rifa&apos;I</div>
            <div className="alrifai-controls" style={{display: 'flex', gap: 4, flexShrink: 0}}>
              <button type="button" className="alrifai-ctrl" onClick={() => windowAction('minimize')}
                aria-label="Minimize assistant" title="Minimize (—)">—</button>
              <button type="button" className="alrifai-ctrl" aria-pressed={maximized}
                onClick={() => windowAction('toggleMaximize')}
                aria-label={maximized ? 'Restore assistant size' : 'Maximize assistant'} title={maximized ? 'Restore (□)' : 'Maximize (□)'}>
                {maximized ? '❐' : '□'}
              </button>
              <button type="button" className="alrifai-ctrl" onClick={closePanel}
                aria-label="Close assistant" title="Close (×)">×</button>
            </div>
          </header>

          <div ref={listRef} style={{flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch', padding: 12, display: 'flex', flexDirection: 'column', gap: 8}}>
            {messages.map((message, index) => (
              <div key={index} style={{display: 'flex', justifyContent: message.role === 'user' ? 'flex-end' : 'flex-start'}}>
                <div style={{
                  maxWidth: '92%', padding: '8px 10px', borderRadius: 12, fontSize: 13, lineHeight: 1.45,
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  background: message.role === 'user' ? 'var(--accent, #0f766e)' : 'var(--dash-soft, #f1f5f9)',
                  color: message.role === 'user' ? '#fff' : 'inherit',
                  borderBottomRightRadius: message.role === 'user' ? 4 : 12,
                  borderBottomLeftRadius: message.role === 'user' ? 12 : 4,
                }}>
                  {message.text}
                  {message.table ? (
                    <>
                      <table className="alrifai-table">
                        <thead><tr>{message.table.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
                        <tbody>
                          {message.table.rows.map((row, rowIndex) => (
                            <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>
                          ))}
                        </tbody>
                      </table>
                      {message.more ? <div className="muted" style={{fontSize: 10, marginTop: 2}}>আরও {bengali(message.more)} টি আছে</div> : null}
                    </>
                  ) : null}
                  {message.note ? <div className="alrifai-mobile-note muted">{message.note}</div> : null}
                  {message.chips?.length || message.actions?.length || message.suggestions?.length ? (
                    <div style={{display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8}}>
                      {message.chips?.map((chip) => (
                        <button key={chip.label} type="button" onClick={() => void send(chip.value)} disabled={busy}
                          style={{fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 999, border: '1px solid var(--accent, #0f766e)', background: 'transparent', color: 'inherit', cursor: 'pointer'}}>
                          {chip.label}
                        </button>
                      ))}
                      {message.actions?.map((action) => (
                        <button key={action.label} type="button" disabled={busy}
                          onClick={() => runAction({kind: 'navigate', url: action.href, label: action.label})}
                          style={{fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 999, border: '1px solid var(--line, #e2e8f0)', background: 'transparent', color: 'inherit', cursor: 'pointer'}}>
                          {action.label}
                        </button>
                      ))}
                      {message.suggestions?.map((suggestion) => (
                        <button key={suggestion} type="button" onClick={() => void send(suggestion)} disabled={busy}
                          style={{fontSize: 11, padding: '4px 10px', borderRadius: 999, border: '1px solid var(--line, #e2e8f0)', background: 'transparent', color: 'inherit', cursor: 'pointer'}}>
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
            {busy ? (
              <div style={{display: 'flex', gap: 4, padding: '8px 10px', width: 54, borderRadius: 12, background: 'var(--dash-soft, #f1f5f9)'}} aria-label="Assistant is typing">
                {[0, 1, 2].map((dot) => (
                  <span key={dot} className="alrifai-dot" style={{width: 6, height: 6, borderRadius: 3, background: 'var(--muted, #64748b)', animationDelay: `${dot * 0.16}s`}} />
                ))}
              </div>
            ) : null}
            {!messages.length || messages.length === 1 ? (
              <div style={{display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6}}>
                {ASSISTANT_TEMPLATES.map((template) => (
                  <button key={template.id} type="button" onClick={() => void send(template.label)} disabled={busy}
                    style={{textAlign: 'left', fontSize: 12, padding: '8px 10px', borderRadius: 9, border: '1px solid var(--line, #e2e8f0)', background: 'transparent', color: 'inherit', cursor: 'pointer'}}>
                    {template.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <form onSubmit={(event) => { event.preventDefault(); void send(input); }}
            style={{display: 'flex', gap: 8, padding: 10, borderTop: '1px solid var(--line, #e2e8f0)'}}>
            <input ref={inputRef} value={input} onChange={(event) => setInput(event.target.value)} maxLength={500}
              className="alrifai-input"
              placeholder="কর্মী, ক্যাশ বা পেইজ সম্পর্কে জিজ্ঞাসা করুন…" aria-label="Your question"
              style={{flex: 1, minWidth: 0, padding: '8px 10px', borderRadius: 10, border: '1px solid var(--line, #e2e8f0)', background: 'transparent', color: 'inherit', fontSize: 13}} />
            <button type="submit" disabled={busy || !input.trim()}
              style={{padding: '8px 12px', borderRadius: 10, border: 0, background: 'var(--accent, #0f766e)', color: '#fff', fontWeight: 600, cursor: busy || !input.trim() ? 'default' : 'pointer', opacity: busy || !input.trim() ? 0.6 : 1}}>
              Send
            </button>
          </form>
        </section>
      ) : (
        <div style={{
          position: 'fixed', right: 'calc(16px + env(safe-area-inset-right))',
          bottom: 'calc(16px + env(safe-area-inset-bottom))', zIndex: 80,
          display: 'flex', alignItems: 'center', gap: 8, maxWidth: 'calc(100vw - 24px)',
        }}>
          <button ref={launcherRef} type="button" className="alrifai-fab" onClick={() => windowAction('open')}
            aria-label="Open Al-Rifa'i assistant" aria-expanded={false} title="Open assistant"
            style={{
              padding: '10px 20px', borderRadius: 999, border: 0, cursor: 'pointer', flexShrink: 0,
              background: '#F97316', color: '#fff', fontWeight: 700, fontSize: 14,
              letterSpacing: '.02em', transition: 'transform .15s ease',
              boxShadow: '0 8px 24px rgba(249, 115, 22, .35)',
            }}>Ask</button>
        </div>
      )}
    </>
  );
}
