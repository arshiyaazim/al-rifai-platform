import Link from 'next/link';
import type {ReactNode} from 'react';
import {
  Anchor, Banknote, CalendarCheck, CalendarClock, CalendarDays, ClipboardList, FileWarning,
  Ship, TriangleAlert, UserPlus, Users, Wallet, type LucideIcon,
} from 'lucide-react';
import {pageUser} from '@/lib/standalone/session';
import {reviewQueueCounts} from '@/lib/standalone/review';
import {
  dashboardCounts, dashboardEmployeeRows, dashboardPeriodBounds, dashboardToday,
  type DashboardCounts, type DashboardDomain, type DashboardPeriod,
} from '@/lib/standalone/dashboard';
import {unifiedAttendance} from '@/lib/standalone/attendance-records';
import {cashTransactionView, countCashTransactions, listCashTransactions} from '@/lib/standalone/finance';
import {countPrograms, listPrograms} from '@/lib/standalone/programs';
import {RealtimeRefresher} from '@/components/standalone/realtime-refresher';
import {HomeEmployeeSearch} from '@/components/standalone/home-employee-search';
import {
  DashboardAttendanceTable, DashboardCashTable, DashboardEmployeesTable,
  DashboardPagination, DashboardVesselTable, type DashboardAttendanceRow,
} from '@/components/standalone/dashboard-domain-table';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{domain?: string; period?: string; page?: string}>;

type CardDef = {
  domain: DashboardDomain;
  period: DashboardPeriod;
  label: string;
  countKey: keyof DashboardCounts;
  icon: LucideIcon;
};

const CARD_ROWS: Array<{label: string; cards: CardDef[]}> = [
  {
    label: 'All Time',
    cards: [
      {domain: 'employees', period: 'total', label: 'Total Employees', countKey: 'employeesTotal', icon: Users},
      {domain: 'attendance', period: 'total', label: 'Total Attendance', countKey: 'attendanceTotal', icon: CalendarCheck},
      {domain: 'cash', period: 'total', label: 'Total Payments', countKey: 'paymentsTotal', icon: Wallet},
      {domain: 'vessel', period: 'total', label: 'Total Vessels', countKey: 'vesselsTotal', icon: Ship},
    ],
  },
  {
    label: 'Last Month',
    cards: [
      {domain: 'employees', period: 'last_month', label: 'New Employees', countKey: 'employeesLastMonth', icon: UserPlus},
      {domain: 'attendance', period: 'last_month', label: 'Attendance', countKey: 'attendanceLastMonth', icon: CalendarDays},
      {domain: 'cash', period: 'last_month', label: 'Payments', countKey: 'paymentsLastMonth', icon: Banknote},
      {domain: 'vessel', period: 'last_month', label: 'Vessels', countKey: 'vesselsLastMonth', icon: Anchor},
    ],
  },
  {
    label: 'This Month',
    cards: [
      {domain: 'employees', period: 'this_month', label: 'New Employees', countKey: 'employeesThisMonth', icon: UserPlus},
      {domain: 'attendance', period: 'this_month', label: 'Attendance', countKey: 'attendanceThisMonth', icon: CalendarDays},
      {domain: 'cash', period: 'this_month', label: 'Payments', countKey: 'paymentsThisMonth', icon: Wallet},
      {domain: 'vessel', period: 'this_month', label: 'Vessels', countKey: 'vesselsThisMonth', icon: Ship},
    ],
  },
  {
    label: 'Yesterday',
    cards: [
      {domain: 'employees', period: 'yesterday', label: 'New Employees', countKey: 'employeesYesterday', icon: UserPlus},
      {domain: 'attendance', period: 'yesterday', label: 'Attendance', countKey: 'attendanceYesterday', icon: CalendarClock},
      {domain: 'cash', period: 'yesterday', label: 'Payments', countKey: 'paymentsYesterday', icon: Wallet},
      {domain: 'vessel', period: 'yesterday', label: 'Vessels', countKey: 'vesselsYesterday', icon: Ship},
    ],
  },
  {
    label: 'Today',
    cards: [
      {domain: 'employees', period: 'today', label: 'New Employees', countKey: 'employeesToday', icon: UserPlus},
      {domain: 'attendance', period: 'today', label: 'Attendance', countKey: 'attendanceToday', icon: CalendarCheck},
      {domain: 'cash', period: 'today', label: 'Payments', countKey: 'paymentsToday', icon: Wallet},
      {domain: 'vessel', period: 'today', label: 'Vessels', countKey: 'vesselsToday', icon: Ship},
    ],
  },
];

