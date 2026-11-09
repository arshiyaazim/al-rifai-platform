'use client';

import type {ReactNode} from 'react';
import {
  Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';

/**
 * Reusable right-hand detail sidebar.
 *
 * Wraps the existing shadcn Sheet: slides in from the right, closes on Escape,
 * backdrop click or the X button, scrolls its body and keeps a fixed footer for
 * actions. Cash and Vessel use the same component.
 */
export function DetailSidebar({
  open, onClose, title, description, children, footer,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-[480px]">
        <SheetHeader className="border-b p-4 pr-12">
          <SheetTitle className="text-base">{title}</SheetTitle>
          {description ? <SheetDescription>{description}</SheetDescription> : null}
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        {footer ? (
          <SheetFooter className="flex-row flex-wrap justify-end gap-2 border-t p-4">
            {footer}
          </SheetFooter>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
