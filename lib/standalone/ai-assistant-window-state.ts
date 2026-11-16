/**
 * Pure window state for the floating assistant. Kept separate from the React
 * component so the control behaviour can be tested without a browser.
 *
 * These transitions only change the chat window — they never navigate, write
 * data or open a form. Form opening is a separate, confirmed action.
 */
export type AssistantWindowState = 'closed' | 'normal' | 'maximized' | 'minimized';
export type AssistantWindowAction = 'open' | 'minimize' | 'toggleMaximize' | 'close' | 'restore';

export function isPanelVisible(state: AssistantWindowState): boolean {
  return state === 'normal' || state === 'maximized';
}

export function isLauncherVisible(state: AssistantWindowState): boolean {
  return state === 'closed' || state === 'minimized';
}

export function reduceWindowState(state: AssistantWindowState, action: AssistantWindowAction): AssistantWindowState {
  switch (action) {
    case 'open':
      return state === 'closed' || state === 'minimized' ? 'normal' : state;
    case 'minimize':
      return isPanelVisible(state) ? 'minimized' : state;
    case 'toggleMaximize':
      if (state === 'maximized') return 'normal';
      if (state === 'normal') return 'maximized';
      return state;
    case 'restore':
      return state === 'minimized' ? 'normal' : state;
    case 'close':
      return 'closed';
    default:
      return state;
  }
}