const DOMAIN_LABELS: Record<DashboardDomain, string> = {
  employees: 'Employees',
  attendance: 'Attendance',
  cash: 'Payments',
  vessel: 'Vessels',
};

const DOMAIN_HREFS: Record<DashboardDomain, string> = {
  employees: '/employees',
  attendance: '/attendance',
  cash: '/cash',
  vessel: '/vessel',
};

const QUICK_ACTIONS = [
  {href: '/employees', label: 'Add Employee', icon: UserPlus},
  {href: '/vessel', label: 'New Vessel', icon: Ship},
  {href: '/cash', label: 'Record Cash', icon: Wallet},
  {href: '/review', label: 'Review Queue', icon: ClipboardList},
];

const ADMIN_REVIEW_CARDS = [
  {category: 'AMBIGUOUS_VESSEL_CONFIRMATION', label: 'Ambiguous Vessel', icon: TriangleAlert},
  {category: 'EXTRACTION_FAILED', label: 'Extraction Failed', icon: FileWarning},
  {category: 'INCOMPLETE_VESSEL_ORDER', label: 'Incomplete Order', icon: ClipboardList},
  {category: 'PROCESSING_ERROR', label: 'Processing Error', icon: TriangleAlert},
  {category: 'UNMATCHED_VESSEL_ASSIGNMENT', label: 'Unmatched Vessel', icon: FileWarning},
];

const DOMAINS: DashboardDomain[] = ['employees', 'attendance', 'cash', 'vessel'];
const PERIODS: DashboardPeriod[] = ['total', 'last_month', 'this_month', 'yesterday', 'today'];

function pickDomain(value: string | undefined): DashboardDomain {
  return DOMAINS.includes(value as DashboardDomain) ? value as DashboardDomain : 'employees';
}

function pickPeriod(value: string | undefined): DashboardPeriod {
  return PERIODS.includes(value as DashboardPeriod) ? value as DashboardPeriod : 'total';
}

