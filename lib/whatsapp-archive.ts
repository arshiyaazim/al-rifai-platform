import {createHash} from "node:crypto";
import {CASH_SCOPE_CHATS} from "./cash-scope.ts";
import {
  OWNER_ESCORT_CLIENTS,
  classifyBusinessSource,
} from "./escort-register.mjs";

export type ArchiveVisibility = "VISIBLE" | "REVOKED" | "SUPPRESSED" | "UNKNOWN";
export type ArchiveMedia = {
  type:string|null;
  filename:string|null;
  contentHash:string|null;
  byteLength:number|null;
  storedFileRef:string|null;
};
export type ArchiveMessage = {
  accountId:string;
  chatJid:string;
  id:string;
  sender:string;
  senderPhone?:string|null;
  senderPushName?:string|null;
  contactName?:string|null;
  groupName?:string|null;
  sourceTimestamp:string|null;
  text:string;
  direction:"INCOMING"|"OUTGOING";
  deletedAt:string|null;
  messageType:string;
  quotedMessageId:string|null;
  media:ArchiveMedia|null;
};
export type ArchiveRecord = {
  rowid:string;
  messageId:string;
  state:ArchiveVisibility;
  deletedAt:string|null;
  sourceHash:string|null;
  message:ArchiveMessage|null;
};
export type ArchivePage = {
  version:"archive-history-page-v1";
  accountId:string;
  nativeScope:Record<string,unknown>;
  chatJid:string;
  previousAfter:string;
  nextAfter:string;
  complete:boolean;
  records:ArchiveRecord[];
};

type QueryClient = {
  query(sql:string, values?:unknown[]):Promise<{rows?:Array<Record<string,unknown>>}>;
  release():void;
};
export type ArchivePool = {connect():Promise<QueryClient>};
type SourceRoute = {domain:"cash"|"vessel"|null;outcome:string};
type SourceRoutingPolicy = {
  contacts:Array<Record<string,unknown>>;
  aliases:Record<string,string>;
  groupAuthorizations:Array<Record<string,unknown>>;
};
export type CompatibilityMessage = {
  accountId:string;
  chatJid:string;
  messageId:string;
  senderJid:string|null;
  senderPhone:string|null;
  senderPushName:string|null;
  receiverJid:string|null;
  receiverPhone:string|null;
  contactName:string|null;
  groupName:string|null;
  sourceTimestamp:string;
  direction:"INCOMING"|"OUTGOING";
  messageType:string;
  text:string|null;
  mediaRef:string|null;
  rawContent:Record<string,unknown>;
};

export async function routeMirroredMessage(
  client:QueryClient,
  message:CompatibilityMessage,
):Promise<boolean>{
  if(message.accountId!=="wa-01"||!message.messageId||!message.chatJid
    ||!message.sourceTimestamp||!Number.isFinite(Date.parse(message.sourceTimestamp))
    ||(message.direction!=="INCOMING"&&message.direction!=="OUTGOING")
    ||!message.rawContent||typeof message.rawContent!=="object"||Array.isArray(message.rawContent)){
    throw new Error("Mirror domain-routing source is invalid.");
  }
  const inserted=await client.query(
    `INSERT INTO public.whatsapp_messages_original
     (wa_account,chat_jid,chat_type,message_id,direction,sender_jid,sender_phone,
      sender_push_name,receiver_jid,receiver_phone,group_name,"timestamp",message_type,
      raw_content,text_content,media_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz,$13,$14::jsonb,$15,$16)
     ON CONFLICT (wa_account,chat_jid,message_id) DO NOTHING
     RETURNING id`,
    [message.accountId,message.chatJid,message.chatJid.endsWith("@g.us")?"group":"individual",
      message.messageId,message.direction==="OUTGOING"?"outgoing":"incoming",
      message.senderJid,message.senderPhone??transportPhone(message.senderJid),
      message.senderPushName,message.receiverJid,message.receiverPhone??transportPhone(message.receiverJid),
      message.groupName,message.sourceTimestamp,message.messageType,
      JSON.stringify(message.rawContent),message.text,message.mediaRef],
  );
  const originalId=inserted.rows?.[0]?.id;
  if(originalId===undefined)return false;

  const sourcePolicy=await loadSourceRoutingPolicy(client,message.accountId);
  const route=routeSource(message.accountId,{
    id:message.messageId,chatJid:message.chatJid,senderJid:message.senderJid,
    senderPhone:message.senderPhone,direction:message.direction,
  },sourcePolicy);
  if(route.domain){
    await client.query(
      `INSERT INTO public.whatsapp_messages_processing (original_id,domain,status)
       VALUES ($1,$2,'pending')
       ON CONFLICT (original_id,domain) DO NOTHING`,
      [originalId,route.domain],
    );
  }
  return true;
}

