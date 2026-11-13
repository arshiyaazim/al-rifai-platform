import {redirect} from 'next/navigation';

export const dynamic = 'force-dynamic';

/** Legacy bookmark: /dashboard was renamed to /home. */
export default function DashboardRedirect() {
  redirect('/home');
}
