import {createRequire} from "node:module";

export type IngestionDbClient = {
  query(sql: string, values?: unknown[]): Promise<{rows?: Array<Record<string, unknown>>; rowCount: number | null}>;
  release(): void;
};

export type IngestionDbPool = {
  connect(): Promise<IngestionDbClient>;
  query(sql: string, values?: unknown[]): Promise<{rows?: Array<Record<string, unknown>>; rowCount: number | null}>;
  end(): Promise<void>;
};

const require = createRequire(import.meta.url);
const {createPool} = require("../db/postgres.mjs") as {
  createPool(options: {readOnly: boolean; user?: "alrifai_app" | "ir_review_runtime" | "alrifai_mirror_worker"}): IngestionDbPool;
};

export function createIngestionDbPool(): IngestionDbPool {
  return createPool({readOnly: false});
}

export function createMirrorWorkerDbPool(): IngestionDbPool {
  return createPool({readOnly: false, user: "alrifai_mirror_worker"});
}
