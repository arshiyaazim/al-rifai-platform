export class ConversationReadError extends Error {
  status:number;
  constructor(message:string, status=503){super(message);this.status=status;}
}
export type ConversationConfig = Record<string,string|undefined>;
export function conversationConnection(config:ConversationConfig){
  void config;
  return {configured:false,readOnly:true};
}
export function conversationQuery(input:URLSearchParams){
  const allowed=new Set(['phone','bridge','conversation_key','message','limit','mode']);
  if([...input.keys()].some(k=>!allowed.has(k))||[...allowed].some(k=>input.getAll(k).length>1))throw new ConversationReadError('Use the supported conversation filters once each.',400);
  const phone=(input.get('phone')??'').trim(),bridge=input.get('bridge')??'bridge1',key=input.get('conversation_key')??'',message=input.get('message')??'',limit=input.get('limit')??'12';
  if(!/^(?:\+?88)?01[3-9][0-9]{8}$/.test(phone))throw new ConversationReadError('Enter a complete WhatsApp number, for example 01XXXXXXXXX.',400);
  if(!['bridge1','bridge2','bridge3','meta'].includes(bridge)||key.length>255||message.length>1000||!/^\d+$/.test(limit)||Number(limit)<1||Number(limit)>30)throw new ConversationReadError('Use an existing bridge, bounded text and 1–30 history rows.',400);
  return new URLSearchParams({phone,bridge,conversation_key:key,message,limit});
}
export async function readConversation(config:ConversationConfig,query:URLSearchParams,fetcher:typeof fetch=fetch){
  if(!conversationConnection(config).configured)throw new ConversationReadError('Conversation Core is not connected. A verified HTTPS read endpoint and dedicated read bearer are required. The policy below is available offline.');
  let origin:URL;try{origin=new URL(config.FAZLE_CORE_CONVERSATION_URL!);}catch{throw new ConversationReadError('The configured conversation origin is invalid.');}
  if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||origin.hostname==='localhost'||/^[\d.:]+$/.test(origin.hostname)||origin.hostname.endsWith('.local'))throw new ConversationReadError('Configure a trusted Core HTTPS origin without a path or credentials.');
  const token=config.FAZLE_CONVERSATION_READ_BEARER!;
  if(token===config.FAZLE_CORE_READ_KEY||token===config.INTERNAL_API_KEY||token===config.HERMES_RUNNER_SECRET)throw new ConversationReadError('Use a separate conversation read bearer; existing operational credentials cannot be reused.');
  const url=new URL('/api/integration/v1/conversations/context',origin);url.search=query.toString();
  try{
    const response=await fetcher(url,{method:'GET',headers:{Authorization:'Bearer '+token,Accept:'application/json','Cache-Control':'no-store'},redirect:'manual',signal:AbortSignal.timeout(12000)});
    if(!response.ok)throw new ConversationReadError([401,403].includes(response.status)?'Core denied the conversation read credential.':'Core could not supply conversation context.',502);
    const reader=response.body?.getReader();if(!reader)throw new ConversationReadError('Core returned an empty response.',502);
    let length=0;const chunks:Uint8Array[]=[];
    while(true){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>250000){await reader.cancel();throw new ConversationReadError('Conversation context exceeds the read limit.',502);}chunks.push(part.value);}
    const bytes=new Uint8Array(length);let at=0;for(const part of chunks){bytes.set(part,at);at+=part.length;}
    const data=JSON.parse(new TextDecoder().decode(bytes));
    if(!data||data.read_only!==true||typeof data.checked_at!=='string'||!data.identity||!data.policy||data.policy.action_authority!=='none'||!data.policy.profile||!Array.isArray(data.policy.profile.data_scope)||!Array.isArray(data.policy.profile.impact)||!Array.isArray(data.policy.observed_roles)||!Array.isArray(data.canonical_roles)||!Array.isArray(data.history)||data.history.length>Number(query.get('limit'))||!Array.isArray(data.threads)||data.threads.length>20||data.threads.some((t:Record<string,unknown>)=>typeof t.conversation_key!=='string')||!Array.isArray(data.warnings)||data.warnings.some((s:unknown)=>typeof s!=='string')||data.bridge!==query.get('bridge')||data.conversation_key!==query.get('conversation_key'))throw new ConversationReadError('Core returned an incompatible or mismatched conversation scope.',502);
    const normalized=(s:string)=>s.replace(/^\+/, '').replace(/^01/,'8801');
    if(typeof data.phone!=='string'||normalized(data.phone)!==normalized(query.get('phone')!))throw new ConversationReadError('Core returned context for a different phone.',502);
    return data;
  }catch(error){if(error instanceof ConversationReadError)throw error;throw new ConversationReadError('Conversation context is unavailable. No messages or operational records were changed.',502);}
}