export default async function HomePage({searchParams}: {searchParams: SearchParams}) {
  const search = await searchParams;
  const user = await pageUser();
  const selectedDomain = pickDomain(search.domain);
  const selectedPeriod = pickPeriod(search.period);
  const requestedPage = Math.max(1, Number(search.page) || 1);
  const limit = 20;
  const bounds = dashboardPeriodBounds(selectedPeriod);

  const [counts, reviewCounts] = await Promise.all([
    dashboardCounts(),
    user.role === 'ADMIN' ? reviewQueueCounts() : Promise.resolve(null),
  ]);

  let table: ReactNode = null;
  let total = 0;
  let page = requestedPage;

  if (selectedDomain === 'employees') {
    const all = await dashboardEmployeeRows(bounds.from, bounds.to);
    total = all.length;
    page = Math.min(requestedPage, Math.max(1, Math.ceil(total / limit)));
    table = <DashboardEmployeesTable rows={all.slice((page - 1) * limit, page * limit)} />;
  } else if (selectedDomain === 'attendance') {
    const data = await unifiedAttendance({
      from: bounds.from ?? '2000-01-01',
      to: bounds.to ?? dashboardToday(),
    });
    total = data.rows.length;
    page = Math.min(requestedPage, Math.max(1, Math.ceil(total / limit)));
    table = <DashboardAttendanceTable rows={data.rows as DashboardAttendanceRow[]} />;
  } else if (selectedDomain === 'cash') {
    total = await countCashTransactions({from: bounds.from, to: bounds.to});
    page = Math.min(requestedPage, Math.max(1, Math.ceil(total / limit)));
    const rows = await listCashTransactions({
      from: bounds.from, to: bounds.to, limit, offset: (page - 1) * limit,
    });
    table = <DashboardCashTable rows={rows.map(cashTransactionView)} />;
  } else {
    total = await countPrograms({from: bounds.from, to: bounds.to});
    page = Math.min(requestedPage, Math.max(1, Math.ceil(total / limit)));
    const rows = await listPrograms({
      from: bounds.from, to: bounds.to, limit, offset: (page - 1) * limit,
    });
    table = <DashboardVesselTable rows={rows} />;
  }

  return (
    <>
      <div className="page-head">
        <div><h1>Home</h1></div>
        <RealtimeRefresher domain="ANY" label="Live dashboard" />
      </div>

      <div className="dashboard-card-rows">
        {CARD_ROWS.map((row) => (
          <div key={row.label} className="dashboard-card-row">
            <div className="dashboard-period-label">{row.label}</div>
            <div className="dashboard-cards-grid">
              {row.cards.map((card) => {
                const Icon = card.icon;
                const selected = selectedDomain === card.domain && selectedPeriod === card.period;
                return (
                  <Link
                    key={`${card.domain}-${card.period}`}
                    href={`/home?domain=${card.domain}&period=${card.period}&page=1`}
                    className={`dashboard-card dashboard-card--${card.domain}${selected ? ' is-selected' : ''}`}
                    aria-current={selected ? 'page' : undefined}
                  >
                    <span className="dashboard-card__icon"><Icon size={22} aria-hidden /></span>
                    <span className="dashboard-card__value">{counts[card.countKey].toLocaleString()}</span>
                    <span className="dashboard-card__label">{card.label}</span>
                  </Link>
                );
              })}
            </div>
            {row.label === 'All Time' ? <HomeEmployeeSearch /> : null}
          </div>
        ))}
      </div>

      <section className="card dashboard-table-card" style={{marginBottom: 18}}>
        <div className="page-head" style={{marginBottom: 8}}>
          <div>
            <h3 style={{margin: 0}}>{DOMAIN_LABELS[selectedDomain]} — {bounds.label}</h3>
            <p className="muted" style={{margin: '4px 0 0'}}>{total.toLocaleString()} row(s)</p>
          </div>
          <Link href={DOMAIN_HREFS[selectedDomain]}>Open {DOMAIN_LABELS[selectedDomain]} page →</Link>
        </div>
        {table}
        <DashboardPagination domain={selectedDomain} period={selectedPeriod} page={page} total={total} limit={limit} />
      </section>

      <section className="card" style={{marginBottom: 18}}>
        <h3>Quick actions</h3>
        <div className="dashboard-quick-grid">
          {QUICK_ACTIONS.map((action) => {
            const Icon = action.icon;
            return (
              <Link key={action.href} href={action.href} className="dashboard-quick-card">
                <span className="dashboard-quick-card__icon"><Icon size={22} aria-hidden /></span>
                <span>{action.label}</span>
              </Link>
            );
          })}
        </div>
      </section>

      {user.role === 'ADMIN' && reviewCounts ? (
        <section className="card">
          <div className="page-head" style={{marginBottom: 8}}>
            <div><h3 style={{margin: 0}}>Review status</h3></div>
            <Link href="/review">Open Review Queue →</Link>
          </div>
          <div className="dashboard-review-grid">
            {ADMIN_REVIEW_CARDS.map((card) => {
              const Icon = card.icon;
              const count = reviewCounts.byCategory[card.category] ?? 0;
              return (
                <Link key={card.category} href={`/review?category=${encodeURIComponent(card.category)}`} className="dashboard-review-card">
                  <span className="dashboard-review-card__icon"><Icon size={18} aria-hidden /></span>
                  <span className="dashboard-review-card__label">{card.label}</span>
                  <span className="dashboard-review-card__badge">{count}</span>
                </Link>
              );
            })}
          </div>
        </section>
      ) : null}
    </>
  );
}
