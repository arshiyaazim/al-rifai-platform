import {readFileSync} from 'node:fs';
import {createHash,timingSafeEqual} from 'node:crypto';
export function verifyAuthorization(header,password){
 if(!password || password.length<32 || !header?.startsWith('Basic ') || header.length>1024)return false;
 const encoded=header.slice(6);
 if(!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))return false;
 const credential=Buffer.from(encoded,'base64').toString('utf8');
 const digest=value=>createHash('sha256').update(value).digest();
 return timingSafeEqual(digest(credential),digest('validator:'+password));
}
export function validationIdentity(header){
 let password;
 try{password=readFileSync(process.env.ALRIFAI_VALIDATION_PASSWORD_FILE || '/run/secrets/validation_password','utf8').trim();}catch{return null;}
 return verifyAuthorization(header,password)?{userId:'local-validator',displayName:'Private validator',email:'validator@localhost',fullName:null}:null;
}
