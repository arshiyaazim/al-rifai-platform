'use client';
import {useEffect,useRef,useState} from 'react';
import {domains} from '../catalog';
import type {ReviewItemV1} from '../contracts';
type Subject={personId:string;name:string;phone:string;chatJid:string;cursor:string|null};
type Source={references:Array<Record<string,unknown>>;content:string|null;visibility:string};
type Message={review:ReviewItemV1;source:Source;name:string;phone:string;time:number|null};
export function messageTime(value:unknown):number|null{
 if(typeof value!=='number'&&typeof value!=='string')return null;
 const numeric=typeof value==='number'?value:/^\d+(\.\d+)?$/.test(value)?Number(value):null;
 const time=numeric===null?Date.parse(String(value)):numeric<100000000000?numeric*1000:numeric;
 return Number.isFinite(time)&&time>=946684800000&&time<4102444800000?time:null;
}
export function isOriginalMessage(item:ReviewItemV1,source:Source):boolean{
 return source.visibility==='VISIBLE'&&typeof source.content==='string'&&source.content.trim().length>0&&source.references.some(r=>r.accountId===item.accountId&&r.chatJid===item.chatJid&&typeof r.messageId==='string'&&r.messageId.length>0&&typeof r.senderJid==='string'&&r.senderJid.length>0);
}
export default function MessageInbox({apiBase,csrf,account,onSessionExpired}:{apiBase:string;csrf:string;account:string;onSessionExpired:()=>void}){
 const [messages,setMessages]=useState<Message[]>([]),[subjects,setSubjects]=useState<Subject[]>([]),[selected,setSelected]=useState<Message|null>(null),[person,setPerson]=useState(''),[query,setQuery]=useState(''),[offset,setOffset]=useState(0),[hasNext,setHasNext]=useState(false),[busy,setBusy]=useState(true),[reading,setReading]=useState(false),[pulling,setPulling]=useState(false),[reload,setReload]=useState(0),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const generation=useRef({value:0}),selection=useRef({value:0}),expire=useRef(onSessionExpired);useEffect(()=>{expire.current=onSessionExpired;},[onSessionExpired]);
 const requestScope=JSON.stringify([apiBase,account,offset,reload]);const [priorScope,setPriorScope]=useState(requestScope);if(priorScope!==requestScope){setPriorScope(requestScope);setMessages([]);setSubjects([]);setSelected(null);setHasNext(false);setReading(false);setError('');setBusy(true);}
 useEffect(()=>{const generationCell=generation.current;const selectionCell=selection.current;
  const epoch=++generationCell.value,controller=new AbortController();let live=true;
  selectionCell.value++;
  async function get(path:string){
   const response=await fetch(apiBase+path,{credentials:'same-origin',cache:'no-store',signal:controller.signal});
   if(!live||epoch!==generationCell.value)throw Error('STALE');
   if(response.status===401){expire.current();throw Error('আবার লগইন করুন।');}
   return response;
  }
  void (async()=>{try{
   const peopleResponse=await get('/conversations/subjects?accountId='+encodeURIComponent(account));
   if(!peopleResponse.ok)throw Error('এই অ্যাকাউন্টের মেসেজ দেখার অনুমতি পাওয়া যায়নি।');
   const people=(await peopleResponse.json()).subjects as Subject[];
   const reviews:ReviewItemV1[]=[];let next=false,partial=false;
   for(const domain of domains){
    const response=await get(`/reviews?accountId=${encodeURIComponent(account)}&domain=${domain}&offset=${offset}`);
    if(response.status===403)continue;
    if(!response.ok){partial=true;continue;}
    const page=await response.json();reviews.push(...page.items);next=next||page.nextOffset!==null;
   }
   const original:Message[]=[],seen=new Set<string>();
   for(const item of reviews){
    const response=await get('/reviews/'+item.id+'/source?content=1');
    if(response.status===403||response.status===404)continue;
    if(!response.ok){partial=true;continue;}
    const source=await response.json() as Source;
    if(!isOriginalMessage(item,source))continue;
    const key=item.sourceOccurrenceId||item.id;if(seen.has(key))continue;seen.add(key);
    const sender=people.find(p=>p.chatJid===item.chatJid);
    const reference=source.references.find(r=>r.messageId&&r.accountId===account&&r.chatJid===item.chatJid);
    original.push({review:item,source,name:sender?.name??'নাম যাচাই করা হয়নি',phone:sender?.phone??'',time:messageTime(reference?.sourceTime)});
   }
   if(!live)return;
   original.sort((a,b)=>(b.time??0)-(a.time??0));setMessages(original);setSubjects(people);setHasNext(next);
   if(partial)setError('কিছু মেসেজ আনা যায়নি। আবার হালনাগাদ করুন।');
  }catch(e){if(live&&epoch===generationCell.value)setError(e instanceof Error?e.message:'মেসেজ আনা যায়নি।');}
   finally{if(live&&epoch===generationCell.value)setBusy(false);}
  })();
  return()=>{live=false;generationCell.value++;selectionCell.value++;controller.abort();};
 },[apiBase,account,offset,reload]);
 async function open(message:Message){
  const epoch=generation.current.value,id=++selection.current.value;setSelected(null);setReading(true);setError('');
  try{
   const response=await fetch(apiBase+'/reviews/'+message.review.id+'/source?content=1',{credentials:'same-origin',cache:'no-store'});
   if(epoch!==generation.current.value||id!==selection.current.value)return;
   if(response.status===401){expire.current();return;}
   if(!response.ok){setMessages(list=>list.filter(m=>m.review.id!==message.review.id));throw Error('মেসেজটি বর্তমানে পড়া যাচ্ছে না। অনুমতি বা উৎস বদলে থাকতে পারে।');}
   const source=await response.json() as Source;
   if(epoch!==generation.current.value||id!==selection.current.value)return;
   if(!isOriginalMessage(message.review,source)){setMessages(list=>list.filter(m=>m.review.id!==message.review.id));throw Error('মূল মেসেজটি বর্তমানে পাওয়া যাচ্ছে না।');}
   setSelected({...message,source});
  }catch(e){if(epoch===generation.current.value&&id===selection.current.value)setError(e instanceof Error?e.message:'মেসেজ খোলা যায়নি।');}
  finally{if(epoch===generation.current.value&&id===selection.current.value)setReading(false);}
 }
 async function pull(){
  const epoch=generation.current.value;setPulling(true);setError('');setNotice('');setSelected(null);selection.current.value++;
  const choices=subjects.filter(p=>!person||p.personId===person);let events=0,failed=0;
  try{
   for(const subject of choices){
    const response=await fetch(apiBase+'/intake/pull',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({accountId:account,chatJid:subject.chatJid,cursor:subject.cursor})});
    if(epoch!==generation.current.value)return;
    if(response.status===401){expire.current();return;}
    if(!response.ok){failed++;continue;}
    const result=await response.json();if(epoch!==generation.current.value)return;
    events+=result.results.length;
   }
   if(epoch!==generation.current.value)return;
   setNotice(failed?'কিছু ব্যক্তির নতুন মেসেজ আনা যায়নি। আগে পাওয়া মেসেজ আবার দেখানো হচ্ছে।':events?'নতুন তথ্য যাচাই হয়েছে। মেসেজের তালিকা হালনাগাদ হচ্ছে।':'নতুন মেসেজ পাওয়া যায়নি। আগে পাওয়া মেসেজ তালিকায় থাকবে।');
   setOffset(0);setReload(v=>v+1);
  }catch{if(epoch===generation.current.value)setError('নতুন মেসেজ আনা যায়নি। আবার চেষ্টা করুন।');}
  finally{setPulling(false);}
 }
 const people=[...new Map(subjects.map(p=>[p.personId,p])).values()];
 const filtered=messages.filter(m=>(!person||subjects.some(s=>s.personId===person&&s.chatJid===m.review.chatJid))&&[m.name,m.phone,m.source.content].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
 const format=(time:number|null)=>time===null?'সময় পাওয়া যায়নি':new Date(time).toLocaleString('bn-BD',{timeZone:'Asia/Dhaka'});
 return <section aria-label="WhatsApp মেসেজ" className="inbox">
  <div className="section-title"><div><h2>আপনার কাছে আসা মেসেজ</h2><p>প্রেরক বেছে নিন অথবা একটি মেসেজ খুলে পড়ুন।</p></div><button disabled={busy||pulling} onClick={()=>{setNotice('');setReload(v=>v+1);}}>তালিকা হালনাগাদ</button></div>
  <div className="toolbar"><label>প্রেরক<select aria-label="Message sender" value={person} disabled={pulling} onChange={e=>{setPerson(e.target.value);setSelected(null);setReading(false);selection.current.value++;}}><option value="">সব অনুমোদিত ব্যক্তি</option>{people.map(p=><option key={p.personId} value={p.personId}>{p.name}</option>)}</select></label><label>মেসেজ খুঁজুন<input aria-label="Search messages" value={query} onChange={e=>setQuery(e.target.value)} placeholder="নাম, নম্বর বা মেসেজের কথা"/></label><button className="primary" disabled={busy||pulling||subjects.length===0} onClick={()=>void pull()}>{pulling?'নতুন মেসেজ আনা হচ্ছে…':'নতুন মেসেজ আনুন'}</button></div>
  <p className="muted">শুধু অনুমোদিত ব্যক্তিদের মূল WhatsApp মেসেজ এখানে দেখানো হয়। নিজে লেখা অনুরোধ আলাদা।</p>
  <p role="status" className="status">{busy?'মেসেজ আনা হচ্ছে…':notice||`এই পাতায় ${filtered.length}টি মেসেজ`}</p>{error&&<p role="alert">{error}</p>}
  {!busy&&!filtered.length&&<div className="empty">{messages.length?'এই খোঁজের সঙ্গে মেলে এমন মেসেজ পাওয়া যায়নি।':'এখন দেখানোর মতো অনুমোদিত WhatsApp মেসেজ পাওয়া যায়নি। নতুন মেসেজ আনুন অথবা পরে আবার দেখুন।'}</div>}
  <div className="inbox-grid"><div><ul aria-label="Message list">{filtered.map(m=><li key={m.review.id}><button className="message-row" disabled={busy||pulling} aria-pressed={selected?.review.id===m.review.id} onClick={()=>void open(m)}><strong>{m.name}</strong><span className="muted">{format(m.time)}</span><span className="preview">{m.source.content!.slice(0,180)}</span></button></li>)}</ul><div className="pager"><button disabled={busy||pulling||offset===0} onClick={()=>setOffset(v=>Math.max(0,v-25))}>আগের মেসেজ</button><button disabled={busy||pulling||!hasNext} onClick={()=>setOffset(v=>v+25)}>আরও মেসেজ</button></div></div>
   <article className="message-detail" aria-label="মেসেজের বিস্তারিত">{reading?<p>মেসেজ খোলা হচ্ছে…</p>:selected?<><h3>{selected.name}</h3>{selected.phone&&<p>{selected.phone}</p>}<p className="muted">{format(selected.time)} · বাংলাদেশ সময়</p><div className="message-body" data-testid="inbox-message-content">{selected.source.content}</div><div className="next-step"><strong>এরপর কী করবেন?</strong><p>অনুরোধটি পড়ে তথ্য মিলিয়ে নিন। ফোনে বা সরাসরি পাওয়া কাজ লিখতে “নতুন অনুরোধ লিখুন” ব্যবহার করুন। অর্ডার অনুমোদন ও ডিউটি দেওয়ার পূর্ণ ধাপ এখনও যুক্ত হয়নি।</p></div></>:<div className="empty">তালিকা থেকে একটি মেসেজ খুলুন। এখানে প্রেরক, সময় ও মূল লেখা দেখতে পাবেন।</div>}</article>
  </div>
 </section>;
}
