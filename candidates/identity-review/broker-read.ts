import {deploymentProfile} from './deployment-profile.ts';
import {connect,type Socket} from 'node:net';
import {readFileSync,statSync} from 'node:fs';
/** Existing authenticated Unix MCP broker protocol. No service, bridge/store access or write tools.
 * Default off: fixed qualification or exact operator-selected profile; no live endpoint was enabled in this package. */
export class BrokerReadTransport{
 #peers=new Map<string,{socket:Socket;buffer:Buffer;next:number;pending:Map<number,{resolve:(v:unknown)=>void;reject:(e:Error)=>void}>;ready:Promise<void>}>();
 constructor(){if(process.env.ALRIFAI_INTEGRATION_QUALIFICATION!=='IR-01'&&!deploymentProfile())throw Error('BROKER_PROFILE_DISABLED');}
 close(){for(const p of this.#peers.values())p.socket.destroy();this.#peers.clear();}
 async call(account:string,name:string,args:Record<string,unknown>,signal:AbortSignal):Promise<unknown>{
  if(!['wa-01','wa-02'].includes(account)||!['get_native_account_identity','list_native_events','list_native_messages','get_stored_message_proofs','list_stored_messages','list_archive_messages'].includes(name)||Buffer.byteLength(JSON.stringify(args))>32000||signal.aborted)throw Error('BROKER_READ_DENIED');
  const peer=await this.#peer(account,signal);if(peer.pending.size)throw Error('BROKER_READ_BUSY');
  const result=await this.#rpc(peer,'tools/call',{name,arguments:args},signal) as {isError?:boolean;structuredContent?:unknown;content?:Array<{type:string;text?:string}>};
  if(result.isError){
   // Preserve only a bridge error code so a denied chat scope stays
   // distinguishable from an unavailable tool. Message content is never copied.
   const text=result.content?.find(item=>item.type==='text')?.text??'';
   const code=/\b([A-Z][A-Z0-9_]{3,80})\b/.exec(text)?.[1];
   throw Error(code??'BROKER_TOOL_UNAVAILABLE');
  }
  if(result.structuredContent!==undefined)return result.structuredContent;
  if(result.content?.length!==1||result.content[0].type!=='text'||!result.content[0].text)throw Error('BROKER_RESULT_INVALID');
  return JSON.parse(result.content[0].text);
 }
 async #peer(account:string,signal:AbortSignal){
  let peer=this.#peers.get(account);if(peer){await peer.ready;return peer;}
  const profile=deploymentProfile();if(profile&&!profile.broker[account])throw Error('BROKER_ACCOUNT_DENIED');
  const socketPath=profile?profile.broker[account].socket:'/qualification/disposable/broker/'+account+'.sock',tokenPath=profile?profile.broker[account].token:'/qualification/disposable/auth/'+account+'.token';
  if(!statSync(socketPath).isSocket()||statSync(tokenPath).size>512)throw Error('BROKER_CONFIG_UNAVAILABLE');
  const token=readFileSync(tokenPath,'utf8').trim();if(token.length<16||token.length>512||/[\r\n]/.test(token))throw Error('BROKER_CONFIG_INVALID');
  const socket=connect(socketPath);peer={socket,buffer:Buffer.alloc(0),next:1,pending:new Map(),ready:Promise.resolve()};const p=peer;
  const fail=()=>{for(const wait of p.pending.values())wait.reject(Error('BROKER_UNAVAILABLE'));p.pending.clear();socket.destroy();if(this.#peers.get(account)===p)this.#peers.delete(account);};
  socket.on('error',fail);socket.on('close',fail);socket.on('data',(chunk:Buffer)=>{
   p.buffer=Buffer.concat([p.buffer,chunk]);if(p.buffer.length>250000)return fail();
   for(let end=p.buffer.indexOf(10);end>=0;end=p.buffer.indexOf(10)){
    const line=p.buffer.subarray(0,end);p.buffer=p.buffer.subarray(end+1);
    try{const message=JSON.parse(line.toString());if(message.id===undefined){if(message.method&&!message.result)continue;return fail();}const wait=p.pending.get(message.id);if(!wait)return fail();p.pending.delete(message.id);if(message.error)wait.reject(Error('BROKER_RPC_DENIED'));else wait.resolve(message.result);}catch{fail();}
   }
  });this.#peers.set(account,p);
  p.ready=(async()=>{socket.write(token+'\n');const initialize=await this.#rpc(p,'initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'alrifai-scoped-native-reader',version:'1'}},signal) as {protocolVersion?:string};if(!initialize.protocolVersion)throw Error('BROKER_PROTOCOL_INVALID');socket.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');})();
  try{await p.ready;return p;}catch{fail();throw Error('BROKER_INITIALIZE_FAILED');}
 }
 #rpc(peer:{socket:Socket;next:number;pending:Map<number,{resolve:(v:unknown)=>void;reject:(e:Error)=>void}>},method:string,params:unknown,signal:AbortSignal):Promise<unknown>{
  if(signal.aborted)return Promise.reject(Error('BROKER_ABORTED'));
  const id=peer.next++;return new Promise((resolve,reject)=>{const abort=()=>{peer.pending.delete(id);peer.socket.destroy();reject(Error('BROKER_ABORTED'));};signal.addEventListener('abort',abort,{once:true});peer.pending.set(id,{resolve:value=>{signal.removeEventListener('abort',abort);resolve(value);},reject:error=>{signal.removeEventListener('abort',abort);reject(error);}});peer.socket.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 }
}
