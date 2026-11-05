'use client';
import {useEffect,useState} from 'react';
type Props={apiBase:string;account:string;csrf:string;onSessionExpired:()=>void};
export default function CashEntry(props:Parameters<typeof CashEntryScope>[0]){return <CashEntryScope key={JSON.stringify([props.apiBase,props.account])} {...props}/>;}
function CashEntryScope({apiBase,account,csrf,onSessionExpired}:Props){
 const [access,setAccess]=useState<{create:boolean;post:boolean;reverse:boolean}|null>(null),[result,setResult]=useState(''),[busy,setBusy]=useState(false);
 const [operationId,setOperation]=useState(()=>crypto.randomUUID());
 useEffect(()=>{const controller=new AbortController();void fetch(apiBase+'/business/cash/access',{credentials:'same-origin',cache:'no-store',signal:controller.signal}).then(async r=>{if(controller.signal.aborted)return;if(r.status===401){onSessionExpired();return;}if(!r.ok)throw Error();const data=await r.json();if(!controller.signal.aborted)setAccess(data);}).catch(()=>{if(!controller.signal.aborted)setResult('Entry permission যাচাই করা যায়নি।');});return()=>controller.abort();},[apiBase,account,onSessionExpired]);
 if(!access)return <p role="status">Permission যাচাই হচ্ছে… {result}</p>;
 if(!access.create)return <p>বর্তমান role/scope-এ manual cash entry অনুমতি নেই।</p>;
 return <form onSubmit={async e=>{e.preventDefault();setBusy(true);setResult('');const values=Object.fromEntries(new FormData(e.currentTarget));if(!values.reversesId)delete values.reversesId;try{const r=await fetch(apiBase+'/business/cash/entries',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({...values,accountId:account,operationId,at:new Date(String(values.at)+'+06:00').toISOString()})});if(r.status===401){onSessionExpired();return;}const d=await r.json();if(!r.ok)throw Error('Entry সংরক্ষণ হয়নি। তথ্য ও অনুমতি যাচাই করুন। একই entry আবার চেষ্টা করলে duplicate হবে না।');setResult(d.posted?'হিসাবে পোস্ট হয়েছে। External transfer প্রমাণ আলাদা।':'Entry সংরক্ষিত: '+d.state+'. এখনও posted নয়।');setOperation(crypto.randomUUID());}catch(e){setResult(e instanceof Error?e.message:'Entry সংরক্ষণ হয়নি।');}finally{setBusy(false);}}}>
 <p>{access.post?'বৈধ Admin entry একবার submit করলেই একই writer-এ পোস্ট হবে।':'Posting সক্রিয় নয় অথবা বর্তমান role-এ অনুমতি নেই। Entry pending থাকবে।'}</p>
 {([['employeeMobile','Employee mobile ID'],['employeeName','Employee name'],['payoutMobile','Distinct payout mobile'],['purpose','Purpose'],['amount','BDT amount'],['cashAccount','Cash account reference']] as const).map(([name,label])=><label key={name}>{label}<input name={name} required={name!=='payoutMobile'} maxLength={name==='purpose'?500:150}/></label>)}
 <label>Method<select name="method">{['cash','bkash','nagad','bank','rocket'].map(v=><option key={v}>{v}</option>)}</select></label><label>Date/time · Asia/Dhaka<input type="datetime-local" name="at" required/></label>
 {access.reverse&&<label>Reversal of posting · exact reference (optional)<input name="reversesId" pattern="[a-f0-9]{64}" onChange={e=>{if(!e.target.value)e.target.removeAttribute('name');else e.target.name='reversesId';}}/></label>}
 <button disabled={busy}>{busy?'সংরক্ষণ হচ্ছে…':access.post?'Record and post / এন্ট্রি ও পোস্ট':'Save pending entry / সংরক্ষণ'}</button><p role="status">{result}</p></form>;
}
