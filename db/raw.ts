import type {QueryResultRow} from "pg";
import {createPool} from "./postgres.mjs";
let instance:ReturnType<typeof createPool>|undefined;
export function pool(){return instance??=createPool();}
const reader={
 async all<T extends QueryResultRow=QueryResultRow>(sql:string,values:unknown[]=[]):Promise<{results:T[]}>{return {results:(await pool().query<T>(sql,values)).rows};},
 async first<T extends QueryResultRow=QueryResultRow>(sql:string,values:unknown[]=[]):Promise<T|null>{return (await pool().query<T>(sql,values)).rows[0]??null;}
};
export function database(){return reader;}
