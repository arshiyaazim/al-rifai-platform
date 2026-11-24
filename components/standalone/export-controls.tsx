'use client';

import {Download, Printer} from 'lucide-react';
import {useState, type ReactNode} from 'react';
import {toast} from 'sonner';
import {Button} from '@/components/ui/button';
import {
  downloadCsv, printHeading, todayStamp, type ExportColumn,
} from '@/lib/export-format';

type Props<T> = {
  title: string;
  filenamePrefix: string;
  columns: ExportColumn<T>[];
  rows: T[];
  /** Fetch the full filtered result set for "Export all pages". */
  fetchAll?: () => Promise<T[]>;
  /** When set, Export CSV downloads this server-rendered CSV instead. */
  exportHref?: string;
  filterSummary?: Array<string | null | undefined>;
  disabled?: boolean;
  /** Optional Import control rendered first, inside the same icon group. */
  importAction?: ReactNode;
  /** Render only the two icon buttons (no checkbox, no print heading). */
  compact?: boolean;
};

export function TableExportControls<T>({
  title, filenamePrefix, columns, rows, fetchAll, exportHref, filterSummary = [], disabled = false, importAction, compact = false,
}: Props<T>) {
  const [exportAll, setExportAll] = useState(false);
  const [busy, setBusy] = useState<'csv' | 'print' | null>(null);

  async function exportCsv() {
    setBusy('csv');
    try {
      if (exportHref) {
        window.open(exportHref, '_blank', 'noopener,noreferrer');
        return;
      }
      const source = exportAll && fetchAll ? await fetchAll() : rows;
      downloadCsv(`${filenamePrefix}_${todayStamp()}.csv`, source, columns);
      toast.success(`Exported ${source.length.toLocaleString()} row(s) to CSV.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'CSV export failed.', {duration: Infinity});
    } finally {
      setBusy(null);
    }
  }

  function printTable() {
    setBusy('print');
    try {
      window.print();
      toast.success('Print dialog opened.');
    } finally {
      setBusy(null);
    }
  }

  const heading = printHeading(title, filterSummary);

  if (compact) {
    return (
      <>
        {importAction}
        <Button type="button" size="icon-sm" variant="outline" className="action-icon-button"
          onClick={() => void exportCsv()} disabled={disabled || busy !== null}
          aria-label={busy === 'csv' ? 'Preparing CSV export' : 'Export CSV'} title="Export CSV">
          <Download className="size-4" />
        </Button>
        <Button type="button" size="icon-sm" variant="outline" className="action-icon-button"
          onClick={printTable} disabled={disabled || busy !== null}
          aria-label="Print" title="Print">
          <Printer className="size-4" />
        </Button>
      </>
    );
  }

  return (
    <>
      <div className="export-controls print-hidden">
        <label className="export-all" title="When checked, the current filter is fetched from the server and every matching page is exported.">
          <input
            type="checkbox"
            checked={exportAll}
            disabled={disabled || !fetchAll}
            onChange={(event) => setExportAll(event.target.checked)}
          />
          Export all pages
        </label>
        <div className="export-actions">
          {importAction}
          <Button type="button" size="icon-sm" variant="outline" className="action-icon-button"
            onClick={() => void exportCsv()} disabled={disabled || busy !== null}
            aria-label={busy === 'csv' ? 'Preparing CSV export' : 'Export CSV'} title="Export CSV">
            <Download className="size-4" />
          </Button>
          <Button type="button" size="icon-sm" variant="outline" className="action-icon-button"
            onClick={printTable} disabled={disabled || busy !== null}
            aria-label="Print" title="Print">
            <Printer className="size-4" />
          </Button>
        </div>
      </div>
      <div className="print-only print-heading">
        <strong>{heading}</strong>
        <span>Generated {todayStamp()} · AL-RIFA&apos;I Platform</span>
      </div>
    </>
  );
}
