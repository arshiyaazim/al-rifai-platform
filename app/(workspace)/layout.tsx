import Link from 'next/link';
import type {ReactNode} from 'react';
import {pageUser} from '@/lib/standalone/session';
import {LogoutButton} from '@/components/standalone/logout-button';

export const dynamic = 'force-dynamic';

const NAV = [
  {href: '/dashboard', label: 'Dashboard'},
  {href: '/employees', label: 'Employees'},
  {href: '/vessel', label: 'Vessel Register'},
  {href: '/attendance', label: 'Attendance'},
  {href: '/cash', label: 'Cash & Accounts'},
  {href: '/payroll', label: 'Payroll'},
  {href: '/review', label: 'Review & Approval'},
  {href: '/messages', label: 'WhatsApp Inbox'},
  {href: '/reports', label: 'Reports & Archive'},
  {href: '/settings', label: 'Settings / Integrations'},
];

export default async function WorkspaceLayout({children}: {children: ReactNode}) {
  const user = await pageUser();
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">AL-RIFA’I</div>
        <nav>
          {NAV.map((item) => <Link key={item.href} href={item.href}>{item.label}</Link>)}
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
