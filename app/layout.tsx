import type {Metadata, Viewport} from 'next';
import './globals.css';
import './standalone.css';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export const metadata: Metadata = {
  title: 'AL-RIFA’I — Business Management',
  description: 'Employees, vessel operations, cash, payroll and approvals.',
  robots: {index: false, follow: false},
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