const hashPattern=/^[a-f0-9]{64}$/;
const cursorPattern=/^(0|[1-9][0-9]{0,18})$/;
const int64Max=9223372036854775807n;
const isObject=(value:unknown):value is Record<string,unknown> =>
  typeof value==="object"&&value!==null&&!Array.isArray(value);
const isOptionalString=(value:unknown):value is string|null =>
  value===null||typeof value==="string";
const isVisibility=(value:unknown):value is ArchiveVisibility =>
  value==="VISIBLE"||value==="REVOKED"||value==="SUPPRESSED"||value==="UNKNOWN";
const transportPhone=(jid:string|null|undefined):string|null=>{
  const match=typeof jid==="string"?/^([0-9]{1,30})(?::[0-9]+)?@s\.whatsapp\.net$/.exec(jid):null;
  return match?.[1]??null;
};
const sourceDigest=(value:unknown):string=>createHash("sha256").update(canonicalJson(value)).digest("hex");
const ownerContactPhones=new Map(OWNER_ESCORT_CLIENTS.map(contact=>[contact.id,contact.phone]));

function canonicalJson(value:unknown):string{
  if(Array.isArray(value))return `[${value.map(canonicalJson).join(",")}]`;
  if(isObject(value)){
    const entries=Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonicalJson(value[k])}`);
    return `{${entries.join(",")}}`;
  }
  const result=JSON.stringify(value);
  if(result===undefined)throw new Error("Archive message contains a non-JSON value.");
  return result;
}

async function insertProcessingMarkers(
  client:QueryClient,
  originalId:unknown,
  observedAt:string,
  sourceMode:"archive"|"compatibility",
  accountId:string,
  route:SourceRoute,
):Promise<void>{
  await client.query(
    `INSERT INTO public.whatsapp_messages_processing
     (original_id,domain,status,processed_content,processed_at)
     VALUES ($1,'archive','processed',
              jsonb_build_object('version','immutable-original-archive-v1','sourceMode',$3::text,'domainRouting',$4::text),
              $2::timestamptz)
     ON CONFLICT (original_id,domain) DO NOTHING`,
    [originalId,observedAt,sourceMode,route.outcome],
  );
  if(accountId==="wa-01"&&route.domain){
    await client.query(
      `INSERT INTO public.whatsapp_messages_processing
       (original_id,domain,status,processed_content,processed_at)
       VALUES ($1,$2,'pending',NULL,NULL)
       ON CONFLICT (original_id,domain) DO NOTHING`,
      [originalId,route.domain],
    );
  }
}

async function loadSourceRoutingPolicy(client:QueryClient,accountId:string):Promise<SourceRoutingPolicy>{
  if(accountId!=="wa-01")return {contacts:[],aliases:{},groupAuthorizations:[]};
  const availability=await client.query(
    `SELECT to_regclass('public.escort_client_contacts') IS NOT NULL AS escort_contacts,
            to_regclass('public.whatsapp_contacts') IS NOT NULL AS whatsapp_contacts,
            to_regclass('public.escort_client_group_authorizations') IS NOT NULL AS group_authorizations`,
  );
  const tables=availability.rows?.[0]??{};
  const contactsResult=tables.escort_contacts===true
    ?await client.query(
      "SELECT id,account_id,phone,active FROM public.escort_client_contacts WHERE account_id='wa-01' AND active=true",
    )
    :{rows:[]};
  const contacts=(contactsResult.rows??[]).filter(contact=>
    contact.account_id==="wa-01"&&contact.active===true
      &&ownerContactPhones.get(String(contact.id))===contact.phone,
  );
  const aliasResult=tables.whatsapp_contacts===true
    ?await client.query(
      "SELECT phone_number,jid FROM public.whatsapp_contacts WHERE wa_account='wa-01'",
    )
    :{rows:[]};
  const aliasCandidates=new Map<string,Set<string>>();
  for(const row of aliasResult.rows??[]){
    if(typeof row.jid!=="string"||typeof row.phone_number!=="string")continue;
    const key=row.jid.split("@")[0];
    if(!key)continue;
    const candidates=aliasCandidates.get(key)??new Set<string>();
    candidates.add(row.phone_number);
    aliasCandidates.set(key,candidates);
  }
  const aliases=Object.fromEntries(
    [...aliasCandidates].filter(([,values])=>values.size===1).map(([key,values])=>[key,[...values][0]]),
  );
  const groupResult=tables.group_authorizations===true
    ?await client.query(
      "SELECT account_id,group_jid,participant_jid,client_contact_id,active FROM public.escort_client_group_authorizations WHERE account_id='wa-01' AND active=true",
    )
    :{rows:[]};
  const activeContactIds=new Set(contacts.map(contact=>String(contact.id)));
  const groupAuthorizations=(groupResult.rows??[]).filter(authorization=>
    authorization.account_id==="wa-01"&&authorization.active===true
      &&activeContactIds.has(String(authorization.client_contact_id)),
  );
  return {contacts,aliases,groupAuthorizations};
}

function routeSource(
  accountId:string,
  message:{
    id:string;
    chatJid:string;
    senderJid:string|null;
    senderPhone:string|null;
    direction:"INCOMING"|"OUTGOING";
  },
  policy:SourceRoutingPolicy,
):SourceRoute{
  const sourceMessage={
    accountId,id:message.id,chatJid:message.chatJid,text:"",
    direction:message.direction,sender:message.senderJid??"",
    nativeSenderJid:message.senderJid,senderPhoneTransport:message.senderPhone,
  };
  return classifyBusinessSource(
    {accountId},sourceMessage,policy.contacts,policy.aliases,
    policy.groupAuthorizations,[...CASH_SCOPE_CHATS],
  ) as SourceRoute;
}

function isArchiveMedia(value:unknown):value is ArchiveMedia{
  if(!isObject(value))return false;
  return isOptionalString(value.type)&&isOptionalString(value.filename)
    &&isOptionalString(value.contentHash)
    &&(value.contentHash===null||hashPattern.test(value.contentHash))
    &&(value.byteLength===null||(typeof value.byteLength==="number"
      &&Number.isSafeInteger(value.byteLength)&&value.byteLength>=0))
    &&isOptionalString(value.storedFileRef);
}

function isArchiveMessage(value:unknown):value is ArchiveMessage{
  if(!isObject(value))return false;
  return typeof value.accountId==="string"&&typeof value.chatJid==="string"
    &&typeof value.id==="string"&&typeof value.sender==="string"
    &&(value.senderPhone===undefined||isOptionalString(value.senderPhone))
    &&(value.senderPushName===undefined||isOptionalString(value.senderPushName))
    &&(value.contactName===undefined||isOptionalString(value.contactName))
    &&(value.groupName===undefined||isOptionalString(value.groupName))
    &&isOptionalString(value.sourceTimestamp)&&typeof value.text==="string"
    &&(value.direction==="INCOMING"||value.direction==="OUTGOING")
    &&isOptionalString(value.deletedAt)&&typeof value.messageType==="string"
    &&isOptionalString(value.quotedMessageId)
    &&(value.media===null||isArchiveMedia(value.media));
}

function isArchiveRecord(value:unknown):value is ArchiveRecord{
  return isObject(value)&&typeof value.rowid==="string"&&typeof value.messageId==="string"
    &&isVisibility(value.state)&&isOptionalString(value.deletedAt)
    &&(value.state==="REVOKED"||value.deletedAt===null)&&(value.sourceHash===null
      ||(typeof value.sourceHash==="string"&&hashPattern.test(value.sourceHash)))
    &&(value.message===null||isArchiveMessage(value.message));
}

function isArchivePage(value:unknown):value is ArchivePage{
  return isObject(value)&&value.version==="archive-history-page-v1"
    &&typeof value.accountId==="string"&&isObject(value.nativeScope)
    &&typeof value.chatJid==="string"&&typeof value.previousAfter==="string"
    &&typeof value.nextAfter==="string"&&typeof value.complete==="boolean"
    &&Array.isArray(value.records)&&value.records.every(isArchiveRecord);
}

export function validateArchivePage(value:unknown,expected:{
  accountId:string;
  chatJid:string;
  nativeScope:Record<string,unknown>;
}):ArchivePage{
  if(!isArchivePage(value)
    ||value.accountId!==expected.accountId||value.chatJid!==expected.chatJid
    ||canonicalJson(value.nativeScope)!==canonicalJson(expected.nativeScope)
    ||!cursorPattern.test(value.previousAfter)||!cursorPattern.test(value.nextAfter)
    ||BigInt(value.previousAfter)>int64Max||BigInt(value.nextAfter)>int64Max
    ||value.records.length>10
    ||!/@(?:s\.whatsapp\.net|lid|g\.us)$/.test(value.chatJid)){
    throw new Error("Archive page scope or envelope is invalid.");
  }
  let last=BigInt(value.previousAfter);
  for(const item of value.records){
    if(!isObject(item)||typeof item.rowid!=="string"||!cursorPattern.test(item.rowid)
      ||BigInt(item.rowid)<=last||BigInt(item.rowid)>int64Max
      ||typeof item.messageId!=="string"||!item.messageId
      ||!isVisibility(item.state)){
      throw new Error("Archive page record is invalid or out of order.");
    }
    if(item.state==="VISIBLE"){
      if(item.deletedAt!==null||!isArchiveMessage(item.message)||item.message.accountId!==expected.accountId
        ||item.message.chatJid!==expected.chatJid||item.message.id!==item.messageId
        ||typeof item.sourceHash!=="string"
        ||createHash("sha256").update(canonicalJson(item.message)).digest("hex")!==item.sourceHash){
        throw new Error("Archive message scope or source hash is invalid.");
      }
    }else if(item.message!==null||item.sourceHash!==null){
      throw new Error("Non-visible archive records must not expose message content.");
    }
    last=BigInt(item.rowid);
  }
  const expectedNext=value.records.length?last.toString():value.previousAfter;
  if(value.nextAfter!==expectedNext||(!value.complete&&!value.records.length)){
    throw new Error("Archive page cursor is invalid.");
  }
  return value;
}

export async function ingestArchivePage(pool:ArchivePool,rawPage:unknown,expected:{
  accountId:string;
  chatJid:string;
  nativeScope:Record<string,unknown>;
},observedAt=new Date().toISOString()):Promise<{stored:number;nextAfter:string;complete:boolean}>{
  const page=validateArchivePage(rawPage,expected);
  const observedDate=new Date(observedAt);
  if(!Number.isFinite(observedDate.getTime()))throw new Error("Archive observation time is invalid.");
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const sourcePolicy=await loadSourceRoutingPolicy(client,page.accountId);
    const isGroup=page.chatJid.endsWith("@g.us");
    await client.query(
      `INSERT INTO public.whatsapp_archive_conversations
       (account_id,chat_jid,is_group,native_scope,first_seen_at,last_seen_at)
       VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz,$5::timestamptz)
       ON CONFLICT (account_id,chat_jid) DO UPDATE SET
       native_scope=EXCLUDED.native_scope,last_seen_at=EXCLUDED.last_seen_at`,
      [page.accountId,page.chatJid,isGroup,JSON.stringify(page.nativeScope),observedAt],
    );
    await client.query(
      `INSERT INTO public.whatsapp_archive_sync_state
       (account_id,chat_jid,after_rowid,complete,last_observed_at)
       VALUES ($1,$2,0,false,$3::timestamptz)
       ON CONFLICT (account_id,chat_jid) DO NOTHING`,
      [page.accountId,page.chatJid,observedAt],
    );
    const checkpoint=await client.query(
      `SELECT after_rowid::text AS after_rowid
       FROM public.whatsapp_archive_sync_state
       WHERE account_id=$1 AND chat_jid=$2 FOR UPDATE`,
      [page.accountId,page.chatJid],
    );
    const currentAfter=(checkpoint.rows?.[0] as {after_rowid?:unknown}|undefined)?.after_rowid;
    if(typeof currentAfter!=="string")throw new Error("Archive checkpoint could not be read.");
    if(page.previousAfter!==currentAfter
      &&BigInt(page.nextAfter)>BigInt(currentAfter)){
      throw new Error("Archive page does not continue from the stored checkpoint.");
    }
    for(const record of page.records){
      const message=record.message;
      await client.query(
        `INSERT INTO public.whatsapp_archive_messages
         (account_id,chat_jid,source_rowid,message_id,sender_id,direction,source_deleted_at_raw,
          source_timestamp_raw,message_type,body,visibility_state,source_hash,
          original_identifiers,source_provenance,first_ingested_at,last_observed_at)
         VALUES ($1,$2,$3::bigint,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,
          $15::timestamptz,$15::timestamptz)
         ON CONFLICT (account_id,chat_jid,message_id) DO UPDATE SET
          source_rowid=EXCLUDED.source_rowid,sender_id=EXCLUDED.sender_id,
          direction=EXCLUDED.direction,source_deleted_at_raw=EXCLUDED.source_deleted_at_raw,
          source_timestamp_raw=EXCLUDED.source_timestamp_raw,
          message_type=EXCLUDED.message_type,body=EXCLUDED.body,
          visibility_state=EXCLUDED.visibility_state,source_hash=EXCLUDED.source_hash,
          original_identifiers=EXCLUDED.original_identifiers,
          source_provenance=EXCLUDED.source_provenance,
          last_observed_at=EXCLUDED.last_observed_at`,
        [
          page.accountId,page.chatJid,record.rowid,record.messageId,message?.sender??null,
          message?.direction??null,record.deletedAt,message?.sourceTimestamp??null,message?.messageType??null,
          record.state==="VISIBLE"?message?.text??"":null,record.state,record.sourceHash,
          JSON.stringify({
            messageId:record.messageId,chatJid:page.chatJid,
            sender:message?.sender??null,quotedMessageId:message?.quotedMessageId??null,
          }),
          JSON.stringify({provider:"whatsapp-mcp",tool:"list_archive_messages",nativeScope:page.nativeScope,rowid:record.rowid}),
          observedAt,
        ],
      );
      const revisionHash=record.sourceHash??sourceDigest({
        accountId:page.accountId,chatJid:page.chatJid,messageId:record.messageId,
        rowid:record.rowid,state:record.state,deletedAt:record.deletedAt,
      });
      await client.query(
        `INSERT INTO public.whatsapp_message_source_events
         (wa_account,chat_jid,message_id,revision_hash,source_mode,source_rowid,
          source_event,raw_content,observed_at)
         VALUES ($1,$2,$3,$4,'archive',$5::bigint,$6,$7::jsonb,$8::timestamptz)
         ON CONFLICT (wa_account,chat_jid,message_id,revision_hash,source_mode) DO NOTHING`,
        [page.accountId,page.chatJid,record.messageId,revisionHash,record.rowid,
          record.state,JSON.stringify(record),observedAt],
      );
      if(record.state==="VISIBLE"&&message){
        if(!message.sourceTimestamp||!Number.isFinite(Date.parse(message.sourceTimestamp))){
          throw new Error("Visible archive message has no valid source timestamp.");
        }
        const senderJid=message.sender||null;
        const senderPhone=message.senderPhone??transportPhone(senderJid);
        const ownJid=typeof page.nativeScope.pairedJid==="string"?page.nativeScope.pairedJid:null;
        const receiverJid=page.chatJid.endsWith("@g.us")
          ?null:message.direction==="OUTGOING"?page.chatJid:ownJid;
        const senderPushName=message.senderPushName??null;
        const contactName=message.contactName??null;
        const groupName=page.chatJid.endsWith("@g.us")?message.groupName??null:null;
        const original=await client.query(
          `INSERT INTO public.whatsapp_messages_original
           (wa_account,chat_jid,chat_type,message_id,direction,sender_jid,sender_phone,
            sender_push_name,receiver_jid,receiver_phone,group_name,"timestamp",message_type,
            raw_content,text_content,media_ref)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz,$13,$14::jsonb,$15,$16)
           ON CONFLICT (wa_account,chat_jid,message_id) DO NOTHING
           RETURNING id`,
          [page.accountId,page.chatJid,page.chatJid.endsWith("@g.us")?"group":"individual",
            record.messageId,message.direction==="OUTGOING"?"outgoing":"incoming",senderJid,
            senderPhone,senderPushName,receiverJid,transportPhone(receiverJid),groupName,
            new Date(message.sourceTimestamp).toISOString(),message.messageType,
            JSON.stringify(record),message.text,message.media?.storedFileRef??null],
        );
        const originalId=original.rows?.[0]?.id??(await client.query(
          `SELECT id FROM public.whatsapp_messages_original
           WHERE wa_account=$1 AND chat_jid=$2 AND message_id=$3`,
          [page.accountId,page.chatJid,record.messageId],
        )).rows?.[0]?.id;
        if(originalId===undefined)throw new Error("Could not resolve the immutable original message row.");
        const route=routeSource(page.accountId,{
          id:message.id,chatJid:message.chatJid,senderJid:message.sender,
          senderPhone:message.senderPhone??senderPhone,direction:message.direction,
        },sourcePolicy);
        await insertProcessingMarkers(client,originalId,observedAt,"archive",page.accountId,route);
        if(senderJid&&senderPhone&&/^\+?[0-9]{8,30}$/.test(senderPhone)){
          await client.query(
            `INSERT INTO public.whatsapp_contacts
             (wa_account,phone_number,jid,push_name,contact_name,name_source,name_confidence,last_synced_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz)
             ON CONFLICT (wa_account,phone_number) DO UPDATE SET
              jid=EXCLUDED.jid,
              push_name=COALESCE(EXCLUDED.push_name,whatsapp_contacts.push_name),
              contact_name=COALESCE(EXCLUDED.contact_name,whatsapp_contacts.contact_name),
              name_source=COALESCE(EXCLUDED.name_source,whatsapp_contacts.name_source),
              name_confidence=COALESCE(EXCLUDED.name_confidence,whatsapp_contacts.name_confidence),
              last_synced_at=GREATEST(whatsapp_contacts.last_synced_at,EXCLUDED.last_synced_at)`,
            [page.accountId,senderPhone,senderJid,
              senderPushName,contactName,contactName?"SOURCE_CONTACT":senderPushName?"SOURCE_PUSH_NAME":"TRANSPORT_JID",
              contactName?"SOURCE_CONTACT":senderPushName?"SOURCE_PUSH_NAME":"TRANSPORT_JID",observedAt],
          );
        }
      }
      if(record.state==="VISIBLE"&&message?.media){
        await client.query(
          `INSERT INTO public.whatsapp_archive_media
           (account_id,chat_jid,message_id,media_ordinal,media_type,filename,
            content_hash,byte_length,stored_file_ref,acquired_at)
           VALUES ($1,$2,$3,0,$4,$5,$6,$7,$8,
            CASE WHEN $8::text IS NULL THEN NULL ELSE $9::timestamptz END)
           ON CONFLICT (account_id,chat_jid,message_id,media_ordinal) DO UPDATE SET
            media_type=EXCLUDED.media_type,filename=EXCLUDED.filename,
            content_hash=EXCLUDED.content_hash,byte_length=EXCLUDED.byte_length,
            stored_file_ref=CASE
              WHEN EXCLUDED.content_hash=whatsapp_archive_media.content_hash
              THEN COALESCE(EXCLUDED.stored_file_ref,whatsapp_archive_media.stored_file_ref)
              ELSE EXCLUDED.stored_file_ref END,
            acquired_at=CASE
              WHEN EXCLUDED.content_hash=whatsapp_archive_media.content_hash
              THEN COALESCE(EXCLUDED.acquired_at,whatsapp_archive_media.acquired_at)
              ELSE EXCLUDED.acquired_at END`,
          [page.accountId,page.chatJid,record.messageId,message.media.type,message.media.filename,
            message.media.contentHash,message.media.byteLength,message.media.storedFileRef,observedAt],
        );
      }else{
        await client.query(
          `DELETE FROM public.whatsapp_archive_media
           WHERE account_id=$1 AND chat_jid=$2 AND message_id=$3`,
          [page.accountId,page.chatJid,record.messageId],
        );
      }
    }
    await client.query(
      `INSERT INTO public.whatsapp_archive_sync_state
       (account_id,chat_jid,after_rowid,complete,last_observed_at)
       VALUES ($1,$2,$3::bigint,$4,$5::timestamptz)
       ON CONFLICT (account_id,chat_jid) DO UPDATE SET
        after_rowid=GREATEST(whatsapp_archive_sync_state.after_rowid,EXCLUDED.after_rowid),
        complete=CASE WHEN EXCLUDED.after_rowid>=whatsapp_archive_sync_state.after_rowid
          THEN EXCLUDED.complete ELSE whatsapp_archive_sync_state.complete END,
        last_observed_at=EXCLUDED.last_observed_at`,
      [page.accountId,page.chatJid,page.nextAfter,page.complete,observedAt],
    );
    await client.query(
      `INSERT INTO public.whatsapp_ingestion_cursors
       (account_id,chat_jid,source_mode,page_number,after_rowid,last_observed_at,last_error)
       VALUES ($1,$2,'archive',0,$3::bigint,$4::timestamptz,NULL)
       ON CONFLICT (account_id,chat_jid,source_mode) DO UPDATE SET
        after_rowid=GREATEST(whatsapp_ingestion_cursors.after_rowid,EXCLUDED.after_rowid),
        last_observed_at=EXCLUDED.last_observed_at,last_error=NULL`,
      [page.accountId,page.chatJid,page.nextAfter,observedAt],
    );
    await client.query("COMMIT");
    return {stored:page.records.length,nextAfter:page.nextAfter,complete:page.complete};
  }catch(error){
    try{await client.query("ROLLBACK");}
    catch(rollbackError){throw new AggregateError([error,rollbackError],"Archive page transaction and rollback both failed.");}
    throw error;
  }finally{
    client.release();
  }
}

export async function ingestCompatibilityPage(pool:ArchivePool,input:{
  accountId:"wa-01"|"wa-02";
  chatJid:string;
  pageNumber:number;
  pageSize:number;
  hasMore:boolean;
  records:CompatibilityMessage[];
  observedAt?:string;
}):Promise<{stored:number;nextPage:number}>{
  if(!/@(?:s\.whatsapp\.net|lid|g\.us)$/.test(input.chatJid)
    ||!Number.isSafeInteger(input.pageNumber)||input.pageNumber<0
    ||!Number.isSafeInteger(input.pageSize)||input.pageSize<1
    ||input.records.length>input.pageSize){
    throw new Error("Compatibility page scope or pagination is invalid.");
  }
  for(const record of input.records){
    if(record.accountId!==input.accountId||record.chatJid!==input.chatJid
      ||!record.messageId||!record.sourceTimestamp||!Number.isFinite(Date.parse(record.sourceTimestamp))
      ||(record.direction!=="INCOMING"&&record.direction!=="OUTGOING")
      ||!record.rawContent||typeof record.rawContent!=="object"||Array.isArray(record.rawContent)){
      throw new Error("Compatibility message scope or envelope is invalid.");
    }
  }
  const observedAt=input.observedAt??new Date().toISOString();
  if(!Number.isFinite(Date.parse(observedAt)))throw new Error("Compatibility observation time is invalid.");
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const sourcePolicy=await loadSourceRoutingPolicy(client,input.accountId);
    await client.query(
      `INSERT INTO public.whatsapp_archive_conversations
       (account_id,chat_jid,is_group,native_scope,first_seen_at,last_seen_at)
       VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz,$5::timestamptz)
       ON CONFLICT (account_id,chat_jid) DO UPDATE SET
        native_scope=EXCLUDED.native_scope,last_seen_at=EXCLUDED.last_seen_at`,
      [input.accountId,input.chatJid,input.chatJid.endsWith("@g.us"),
        JSON.stringify({sourceMode:"compatibility",provider:"whatsapp-mcp",tool:"list_messages"}),
        observedAt],
    );
    await client.query(
      `INSERT INTO public.whatsapp_ingestion_cursors
       (account_id,chat_jid,source_mode,page_number,after_rowid,last_observed_at)
       VALUES ($1,$2,'compatibility',0,0,$3::timestamptz)
       ON CONFLICT (account_id,chat_jid,source_mode) DO NOTHING`,
      [input.accountId,input.chatJid,observedAt],
    );
    const checkpoint=await client.query(
      `SELECT page_number FROM public.whatsapp_ingestion_cursors
       WHERE account_id=$1 AND chat_jid=$2 AND source_mode='compatibility'
       FOR UPDATE`,
      [input.accountId,input.chatJid],
    );
    const currentPage=(checkpoint.rows?.[0] as {page_number?:unknown}|undefined)?.page_number;
    if(currentPage!==input.pageNumber)throw new Error("Compatibility page does not continue from the stored checkpoint.");
    let stored=0;
    for(const message of input.records){
      const revisionHash=sourceDigest(message.rawContent);
      const rawMessage=message.rawContent.message;
      const messageDetails=isObject(rawMessage)?rawMessage:message.rawContent;
      const sourceEvent=messageDetails.deletedAt!==undefined&&messageDetails.deletedAt!==null
        ||messageDetails.is_deleted===true||messageDetails.deleted===true?"REVOKED":"MESSAGE";
      await client.query(
        `INSERT INTO public.whatsapp_message_source_events
         (wa_account,chat_jid,message_id,revision_hash,source_mode,source_event,raw_content,observed_at)
         VALUES ($1,$2,$3,$4,'compatibility',$5,$6::jsonb,$7::timestamptz)
         ON CONFLICT (wa_account,chat_jid,message_id,revision_hash,source_mode) DO NOTHING`,
        [input.accountId,input.chatJid,message.messageId,revisionHash,sourceEvent,
          JSON.stringify(message.rawContent),observedAt],
      );
      const phone=message.senderPhone??transportPhone(message.senderJid);
      const inserted=await client.query(
        `INSERT INTO public.whatsapp_messages_original
         (wa_account,chat_jid,chat_type,message_id,direction,sender_jid,sender_phone,
          sender_push_name,receiver_jid,receiver_phone,group_name,"timestamp",message_type,
          raw_content,text_content,media_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz,$13,$14::jsonb,$15,$16)
         ON CONFLICT (wa_account,chat_jid,message_id) DO NOTHING
         RETURNING id`,
        [input.accountId,input.chatJid,input.chatJid.endsWith("@g.us")?"group":"individual",
          message.messageId,message.direction==="OUTGOING"?"outgoing":"incoming",message.senderJid,
          message.senderPhone,message.senderPushName,
          message.receiverJid??(message.direction==="OUTGOING"&&!input.chatJid.endsWith("@g.us")?input.chatJid:null),
          message.receiverPhone??transportPhone(message.receiverJid??(message.direction==="OUTGOING"&&!input.chatJid.endsWith("@g.us")?input.chatJid:null)),
          message.groupName,message.sourceTimestamp,
          message.messageType,JSON.stringify(message.rawContent),message.text,message.mediaRef],
      );
      const originalId=inserted.rows?.[0]?.id??(await client.query(
        `SELECT id FROM public.whatsapp_messages_original
         WHERE wa_account=$1 AND chat_jid=$2 AND message_id=$3`,
        [input.accountId,input.chatJid,message.messageId],
      )).rows?.[0]?.id;
      if(originalId===undefined)throw new Error("Could not resolve the immutable original message row.");
      const route=routeSource(input.accountId,{
        id:message.messageId,chatJid:message.chatJid,senderJid:message.senderJid,
        senderPhone:message.senderPhone,direction:message.direction,
      },sourcePolicy);
      await insertProcessingMarkers(client,originalId,observedAt,"compatibility",input.accountId,route);
      stored+=inserted.rows?.length??0;
      if(message.senderJid&&phone&&/^\+?[0-9]{8,30}$/.test(phone)){
        await client.query(
          `INSERT INTO public.whatsapp_contacts
           (wa_account,phone_number,jid,push_name,contact_name,name_source,name_confidence,last_synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz)
           ON CONFLICT (wa_account,phone_number) DO UPDATE SET
            jid=EXCLUDED.jid,
            push_name=COALESCE(EXCLUDED.push_name,whatsapp_contacts.push_name),
            contact_name=COALESCE(EXCLUDED.contact_name,whatsapp_contacts.contact_name),
            name_source=COALESCE(EXCLUDED.name_source,whatsapp_contacts.name_source),
            name_confidence=COALESCE(EXCLUDED.name_confidence,whatsapp_contacts.name_confidence),
            last_synced_at=GREATEST(whatsapp_contacts.last_synced_at,EXCLUDED.last_synced_at)`,
          [input.accountId,phone,message.senderJid,message.senderPushName,message.contactName,
            message.contactName?"SOURCE_CONTACT":message.senderPushName?"SOURCE_PUSH_NAME":"TRANSPORT_JID",
            message.contactName?"SOURCE_CONTACT":message.senderPushName?"SOURCE_PUSH_NAME":"TRANSPORT_JID",
            observedAt],
        );
      }
      const displayName=message.groupName??message.contactName;
      if(displayName){
        await client.query(
          `UPDATE public.whatsapp_archive_conversations
           SET display_name=$3,display_name_source='SOURCE_CHAT_METADATA',
               display_name_confidence='SOURCE_CHAT_METADATA'
           WHERE account_id=$1 AND chat_jid=$2
             AND (display_name IS NULL OR display_name_source='SOURCE_CHAT_METADATA')`,
          [input.accountId,input.chatJid,displayName],
        );
      }
    }
    const nextPage=input.hasMore?input.pageNumber+1:input.pageNumber;
    await client.query(
      `UPDATE public.whatsapp_ingestion_cursors
       SET page_number=$4,last_observed_at=$5::timestamptz,last_error=NULL
       WHERE account_id=$1 AND chat_jid=$2 AND source_mode='compatibility' AND page_number=$3`,
      [input.accountId,input.chatJid,input.pageNumber,nextPage,observedAt],
    );
    await client.query("COMMIT");
    return {stored,nextPage};
  }catch(error){
    try{await client.query("ROLLBACK");}
    catch(rollbackError){throw new AggregateError([error,rollbackError],"Compatibility page transaction and rollback both failed.");}
    throw error;
  }finally{
    client.release();
  }
}
