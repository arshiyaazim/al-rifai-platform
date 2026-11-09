'use client';

import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {useEffect, useRef, useState, type ReactNode} from 'react';
import {LogoutButton} from '@/components/standalone/logout-button';
import {ThemeToggle} from '@/components/standalone/theme-toggle';

export type WorkspaceNavItem = {
  href: string;
  label: string;
};

type Props = {
  navItems: ReadonlyArray<WorkspaceNavItem>;
  pendingReviews: number;
  user: {displayName: string; role: string};
  children: ReactNode;
};

function shortLabel(label: string) {
  return label
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
    .slice(0, 2) || label.slice(0, 2).toUpperCase();
}

/**
 * Workspace chrome. The sidebar is reusable by any authenticated page that
 * renders this shell, while navigation, review counts, identity and sign-out
 * remain owned by the server layout.
 */
export function WorkspaceSidebar({navItems, pendingReviews, user, children}: Props) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [menu, setMenu] = useState<{open: boolean; path: string}>({open: false, path: pathname});
  const mobileOpen = menu.open && menu.path === pathname;
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const hamburgerRef = useRef<HTMLButtonElement>(null);
  const openMenu = () => setMenu({open: true, path: pathname});
  const closeMenu = () => setMenu((current) => ({...current, open: false}));

  const activeHref = navItems
    .filter((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
    .sort((left, right) => right.href.length - left.href.length)[0]?.href;

  useEffect(() => {
    if (!mobileOpen) return;
    closeButtonRef.current?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMenu((current) => ({...current, open: false}));
      hamburgerRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [mobileOpen]);

  const userLabel = `${user.displayName} · ${user.role}`;

  return (
    <div
      className="wx-workspace"
      data-collapsed={collapsed ? 'true' : 'false'}
      data-mobile-open={mobileOpen ? 'true' : 'false'}
    >
      <a className="wx-workspace__skip" href="#workspace-content">Skip to content</a>

      <header className="wx-workspace__mobile-bar">
        <button
          ref={hamburgerRef}
          type="button"
          className="wx-workspace__mobile-toggle"
          aria-label="Open navigation"
          aria-expanded={mobileOpen}
          aria-controls="workspace-sidebar"
          onClick={openMenu}
        >
          <span aria-hidden="true">☰</span>
          <span>Menu</span>
        </button>
        <span className="wx-workspace__mobile-brand">AL-RIFA’I</span>
      </header>

      <aside id="workspace-sidebar" className="wx-workspace__sidebar" aria-label="Workspace navigation">
        <div className="wx-workspace__brand-row">
          <Link className="wx-workspace__brand" href="/dashboard">AL-RIFA’I</Link>
          <button
            ref={closeButtonRef}
            type="button"
            className="wx-workspace__icon-button wx-workspace__close"
            aria-label="Close navigation"
            onClick={() => {
              closeMenu();
              hamburgerRef.current?.focus();
            }}
          >
            <span aria-hidden="true">×</span>
          </button>
          <button
            type="button"
            className="wx-workspace__icon-button wx-workspace__collapse-toggle"
            aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            aria-expanded={!collapsed}
            aria-controls="workspace-sidebar"
            title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            onClick={() => setCollapsed((value) => !value)}
          >
            <span aria-hidden="true">{collapsed ? '›' : '‹'}</span>
          </button>
        </div>

        <nav className="wx-workspace__nav">
          {navItems.map((item) => {
            const isReview = item.href === '/review';
            const isActive = item.href === activeHref;
            return (
              <Link
                key={item.href}
                href={item.href}
                className="wx-workspace__nav-link"
                aria-current={isActive ? 'page' : undefined}
                aria-label={collapsed ? item.label : undefined}
                title={collapsed ? item.label : undefined}
                onClick={closeMenu}
              >
                <span className="wx-workspace__nav-mark" aria-hidden="true">{shortLabel(item.label)}</span>
                <span className="wx-workspace__nav-label">{item.label}</span>
                {isReview && pendingReviews > 0 ? (
                  <span className="pill warn wx-workspace__review-count" aria-label={`${pendingReviews} pending reviews`}>
                    {pendingReviews}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </nav>

        <div className="wx-workspace__who">
          <ThemeToggle />
          <span className="wx-workspace__user" title={userLabel}>{userLabel}</span>
          <LogoutButton />
        </div>
      </aside>

      {mobileOpen ? (
        <button
          type="button"
          className="wx-workspace__overlay"
          aria-label="Close navigation"
          tabIndex={-1}
          onClick={() => {
            closeMenu();
            hamburgerRef.current?.focus();
          }}
        />
      ) : null}

      <main id="workspace-content" className="wx-workspace__content">{children}</main>
    </div>
  );
}
