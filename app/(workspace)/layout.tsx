import type {ReactNode} from 'react';
import {pageUser} from '@/lib/standalone/session';
import {reviewQueueCounts} from '@/lib/standalone/review';
import {WorkspaceSidebar} from '@/components/standalone/workspace-sidebar';

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
    <WorkspaceSidebar
      navItems={NAV}
      pendingReviews={pendingReviews}
      user={{displayName: user.displayName, role: user.role}}
    >
      {children}
    </WorkspaceSidebar>
  );
}
