// Single implementation of employee typeahead ranking. The client component
// (app/platform/employee-typeahead.tsx) renders what this module returns; no
// surface may re-implement matching, dedupe or ordering.

export const SUGGESTION_DEBOUNCE_MS=300;
export const SUGGESTION_LIMIT=10;

// A suggestion is an identity surface: it carries name + employee mobile only.
// payoutPhone, sourceText, amountCents, sender and receiverIdentity must never
// enter this type or the dropdown render path.
export type EmployeeSuggestion={phone:string;name:string;display:string};

export type SuggestionSource={
  name:string;
  // Employee ID (the Escort Mobile reference). Never a payout destination.
  employeePhone:string|null;
};

export function normalizeSearchText(value:string):string{
  return value.toLowerCase().replace(/\s+/g,' ').trim();
}

export function buildSuggestions(
  rows:readonly SuggestionSource[],
  query:string,
  max:number=SUGGESTION_LIMIT,
):EmployeeSuggestion[]{
  const q=normalizeSearchText(query);
  if(!q)return [];

  // Rows arrive newest-first (the API orders by source_time DESC), so the first
  // name seen for a phone is the most recent one. No separate date sort needed.
  const byPhone=new Map<string,string>();
  for(const row of rows){
    const phone=(row.employeePhone??'').trim();
    if(!phone)continue;
    if(!byPhone.has(phone))byPhone.set(phone,(row.name??'').trim()||'Name unknown');
  }

  // Bucket order: exact phone, phone starts-with, name starts-with, name contains.
  const ranked:Array<{bucket:number;suggestion:EmployeeSuggestion}>=[];
  for(const [phone,name] of byPhone){
    const normalizedPhone=phone.toLowerCase();
    const normalizedName=normalizeSearchText(name);
    let bucket=-1;
    if(normalizedPhone===q)bucket=0;
    else if(normalizedPhone.startsWith(q))bucket=1;
    else if(normalizedName.startsWith(q))bucket=2;
    else if(normalizedName.includes(q))bucket=3;
    if(bucket<0)continue;
    ranked.push({bucket,suggestion:{phone,name,display:`${name} · ${phone}`}});
  }

  ranked.sort((a,b)=>
    a.bucket-b.bucket
    || a.suggestion.name.localeCompare(b.suggestion.name)
    || a.suggestion.phone.localeCompare(b.suggestion.phone));

  return ranked.slice(0,Math.max(1,max)).map(entry=>entry.suggestion);
}
