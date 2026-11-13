// Fuzzy CSV header auto-mapping.
//
// Exact match -> normalised match (case/space/dot/underscore removed) ->
// keyword match. Required columns missing => a suggestion is returned instead
// of silently importing the wrong data.

export type CsvKind = 'vessel' | 'cash';

export type FieldSpec = {
  field: string;
  label: string;
  aliases: string[];
  required?: boolean;
  keywords?: string[][];
};

const VESSEL_FIELDS: FieldSpec[] = [
  {field: 'motherVessel', label: 'Mother Vessel', required: true, aliases: ['mother', 'mother ship', 'মাদার ভেসেল'], keywords: [['mother']]},
  {field: 'lighterVessel', label: 'Lighter Vessel', required: true, aliases: ['lighter', 'lighter name', 'righter vessel'], keywords: [['lighter'], ['righter']]},
  {field: 'masterMobile', label: 'Master Mobile', aliases: ['master mobile', 'master number', 'master mob'], keywords: [['master', 'mobile'], ['master', 'number']]},
  {field: 'escortName', label: 'Escort Name', aliases: ['escort', 'escort name', 'employee name'], keywords: [['escort', 'name']]},
  {field: 'escortMobile', label: 'Escort Mobile', aliases: ['escort mobile', 'employee mobile', 'escort number'], keywords: [['escort', 'mobile'], ['escort', 'number'], ['employee', 'mobile']]},
  {field: 'startDate', label: 'Start Date', required: true, aliases: ['start', 'start date', 'date', 'assignment date'], keywords: [['start'], ['assignment', 'date'], ['date']]},
  {field: 'startShift', label: 'Start Shift', aliases: ['shift', 'start shift'], keywords: [['shift']]},
  {field: 'endDate', label: 'End Date', aliases: ['end', 'end date', 'release date'], keywords: [['end', 'date'], ['release', 'date']]},
  {field: 'endShift', label: 'End Shift', aliases: ['end shift'], keywords: [['end', 'shift']]},
  {field: 'description', label: 'Description', aliases: ['notes', 'note', 'description'], keywords: [['note'], ['description']]},
];

const CASH_FIELDS: FieldSpec[] = [
  {field: 'employeeMobile', label: 'Employee Mobile', required: true, aliases: ['employee mobile', 'employee id', 'mobile', 'payout mobile'], keywords: [['employee', 'mobile'], ['employee', 'id'], ['mobile']]},
  {field: 'amount', label: 'Amount', required: true, aliases: ['amount', 'paid', 'salary'], keywords: [['amount'], ['paid']]},
  {field: 'employeeName', label: 'Employee Name', aliases: ['employee name', 'name', 'name of employee'], keywords: [['employee', 'name'], ['name']]},
  {field: 'date', label: 'Date', aliases: ['date', 'payment date', 'event date'], keywords: [['date']]},
  {field: 'description', label: 'Description', aliases: ['description', 'purpose', 'notes'], keywords: [['description'], ['purpose'], ['note']]},
  {field: 'method', label: 'Method', aliases: ['method', 'payment method'], keywords: [['method']]},
  {field: 'status', label: 'Status', aliases: ['status', 'state'], keywords: [['status'], ['state']]},
];

const normalise = (value: string) => value.toLowerCase().replace(/[\s._-]+/g, '').trim();

export type ColumnMapping = {
  mapping: Record<string, number>;
  matched: Array<{field: string; label: string; header: string; index: number; how: 'EXACT' | 'NORMALISED' | 'KEYWORD'}>;
  unmatched: string[];
  missingRequired: Array<{field: string; label: string; suggestions: string[]}>;
};

export function autoMapColumns(headers: string[], kind: CsvKind): ColumnMapping {
  const specs = kind === 'vessel' ? VESSEL_FIELDS : CASH_FIELDS;
  const used = new Set<number>();
  const mapping: Record<string, number> = {};
  const matched: ColumnMapping['matched'] = [];

  const assign = (spec: FieldSpec, index: number, how: 'EXACT' | 'NORMALISED' | 'KEYWORD') => {
    if (used.has(index) || mapping[spec.field] !== undefined) return false;
    mapping[spec.field] = index;
    used.add(index);
    matched.push({field: spec.field, label: spec.label, header: headers[index], index, how});
    return true;
  };

  // 1. exact (case-insensitive, trimmed)
  specs.forEach((spec) => {
    const index = headers.findIndex((header, position) => !used.has(position)
      && (header.trim().toLowerCase() === spec.label.toLowerCase()
        || spec.aliases.some((alias) => alias.toLowerCase() === header.trim().toLowerCase())));
    if (index >= 0) assign(spec, index, 'EXACT');
  });

  // 2. normalised (spaces/dots/underscores/hyphens removed)
  specs.forEach((spec) => {
    if (mapping[spec.field] !== undefined) return;
    const keys = [spec.label, ...spec.aliases].map(normalise);
    const index = headers.findIndex((header, position) => !used.has(position) && keys.includes(normalise(header)));
    if (index >= 0) assign(spec, index, 'NORMALISED');
  });

  // 3. keyword combinations
  specs.forEach((spec) => {
    if (mapping[spec.field] !== undefined || !spec.keywords?.length) return;
    const index = headers.findIndex((header, position) => {
      if (used.has(position)) return false;
      const value = header.toLowerCase();
      return spec.keywords!.some((words) => words.every((word) => value.includes(word)));
    });
    if (index >= 0) assign(spec, index, 'KEYWORD');
  });

  const missingRequired = specs.filter((spec) => spec.required && mapping[spec.field] === undefined)
    .map((spec) => ({
      field: spec.field,
      label: spec.label,
      suggestions: headers.filter((header) => !used.has(headers.indexOf(header))).slice(0, 8),
    }));

  return {
    mapping,
    matched,
    unmatched: headers.filter((_, index) => !used.has(index)),
    missingRequired,
  };
}

export function cell(row: string[], mapping: Record<string, number>, field: string): string {
  const index = mapping[field];
  return index === undefined ? '' : String(row[index] ?? '').trim();
}
