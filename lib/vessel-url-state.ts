import type {RegisterFilters} from './vessel-data.ts';

export function registerBrowserParams({
 source,page,sort,filters,explicit,
}:{
 source:'historical'|'live'|'archive';
 page:number;
 sort:string;
 filters:RegisterFilters;
 explicit:ReadonlySet<string>;
}):URLSearchParams{
 const params=new URLSearchParams();
 if(source!=='historical'||explicit.has('source'))params.set('source',source);
 if(page!==1||explicit.has('page'))params.set('page',String(page));
 if(sort!=='newest'||explicit.has('sort'))params.set('sort',sort);
 for(const [key,value] of Object.entries(filters))if(value)params.set(key,String(value));
 return params;
}
