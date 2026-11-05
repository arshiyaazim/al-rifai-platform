// Vessel command input validation (pure, shared by API and tests).
import {z} from 'zod';

const programId = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/, 'PROGRAM_ID_INVALID');
const commandKey = z.string().trim().min(8).max(120).regex(/^[A-Za-z0-9._:-]+$/, 'COMMAND_KEY_INVALID');
const expectedRevision = z.number().int().min(0).max(1_000_000);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'DATE_INVALID');
const shift = z.enum(['D', 'N']);
const mobile = z.string().regex(/^01[3-9][0-9]{8}$/, 'MOBILE_INVALID');
const shortText = (max: number) => z.string().trim().max(max);

const editPatch = z.object({
  motherVessel: shortText(200).optional(),
  lighterVessel: shortText(200).optional(),
  masterMobile: shortText(40).optional(),
  destination: shortText(300).optional(),
  escortName: shortText(200).optional(),
  escortMobile: shortText(40).optional(),
  startDate: shortText(20).optional(),
  shift: z.enum(['D', 'N', '']).optional(),
  notes: shortText(2000).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'PATCH_REQUIRED');

export const addProgramSchema = z.object({
  action: z.literal('add'),
  commandKey,
  motherVessel: z.string().trim().min(1).max(200),
  lighterVessel: z.string().trim().min(1).max(200),
  masterMobile: z.string().trim().max(40).optional(),
  destination: z.string().trim().max(300).optional(),
  escortName: z.string().trim().max(200).optional(),
  escortMobile: z.string().trim().max(40).optional(),
  startDate: isoDate,
  shift,
  note: shortText(500).optional(),
}).strict();

export const editProgramSchema = z.object({
  action: z.literal('edit'),
  programId,
  expectedRevision,
  commandKey,
  patch: editPatch,
  note: shortText(500).optional(),
}).strict();

export const releaseProgramSchema = z.object({
  action: z.literal('release'),
  programId,
  expectedRevision,
  commandKey,
  endDate: isoDate,
  endShift: shift,
  releasePoint: z.string().trim().max(200),
  evidence: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const assignEscortSchema = z.object({
  action: z.literal('assign'),
  programId,
  expectedRevision,
  commandKey,
  employeeMobile: mobile,
  startDate: isoDate,
  startShift: shift,
  replace: z.boolean().optional(),
  note: shortText(500).optional(),
}).strict();

export const voidProgramSchema = z.object({
  action: z.literal('void'),
  programId,
  expectedRevision,
  commandKey,
  reason: z.string().trim().min(3).max(500),
}).strict();

export const fledProgramSchema = z.object({
  action: z.literal('fled'),
  programId,
  expectedRevision,
  commandKey,
  reason: z.string().trim().min(3).max(500),
}).strict();

export const commandSchema = z.discriminatedUnion('action', [
  addProgramSchema, editProgramSchema, releaseProgramSchema, assignEscortSchema, voidProgramSchema, fledProgramSchema,
]);

export type VesselCommand = z.infer<typeof commandSchema>;

export function parseCommand(input: unknown): VesselCommand {
  const parsed = commandSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const error = new Error(issue?.message || 'COMMAND_INVALID') as Error & {details?: unknown};
    error.details = parsed.error.issues.slice(0, 5).map((entry) => ({path: entry.path.join('.'), message: entry.message}));
    throw error;
  }
  return parsed.data;
}
