'use client';
import {flushSync} from 'react-dom';
import {useEffect,useRef,useState} from 'react';
import {BusinessRows} from '../../../app/register-views';
import {csv,saveCsv} from '../../../lib/register';
import {minorMoney,businessReason} from '../../../lib/business-display';
import BusinessRequest from './BusinessRequest';
import BusinessReviews from './BusinessReviews';
import CashEntry from './CashEntry';
import CashPostingAction from './CashPostingAction';
import HistorySyncControls from './HistorySyncControls';
type Row=Record<string,unknown>;
type Data={rows:Row[];total:string;nextOffset:number|null;checkedAt:string;summary:{amountMinor:string;postedMinor:string;basis:string}|null;coverage:{basis:string;totalBasis:string;completeChatHistory:boolean}};
type Props={kind:'cash'|'roster';apiBase:string;account:string;csrf:string;onSessionExpired:()=>void};
const cashColumns=[{key:'sourceOrder',label:'Source / block order'},{key:'localTime',label:'Message time · ঢাকা'},{key:'name',label:'Employee / নাম'},{key:'employeePhone',label:'Employee mobile ID'},{key:'purpose',label:'Purpose'},{key:'payoutMobile',label:'Payout mobile'},{key:'method',label:'Method'},{key:'amount',label:'Instruction BDT'},{key:'posted',label:'Posted BDT'},{key:'status',label:'State'},{key:'review',label:'Review / evidence'}];
const rosterColumns=[{key:'motherVessel',label:'Mother vessel'},{key:'lighterVessel',label:'Lighter vessel'},{key:'escortName',label:'Escort'},{key:'escortMobile',label:'Employee ID'},{key:'masterMobile',label:'Master'},{key:'destination',label:'Destination'},{key:'startDate',label:'Start'},{key:'endDate',label:'Release'},{key:'shift',label:'D/N'},{key:'status',label:'State'},{key:'review',label:'Evidence / review'}];
export default function BusinessWorkspace({kind,apiBase,account,csrf,onSessionExpired}:Props){
 const [tab,setTab]=useState('register'),[filters,setFilters]=useState({q:'',from:'',to:'',payee:'',method:'',status:'',sort:'date',basis:'source',report:'register'}),[offset,setOffset]=useState(0),[refresh,setRefresh]=useState(0),[data,setData]=useState<Data|null>(null),[busy,setBusy]=useState(true),[error,setError]=useState(''),[detail,setDetail]=useState<Row|null>(null);
 const generation=useRef({value:0}),expire=useRef(onSessionExpired);useEffect(()=>{expire.current=onSessionExpired;},[onSessionExpired]);
 const filterKey=JSON.stringify([kind,account,filters,offset,tab]);const [loadedKey,setLoadedKey]=useState('');
 const current=loadedKey===filterKey?data:null;
 const requestScope=JSON.stringify([filterKey,refresh,apiBase]);const [priorScope,setPriorScope]=useState(requestScope);if(priorScope!==requestScope){setPriorScope(requestScope);setData(null);setDetail(null);setError('');setBusy(tab==='register');}
 useEffect(()=>{const generationCell=generation.current;const epoch=++generationCell.value,controller=new AbortController();
  if(tab!=='register'){return()=>{generationCell.value++;};}
  void fetch(apiBase+'/business/register?'+new URLSearchParams({...filters,view:kind,accountId:account,offset:String(offset)}),{credentials:'same-origin',cache:'no-store',signal:controller.signal}).then(async r=>{
   if(epoch!==generationCell.value||controller.signal.aborted)return;
   if(r.status===401){expire.current();return;}
   const result=await r.json();if(!r.ok)throw Error(r.status===403?'এই অংশে তথ্য দেখার অনুমতি নেই।':result.error==='BUSINESS_SCOPE_TOO_LARGE_SELECT_DATES'?'কম সময়সীমা বা নির্দিষ্ট কর্মী বেছে আবার খুঁজুন।':result.error==='WORKSPACE_DATABASE_SCOPE_NOT_READY'?'এই workflow-এর database migration এখনও সক্রিয় হয়নি।':'তথ্য ও বর্তমান উৎস যাচাই করা যায়নি। আবার চেষ্টা করুন।');
   if(epoch!==generationCell.value||controller.signal.aborted)return;
   if(filters.basis==='source'&&result.coverage?.basis!=='SOURCE_REVALIDATED')throw Error('বর্তমান উৎস যাচাই হয়নি।');
   setLoadedKey(filterKey);setData(result);
  }).catch(e=>{if(epoch===generationCell.value&&e.name!=='AbortError'){setData(null);setDetail(null);setError(e.message);}}).finally(()=>{if(epoch===generationCell.value)setBusy(false);});
  return()=>{controller.abort();generationCell.value++;};
 },[kind,apiBase,account,filters,offset,refresh,tab,filterKey]);
 function change(key:keyof typeof filters,value:string){generation.current.value++;setData(null);setDetail(null);setFilters(f=>({...f,[key]:value}));setOffset(0);}
 const columns=kind==='cash'?cashColumns:rosterColumns;
 const rows:Row[]=(current?.rows??[]).map(r=>({...r,localTime:r.sourceTime?new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Dhaka',dateStyle:'short',timeStyle:'medium'}).format(new Date(String(r.sourceTime))):r.date,amount:r.amountMinor?minorMoney(String(r.amountMinor)):'Unknown',posted:r.postedMinor?minorMoney(String(r.postedMinor)):'—',review:((r.reasons??[]) as string[]).map(businessReason).join('; ')}));
 async function verifiedSelection(){
  const seq=generation.current.value,key=filterKey;setDetail(null);
  const r=await fetch(apiBase+'/business/register?'+new URLSearchParams({...filters,view:kind,accountId:account,offset:String(offset)}),{credentials:'same-origin',cache:'no-store'});
  if(seq!==generation.current.value||key!==filterKey)throw Error('Selection changed.');
  if(r.status===401){expire.current();throw Error('Session expired.');}
  if(!r.ok)throw Error('বর্তমান source/permission যাচাই হয়নি। Export/detail বন্ধ রাখা হয়েছে।');
  const fresh:Data=await r.json();
  if(filters.basis==='source'&&fresh.coverage?.basis!=='SOURCE_REVALIDATED')throw Error('Source unavailable.');
  flushSync(()=>{setLoadedKey(key);setData(fresh);});return fresh;
 }
 function displayRows(fresh:Data):Row[]{return fresh.rows.map(r=>({...r,localTime:r.sourceTime?new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Dhaka',dateStyle:'short',timeStyle:'medium'}).format(new Date(String(r.sourceTime))):r.date,amount:r.amountMinor?minorMoney(String(r.amountMinor)):'Unknown',posted:r.postedMinor?minorMoney(String(r.postedMinor)):'—',review:((r.reasons??[]) as string[]).map(businessReason).join('; ')}));}
 async function exportPage(print=false){try{const fresh=await verifiedSelection(),selection=displayRows(fresh);if(print){window.print();return;}saveCsv(csv(['Scope','Filters','Read at','Rows in this export','Total basis',...columns.map(c=>c.label)],selection.map(r=>[kind+' / '+filters.basis,JSON.stringify(filters),fresh.checkedAt,selection.length,'Selected visible page; '+fresh.total+' visible filtered rows',...columns.map(c=>String(r[c.key]??''))])),'al-rifai-'+kind+'-selected-page.csv');}catch(e){setData(null);setDetail(null);setError(e instanceof Error?e.message:'Source unavailable.');}}
 async function showDetails(row:Row){try{const fresh=await verifiedSelection(),current=displayRows(fresh).find(r=>r.id===row.id);if(current)setDetail(current);else setError('এই record-এর বর্তমান source আর পাওয়া যাচ্ছে না।');}catch(e){setData(null);setDetail(null);setError(e instanceof Error?e.message:'Source unavailable.');}}
 return <section className="business-workspace" aria-label={kind==='cash'?'Cash workspace':'Escort roster workspace'}>
 <h2>{kind==='cash'?'Daily Cash Register / দৈনিক নগদ হিসাব':'Escort Roster / এসকর্ট ডিউটি'}</h2>
 <nav aria-label="Business views">{[['register','Register / তালিকা'],['request',kind==='cash'?'Manual entry / হাতে এন্ট্রি':'New request / অনুরোধ'],['reviews','Review / যাচাই']].map(([id,label])=><button key={id} aria-pressed={tab===id} onClick={()=>{setTab(id);setOffset(0);setData(null);setDetail(null);}}>{label}</button>)}</nav>
 {tab==='request'?(kind==='cash'?<CashEntry apiBase={apiBase} account={account} csrf={csrf} onSessionExpired={onSessionExpired}/>:<BusinessRequest kind={kind} apiBase={apiBase} account={account} csrf={csrf} onSessionExpired={onSessionExpired}/>):tab==='reviews'?<BusinessReviews kind={kind} apiBase={apiBase} account={account} csrf={csrf} onSessionExpired={onSessionExpired}/>:<>
 <HistorySyncControls apiBase={apiBase} account={account} csrf={csrf} kind={kind} onRefresh={()=>{setData(null);setDetail(null);setRefresh(n=>n+1);}} onSessionExpired={onSessionExpired}/>
 <div className="toolbar"><label>নাম / মোবাইল / উদ্দেশ্য / ভেসেল<input aria-label="Business search" value={filters.q} maxLength={150} onChange={e=>change('q',e.target.value)}/></label><label>Employee mobile<input aria-label="Reference filter" value={filters.payee} onChange={e=>change('payee',e.target.value)}/></label><label>From<input type="date" aria-label="Business from" value={filters.from} onChange={e=>change('from',e.target.value)}/></label><label>To<input type="date" aria-label="Business to" value={filters.to} onChange={e=>change('to',e.target.value)}/></label>
 {kind==='cash'&&<><label>Source<select aria-label="Cash source" value={filters.basis} onChange={e=>change('basis',e.target.value)}><option value="source">Source-linked instructions / postings</option><option value="archive">Historical references · separate</option></select></label><label>Method<select aria-label="Business method" value={filters.method} onChange={e=>change('method',e.target.value)}><option value="">All</option>{['cash','bkash','nagad','bank','rocket','unknown'].map(m=><option key={m}>{m}</option>)}</select></label></>}
 <label>State<select aria-label="Business status" value={filters.status} onChange={e=>change('status',e.target.value)}><option value="">All</option>{(kind==='cash'?['INTENT','REVIEW','PENDING_ADMIN','MANUAL_READY','POSTED']:['Draft','Confirmed','Assigned','In Duty','Completion Pending','Released','Cancelled','Review']).map(v=><option key={v}>{v}</option>)}</select></label><label>Sort<select aria-label="Business sort" value={filters.sort} onChange={e=>change('sort',e.target.value)}>{(kind==='cash'?['date','source','name','mobile']:['date','mother','lighter','name','mobile']).map(v=><option key={v}>{v}</option>)}</select></label>
 {kind==='roster'&&<label>Report<select aria-label="Roster report" value={filters.report} onChange={e=>change('report',e.target.value)}><option value="register">Duty overlap · inclusive</option><option value="cancelled">Cancellation history</option><option value="replaced">Replacement history</option><option value="incomplete">Incomplete fields</option><option value="missing">Unlinked source / program reconciliation</option></select></label>}
 <button disabled={busy} onClick={()=>{setData(null);setDetail(null);setRefresh(n=>n+1);}}>Refresh / হালনাগাদ</button></div>
 <p className="coverage-note">{kind==='cash'?'Instruction, send success, posting ও external transfer আলাদা। Opening balance ও বকেয়া অজানা; সমান অঙ্কের পৃথক উৎস আলাদা এন্ট্রি।':'Confirmed মানেই actual duty start নয়। Release, program completion, settlement ও payment আলাদা। Missing fields মানেই missing program নয়।'}</p>
 {current&&<><p className="print-scope">Scope: {kind} / {filters.basis} · {filters.from||'All dates'} – {filters.to||'All dates'} · Search: {filters.q||'All'} · Employee: {filters.payee||'All'} · Method/state: {filters.method||'All'} / {filters.status||'All'} · Report: {filters.report} · Visible filtered records: {current.total} · This page: {rows.length} · Read: {current.checkedAt}</p>
 {current.summary&&<div className="directory-summary"><span>এই পাতার instruction: ৳{minorMoney(current.summary.amountMinor)}</span><span>এই পাতার posted: ৳{minorMoney(current.summary.postedMinor)}</span><span>Opening / balance: Unknown</span></div>}
 <p>সংরক্ষিত ইতিহাস আংশিক। প্রতিবার বর্তমান উৎস মিলিয়ে তালিকা, মোট, CSV ও print তৈরি হয়। পুরোনো edit ধরতে অনুমোদিত চ্যাট শুরু থেকে rescan করুন।</p>
 <div className="table-actions"><button disabled={!rows.length} onClick={()=>void exportPage()}>CSV · selected visible page</button><button disabled={!rows.length} onClick={()=>void exportPage(true)}>Print · selected visible page</button></div>
 <BusinessRows columns={columns} rows={rows} onDetails={r=>void showDetails(r)}/>{!rows.length&&<p>এই ফিল্টারে যাচাইকৃত record নেই। এটি সম্পূর্ণ চ্যাট ইতিহাস নয়।</p>}
 <div className="pager"><button disabled={busy||offset===0} onClick={()=>setOffset(Math.max(0,offset-25))}>Previous page</button><button disabled={busy||current.nextOffset===null} onClick={()=>setOffset(current.nextOffset!)}>Next page</button></div></>}
 {detail&&current&&<section className="message-detail" aria-label="Business record detail"><button onClick={()=>setDetail(null)}>Close</button><dl>{columns.map(c=><div key={c.key}><dt>{c.label}</dt><dd>{String(detail[c.key]??'Unknown')}</dd></div>)}</dl>
 <h3>Source / record details</h3><dl><dt>Posted reference</dt><dd>{String(detail.postingId??'Not posted')}</dd><dt>Name aliases · permitted records</dt><dd>{((detail.aliases??[]) as string[]).join(' / ')||'Unknown'}</dd></dl><ul>{((detail.references??[]) as string[]).map(id=><li key={id}>{id}</li>)}</ul><p>Original instant: {String(detail.sourceTime??'Unknown')} · Business operation: {String(detail.operationId??detail.id)}</p>
 {kind==='cash'&&!!detail.employeePhone&&<button onClick={()=>{change('payee',String(detail.employeePhone));}}>Employee statement / এই মোবাইলের হিসাব</button>}
 {kind==='cash'&&<CashPostingAction row={detail} apiBase={apiBase} account={account} csrf={csrf} onPosted={()=>{setDetail(null);setData(null);setRefresh(n=>n+1);}} onSessionExpired={onSessionExpired}/>}
 {kind==='roster'&&!!detail.calculation&&<p>Calculation: {String((detail.calculation as {state:string}).state)} · {((detail.calculation as {reasons:string[]}).reasons??[]).map(businessReason).join('; ')}</p>}
 {Array.isArray(detail.events)&&<BusinessRows columns={[{key:'action',label:'Action'},{key:'date',label:'Effective date'},{key:'recordedAt',label:'Recorded'}]} rows={(detail.events as Array<{id:string;command:{action:string;effectiveDate?:string};approvedAt:string}>).map(e=>({id:e.id,action:e.command.action,date:e.command.effectiveDate??'',recordedAt:e.approvedAt}))}/>}</section>}
 </>}{busy&&<p role="status">উৎস মিলিয়ে তথ্য পড়া হচ্ছে…</p>}{error&&<p role="alert">{error}</p>}</section>;
}
