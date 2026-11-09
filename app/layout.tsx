import type {Metadata} from 'next';
import {ThemeProvider} from '@/components/standalone/theme-provider';
import './globals.css';
import './standalone.css';

export const metadata: Metadata = {
  title: 'AL-RIFA’I — Business Management',
  description: 'Employees, vessel operations, cash, payroll and approvals.',
  robots: {index: false, follow: false},
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
