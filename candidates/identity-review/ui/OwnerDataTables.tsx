'use client';
import {useEffect,useRef,useState} from 'react';
type Page={columns:string[];rows:Record<string,unknown>[];nextAfter:string|null;checkedAt:string;notice:string;readOnly:boolean};
const views=[['programs','Program'],['cash','ক্যাশ reference'],['payments','Payment draft'],['settlements','Settlement draft'],['sources','তথ্যের উৎস']] as const;
const labels:Record<string,string>={id:'রেকর্ড',motherVessel:'Mother vessel',lighterVessel:'Lighter vessel',escortName:'Escort',escortMobile:'Escort নম্বর',masterMobile:'Master নম্বর',destination:'গন্তব্য',startDate:'শুরু',endDate:'শেষ',shift:'Shift',status:'অবস্থা',source:'উৎস',revision:'সংশোধন',date:'তারিখ',employeePhone:'Reference নম্বর',name:'নাম',method:'পদ্ধতি',amountCents:'টাকার পরিমাণ',actor:'দাখিলকারী',createdAt:'তৈরির সময়',datasetId:'Dataset',kind:'তথ্যের ধরন',contentHash:'উৎসের চিহ্ন'};
export default function OwnerDataTables({apiBase,account}:{apiBase:string;account:string}){
 const [view,setView]=useState('programs'),[page,setPage]=useState<Page|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const generation=useRef({value:0}),active=useRef(true);
 useEffect(()=>{const generationCell=generation.current;active.current=true;return()=>{active.current=false;generationCell.value++;};},[]);
 const scope=JSON.stringify([view,account,apiBase]);const [priorScope,setPriorScope]=useState(scope);if(priorScope!==scope){setPriorScope(scope);setPage(null);setError('');setBusy(false);}
 useEffect(()=>{const cell=generation.current;return()=>{cell.value++;};},[view,account,apiBase]);
 async function load(after=''){
  const seq=++generation.current.value;setBusy(true);setError('');
  try{const q=new URLSearchParams({view,accountId:account,after});const r=await fetch(apiBase+'/workspace/data?'+q,{credentials:'same-origin',cache:'no-store'});const data=await r.json();if(!active.current||seq!==generation.current.value)return;if(!r.ok){setPage(null);throw Error(data.error==='WORKSPACE_SCOPE_DENIED'?'এই তথ্য দেখার অনুমতি নেই।':data.error==='WORKSPACE_DATABASE_SCOPE_NOT_READY'?'Database-এর read access এখনও চালু হয়নি।':'তথ্য পাওয়া যায়নি। আবার login বা refresh করুন।');}setPage(data);}catch(e){if(active.current&&seq===generation.current.value){setPage(null);setError(e instanceof Error?e.message:'তথ্য পাওয়া যায়নি।');}}finally{if(active.current&&seq===generation.current.value)setBusy(false);}
 }
 function value(key:string,v:unknown){if(key==='amountCents'&&/^-?\d+$/.test(String(v))){const n=Number(v);if(Number.isSafeInteger(n))return (n/100).toFixed(2);}return String(v??'');}
 return <section aria-label="Owner database tables"><h2>Database-এর তথ্য</h2><p>একই login থেকে অনুমোদিত database records দেখুন। এখানে তথ্য দেখা যায়; payment বা business পরিবর্তন করা হয় না।</p>
 <label>তথ্যের ধরন<select aria-label="Database view" value={view} onChange={e=>setView(e.target.value)}>{views.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label><button disabled={busy} onClick={()=>void load()}>তথ্য দেখুন / Refresh</button>
 {page&&<><p>{page.notice}</p><p>পড়া হয়েছে: {page.checkedAt}</p><div style={{overflowX:'auto'}}><table aria-label="Database records"><thead><tr>{page.columns.map(c=><th key={c}>{labels[c]??c}</th>)}</tr></thead><tbody>{page.rows.map(r=><tr key={String(r.id)}>{page.columns.map(c=><td key={c}>{value(c,r[c])}</td>)}</tr>)}</tbody></table></div>{page.rows.length===0&&<p>এই database view-তে কোনো record পাওয়া যায়নি। ঐতিহাসিক archive বা অন্য view-এর তথ্য এখানে নিজে থেকে যোগ করা হয়নি।</p>}<button disabled={busy||!page.nextAfter} onClick={()=>void load(page.nextAfter??'')}>পরের records</button></>}
 <p role="status">{busy?'তথ্য পড়া হচ্ছে…':error}</p></section>;
}
