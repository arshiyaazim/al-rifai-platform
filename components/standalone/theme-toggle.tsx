'use client';

import {Monitor, Moon, Sun} from 'lucide-react';
import {useTheme} from 'next-themes';
import {useEffect, useState} from 'react';

const OPTIONS = [
  {value: 'light', label: 'Light', Icon: Sun},
  {value: 'dark', label: 'Dark', Icon: Moon},
  {value: 'system', label: 'System', Icon: Monitor},
] as const;

/** Three-state theme switch persisted in localStorage (`alrifai_theme`). */
export function ThemeToggle() {
  const {theme, setTheme, resolvedTheme} = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // Standard mounted guard for next-themes; the server snapshot is neutral.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);
  const active = mounted ? theme ?? 'system' : 'system';

  return (
    <div className="theme-toggle" role="group" aria-label="Colour theme">
      {OPTIONS.map(({value, label, Icon}) => (
        <button
          key={value}
          type="button"
          className="theme-toggle__button"
          aria-pressed={active === value}
          aria-label={`${label} theme`}
          title={
            value === 'system' && mounted && resolvedTheme
              ? `System (currently ${resolvedTheme})`
              : `${label} theme`
          }
          onClick={() => setTheme(value)}
        >
          <Icon className="size-3.5" />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}
