import type {Program} from "./programs";
import {lazyEvidence} from "./evidence";
export const seed=lazyEvidence<Program[]>("recovered-programs.json");
