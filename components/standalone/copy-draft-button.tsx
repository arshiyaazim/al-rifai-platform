'use client';

import {useState} from 'react';

/**
 * Copy the exact Owner draft to the clipboard. Clipboard-only: this component
 * has no API call and sends nothing through WhatsApp.
 */
export function CopyDraftButton({text, label = 'Copy draft'}: {text: string; label?: string}) {
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle');

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
      window.setTimeout(() => setState('idle'), 2000);
    } catch {
      setState('error');
    }
  }

  return (
    <button type="button" onClick={() => void copy()}>
      {state === 'copied' ? 'Copied' : state === 'error' ? 'Copy failed — select the text' : label}
    </button>
  );
}
