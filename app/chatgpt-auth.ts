import {headers} from "next/headers";
import {redirect} from "next/navigation";
import {validationIdentity} from "@/lib/validation-auth.mjs";
import {currentIdentity, unifiedMode} from "@/lib/unified-auth";
import {sanitizeReturnTo} from "@/lib/unified-auth-policy";

export type ChatGPTUser={
 userId:string;
 displayName:string;
 email:string;
 fullName:string|null;
 /** Present for unified sessions; the legacy validator identity has no role. */
 role?:'ADMIN'|'USER';
 superAdmin?:boolean;
 capabilities?:string[];
 mustChangePassword?:boolean;
 source?:'validation'|'session';
};

/**
 * Compatibility names only. Identity resolution order is deliberate:
 *   1. the deployed Basic validation credential (unchanged, always accepted),
 *   2. a validated unified Cash session when ALRIFAI_UNIFIED_AUTH_MODE is not
 *      `off`. Roles always come from the stored user row, never from a header,
 *      query string or cookie payload.
 */
export async function getChatGPTUser():Promise<ChatGPTUser|null>{
 const basic=validationIdentity((await headers()).get("authorization"));
 if(basic)return {...basic,source:'validation'};
 const identity=await currentIdentity();
 if(!identity)return null;
 return {
  userId:identity.id,
  displayName:identity.displayName,
  email:identity.email??`${identity.username}@local`,
  fullName:null,
  role:identity.role,
  superAdmin:identity.superAdmin,
  capabilities:identity.capabilities,
  mustChangePassword:identity.mustChangePassword,
  source:'session',
 };
}

export async function requireChatGPTUser(returnTo:string):Promise<ChatGPTUser>{
 const user=await getChatGPTUser();
 if(user)return user;
 if(unifiedMode()!=='off')redirect(`/login?next=${encodeURIComponent(sanitizeReturnTo(returnTo))}`);
 throw new Error("Private validation authentication required");
}
