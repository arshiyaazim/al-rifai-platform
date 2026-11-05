import {isIP} from 'node:net';
import {CandidateError} from './contracts.ts';
// Call only after the host/secret barrier. The same-app TLS entry supplies it.
export function trustedWebPeer(headers:Headers,live:boolean){
 const value=headers.get('x-alrifai-client-ip');
 if(value&&isIP(value))return value;
 if(live)throw new CandidateError('WEB_CLIENT_PROVENANCE_REQUIRED',403);
 return 'isolated-loopback-peer';
}
