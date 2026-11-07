import Link from 'next/link';
import type {ReactNode} from 'react';
import {pageUser} from '@/lib/standalone/session';
import {reviewQueueCounts} from '@/lib/standalone/review';
import {LogoutButton} from '@/components/standalone/logout-button';

export const dynamic = 'force-dynamic';

const NAV = [
  {href: '/dashboard', label: 'Dashboard'},
  {href: '/insights', label: 'Insights'},
  {href: '/assistant', label: 'AI Assistant'},
  {href: '/employees', label: 'Employees'},
  {href: '/vessel', label: 'Vessel Register'},
  {href: '/vessel/drafts', label: 'Order Drafts'},
  {href: '/attendance', label: 'Attendance'},
  {href: '/cash', label: 'Cash & Accounts'},
  {href: '/payroll', label: 'Payroll'},
  {href: '/review', label: 'Review Queue'},
  {href: '/messages', label: 'WhatsApp Inbox'},
  {href: '/reports', label: 'Reports & Archive'},
  {href: '/settings', label: 'Settings / Integrations'},
];

export default async function WorkspaceLayout({children}: {children: ReactNode}) {
  const user = await pageUser();
  const reviewCounts = await reviewQueueCounts();
  const pendingReviews = reviewCounts.pending + reviewCounts.cashPending;
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">AL-RIFA’I</div>
        <nav>
          {NAV.map((item) => (
            <Link key={item.href} href={item.href}>
              {item.label}
              {item.href === '/review' && pendingReviews > 0 ? (
                <span className="pill warn" style={{marginLeft: 8}}>{pendingReviews}</span>
              ) : null}
            </Link>
          ))}
        </nav>
        <div className="who">
          <span>{user.displayName} · {user.role}</span>
          <LogoutButton />
        </div>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}
