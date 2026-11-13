import type {ReactNode} from 'react';
import {pageUser} from '@/lib/standalone/session';
import {reviewQueueCounts} from '@/lib/standalone/review';
import {WorkspaceSidebar} from '@/components/standalone/workspace-sidebar';

export const dynamic = 'force-dynamic';

const NAV = [
  {href: '/home', label: 'Home'},
  {href: '/insights', label: 'Insights'},
  {href: '/assistant', label: 'AI Assistant'},
  {href: '/employees', label: 'Employees / Escorts'},
  {href: '/vessel', label: 'Vessel Register'},
  {href: '/vessel/drafts', label: 'Order Drafts'},
  {href: '/attendance', label: 'Attendance'},
  {href: '/cash', label: 'Cash & Accounts'},
  {href: '/cash/paid', label: 'Business Paid'},
  {href: '/payroll', label: 'Payroll'},
  {href: '/review', label: 'Review Queue'},
  {href: '/messages', label: 'WhatsApp Inbox'},
  {href: '/reports', label: 'Reports & Archive'},
  {href: '/audit', label: 'Audit Trail'},
  {href: '/settings', label: 'Settings / Integrations'},
  {href: '/settings/api-keys', label: 'API Keys'},
  {href: '/settings/recruitment', label: 'Recruitment AI'},
];

const ADMIN_ONLY_NAV = new Set(['/audit', '/settings/api-keys', '/settings/recruitment']);

export default async function WorkspaceLayout({children}: {children: ReactNode}) {
  const user = await pageUser();
  const reviewCounts = await reviewQueueCounts();
  const pendingReviews = reviewCounts.pending + reviewCounts.cashPending;
  return (
    <WorkspaceSidebar
      navItems={user.role === 'ADMIN' ? NAV : NAV.filter((item) => !ADMIN_ONLY_NAV.has(item.href))}
      pendingReviews={pendingReviews}
      user={{displayName: user.displayName, role: user.role}}
    >
      {children}
    </WorkspaceSidebar>
  );
}
