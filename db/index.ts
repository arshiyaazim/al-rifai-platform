import {drizzle} from "drizzle-orm/node-postgres";
import {pool} from "./raw";
import * as schema from "./schema";
export function getDb(){return drizzle(pool(),{schema});}
