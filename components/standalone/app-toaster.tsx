'use client';

import {Toaster} from 'sonner';

/** Success toasts auto-dismiss (3s) and errors stay until dismissed. */
export function AppToaster() {
  return (
    <Toaster
      position="top-right"
      richColors
      closeButton
      duration={3000}
      toastOptions={{duration: 3000}}
    />
  );
}
