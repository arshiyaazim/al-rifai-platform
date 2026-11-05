import {domains,capabilities} from './catalog.ts';
export {domains,capabilities,GROUP_DISCOVERY} from './catalog.ts';
import {z} from 'zod';
import {createHash} from 'node:crypto';

export const VERSION='identity-review-candidate-v1';
export const CORE_REVISION='1838619b644dc83f4ca723d3442d94435e6050f1';
export const ACTIVATION=Object.freeze({production:false,operationalWrites:false,send:false,cashPosting:false,mediaAcquisition:false,providers:false});
export type Domain=typeof domains[number];
export type Capability=typeof capabilities[number];
export const blockedCapabilities=new Set(['whatsapp.send','cash.post','cash.approve','program.activate','employee.create','assignment.cancel','assignment.replace','attendance.post','release.approve','payroll.approve','payroll.post','settlement.approve','settlement.post','review.verify','media.acquire','provider.execute']);
const id=z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/).refine(v=>!['__proto__','constructor','prototype','toString','valueOf'].includes(v),'RESERVED_ID');
const ref=z.string().min(1).max(500);
const jid=z.string().regex(/^[A-Za-z0-9_.:+-]{1,160}@(s\.whatsapp\.net|lid|g\.us)$/);
// Some native bridge rows retain PN digits rather than a suffixed JID. Preserve
// them exactly; never manufacture a suffix or mistake opaque digits for a phone.
const nativeSender=z.union([jid,z.string().regex(/^[0-9]{8,30}$/)]);
const sha=z.string().regex(/^[a-f0-9]{64}$/);
export const timestamp=z.string().datetime({offset:true});
const scope=z.object({accountId:id,domain:z.enum(domains),chatJid:jid.nullable(),resourceId:id.nullable()}).strict();
export const ownerProof=z.object({decisionId:id,evidenceSha:sha,approvedAt:timestamp}).strict();
export type OwnerProof=z.infer<typeof ownerProof>;
const evidence=z.array(ref).min(1).max(20);
export const personSchema=z.object({id,displayName:z.string().min(1).max(150),aliases:z.array(z.object({name:z.string().min(1).max(150),evidenceRef:ref}).strict()).max(30),employeeReferences:z.array(z.object({mobile:z.string().regex(/^\+8801[3-9][0-9]{8}$/),sourceRole:z.enum(['EMPLOYEE_LEDGER','EMPLOYEE_MOBILE','ESCORT_MOBILE']),evidenceRef:ref}).strict()).max(10),evidenceRefs:evidence}).strict();
export const relationshipSchema=z.object({id,personId:id,kind:z.enum(['CLIENT','EMPLOYEE','ADMIN','OFFICE_STAFF','OPERATIONS','ACCOUNTANT','CANDIDATE','VENDOR','FORMER_EMPLOYEE','SUPER_ADMIN','PERSONAL']),clientId:id.nullable(),serviceKind:z.enum(['ESCORT','SECURITY_GUARD']).optional(),validFrom:timestamp.optional(),validTo:timestamp.nullable().optional(),evidenceRefs:evidence}).strict().superRefine((r,c)=>{if(r.kind==='CLIENT'&&!r.clientId)c.addIssue({code:'custom',message:'CLIENT_ID_REQUIRED'});});
export const bindingSchema=z.object({id,personId:id,accountId:id,chatJid:jid,senderJid:nativeSender,direction:z.enum(['INCOMING','OUTGOING']),purpose:z.enum(['SENDER','ACCOUNT_OWNER']),phone:z.string().regex(/^\+8801[3-9][0-9]{8}$/).nullable(),lidMappingRef:ref.nullable(),validFrom:timestamp,validTo:timestamp.nullable(),evidenceRefs:evidence}).strict().superRefine((r,c)=>{
 if(r.senderJid.endsWith('@g.us'))c.addIssue({code:'custom',message:'GROUP_IS_NOT_PARTICIPANT'});
 if(r.senderJid.endsWith('@lid')&&(!r.phone||!r.lidMappingRef))c.addIssue({code:'custom',message:'TRUSTED_LID_MAPPING_REQUIRED'});
 if(r.direction==='OUTGOING'&&r.purpose!=='ACCOUNT_OWNER'||r.direction==='INCOMING'&&r.purpose!=='SENDER')c.addIssue({code:'custom',message:'BINDING_DIRECTION_PURPOSE_CONFLICT'});
 if(r.validTo&&Date.parse(r.validTo)<=Date.parse(r.validFrom))c.addIssue({code:'custom',message:'INVALID_VALIDITY_INTERVAL'});
});
export const groupSchema=z.object({id,nativeJid:z.string().regex(/^[0-9]+@g\.us$/),accountIds:z.array(id).min(1).max(3),displayName:z.string().min(1).max(150),domain:z.enum(['OFFICE','ESCORT','RELEASE']),workflowScope:z.literal('REVIEW_ONLY'),evidenceRefs:evidence}).strict();
export const grantSchema=z.object({id,personId:id,channel:z.enum(['STAFF','WHATSAPP']),capability:z.enum(capabilities),scope,evidenceRefs:evidence}).strict().superRefine((g,c)=>{if(g.channel==='WHATSAPP'&&!g.scope.chatJid)c.addIssue({code:'custom',message:'EXACT_WHATSAPP_CHAT_REQUIRED'});});
export const vesselAliasSchema=z.object({id,accountId:id,left:z.string().min(1).max(150),right:z.string().min(1).max(150),evidenceRefs:evidence}).strict();
export const registrySchemas={person:personSchema,relationship:relationshipSchema,binding:bindingSchema,group:groupSchema,grant:grantSchema,vesselAlias:vesselAliasSchema};
export type RegistryKind=keyof typeof registrySchemas;
export type RegistryData=z.infer<typeof personSchema>|z.infer<typeof relationshipSchema>|z.infer<typeof bindingSchema>|z.infer<typeof groupSchema>|z.infer<typeof grantSchema>|z.infer<typeof vesselAliasSchema>;
export type RegistryRecord={id:string;kind:RegistryKind;version:number;status:'PENDING'|'VERIFIED'|'REVOKED';data:RegistryData;createdBy:string;updatedAt:string;ownerProof:OwnerProof|null};
export type Scope=z.infer<typeof scope>;
export type IdentityResolutionV1={version:'identity-resolution-v1';personId:string|null;state:'VERIFIED'|'UNRESOLVED'|'AMBIGUOUS';relationships:Array<z.infer<typeof relationshipSchema>>;bindings:RegistryRecord[];authorizationVersion:number;conflicts:string[]};
export type AuthorizationDecisionV1={version:'authorization-decision-v1';allowed:boolean;reason:string;actorId:string|null;capability:string;scope:Scope;authorizationVersion:number};

