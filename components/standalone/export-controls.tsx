'use client';

import {Download, MoreHorizontal, Printer} from 'lucide-react';
import {useState} from 'react';
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
  filterSummary?: Array<string | null | undefined>;
  disabled?: boolean;
};

export function TableExportControls<T>({
  title, filenamePrefix, columns, rows, fetchAll, filterSummary = [], disabled = false,
}: Props<T>) {
  const [exportAll, setExportAll] = useState(false);
  const [busy, setBusy] = useState<'csv' | 'print' | null>(null);

  async function exportCsv() {
    setBusy('csv');
    try {
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
        <div className="export-actions export-desktop">
          <Button type="button" size="sm" variant="outline" onClick={() => void exportCsv()} disabled={disabled || busy !== null}>
            <Download className="size-4" /> {busy === 'csv' ? 'Preparing…' : 'Export CSV'}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={printTable} disabled={disabled || busy !== null}>
            <Printer className="size-4" /> Print
          </Button>
        </div>
        <details className="export-mobile">
          <summary aria-label="Export and print options"><MoreHorizontal className="size-4" /></summary>
          <div className="export-mobile__menu">
            <button type="button" onClick={() => void exportCsv()} disabled={disabled || busy !== null}>
              <Download className="size-4" /> {busy === 'csv' ? 'Preparing CSV…' : 'Export CSV'}
            </button>
            <button type="button" onClick={printTable} disabled={disabled || busy !== null}>
              <Printer className="size-4" /> Print
            </button>
          </div>
        </details>
      </div>
      <div className="print-only print-heading">
        <strong>{heading}</strong>
        <span>Generated {todayStamp()} · AL-RIFA&apos;I Platform</span>
      </div>
    </>
  );
}