export const nativeEnvelopeSchema=z.object({
 version:z.literal('native-message-envelope-v1'),provider:z.literal('WHATSAPP'),accountId:id,nativeMessageId:z.string().min(1).max(200),chatJid:jid,chatType:z.enum(['direct','group']),senderJid:nativeSender,senderPhone:z.string().max(80).nullable(),senderLid:z.string().max(160).nullable(),direction:z.enum(['INCOMING','OUTGOING']),sourceTimestamp:timestamp,sourceTimestampOriginal:z.string().min(1).max(100).nullable(),observedAt:timestamp,eventType:z.enum(['TEXT','MEDIA','EDIT','RECEIPT','REACTION','PROTOCOL']),
 payload:z.object({text:z.string().max(64000),sha256:sha,reference:ref}).strict(),quotedMessageId:z.string().max(200).nullable(),forwarded:z.boolean().nullable(),media:z.array(z.object({id,kind:z.enum(['IMAGE','PDF','AUDIO','DOCUMENT']),available:z.boolean(),evidenceRef:ref.nullable()}).strict()).max(10),
 groupDisplayName:z.string().max(150).nullable(),membershipEvidence:z.object({participantJid:jid,event:z.enum(['OBSERVED','JOINED','LEFT','UNKNOWN']),evidenceRef:ref}).strict().nullable(),
}).strict().superRefine((m,c)=>{
 if(m.chatType!==(m.chatJid.endsWith('@g.us')?'group':'direct'))c.addIssue({code:'custom',message:'CHAT_TYPE_CONFLICT'});
 if(m.senderJid.endsWith('@g.us')&&m.chatType==='direct')c.addIssue({code:'custom',message:'INVALID_DIRECT_SENDER'});
 if(Buffer.byteLength(m.payload.text)>64000||hash(m.payload.text)!==m.payload.sha256)c.addIssue({code:'custom',message:'PAYLOAD_HASH_OR_BUDGET_INVALID'});
});
export type NativeMessageEnvelopeV1=z.infer<typeof nativeEnvelopeSchema>;
export type ReviewItemV1={version:'review-item-v1';id:string;revision:number;accountId:string;chatJid:string;domain:Domain;requiredDomains:Domain[];sourceOccurrenceId:string;sourceRevision:number;classification:string;status:'DRAFT'|'REVIEW'|'UPDATED'|'NEEDS_CLARIFICATION';fields:Record<string,unknown>;reasons:string[];linkedDraftId:string|null;assignmentProposal:Record<string,unknown>|null;assignmentState:string;clientDeliveryState:'NOT_SENT';createdBy:string;authorizationVersion:number;note:string;candidate:Record<string,unknown>;identityClaimId?:string;rosterContextHash?:string;sourceReferences?:string[]};
export type Occurrence={id:string;accountId:string;chatJid:string;nativeMessageId:string;provider:string;revision:number;payloadHash:string;envelope:NativeMessageEnvelopeV1;conflicted:boolean;referenceOnly?:boolean;nativeReference?:Record<string,unknown>};
export type AuditEvent={id:string;at:string;actorId:string;action:string;resourceId:string;version:number;reason:string;previousHash:string;hash:string};
export class CandidateError extends Error{code:string;status:number;constructor(code:string,status=400){super(code);this.name='CandidateError';this.code=code;this.status=status;}}
export function canonical(value:unknown):string {if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value!==null&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';return JSON.stringify(value);}
export function hash(value:string){return createHash('sha256').update(value).digest('hex');}
export function digest(value:unknown){return hash(canonical(value));}
export function occurrenceKey(m:NativeMessageEnvelopeV1){return digest([m.accountId,m.provider,m.chatJid,m.nativeMessageId]);}
export function occurrencePayload(m:NativeMessageEnvelopeV1){const {observedAt:ignored,groupDisplayName:display,membershipEvidence:membership,payload,...rest}=m;void ignored;void display;void membership;return digest({...rest,payload:{text:payload.text,sha256:payload.sha256}});}
export function normalizeEmployeeMobile(raw:string,sourceRole:string):string|null{
 if(!['EMPLOYEE_LEDGER','EMPLOYEE_MOBILE','ESCORT_MOBILE'].includes(sourceRole))return null;
 return normalizePhone(raw);
}
export function normalizePhone(raw:string):string|null{
 const ascii=raw.replace(/[০-৯]/g,c=>String('০১২৩৪৫৬৭৮৯'.indexOf(c))).trim();
 if(!/^\+?[0-9][0-9 ()\-.]*$/.test(ascii))return null;
 const n=ascii.replace(/[ ()\-.]/g,'');
 if(/^01[3-9][0-9]{8}$/.test(n))return '+880'+n.slice(1);
 if(/^\+?8801[3-9][0-9]{8}$/.test(n))return '+'+n.replace(/^\+/,'');
 return null;
}
