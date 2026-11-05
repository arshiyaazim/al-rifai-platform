/** Finish an unconsumed HTTP body after an early authorization/error response.
 * Otherwise closing the proxy socket can leave Next's IncomingMessage unfinished.
 * Bytes are discarded without parsing; existing endpoint/body limits still apply.
 */
export async function discardUnreadBody(request,maxBytes=32000){
 if(!request.body||request.bodyUsed)return;
 const reader=request.body.getReader();let bytes=0;
 try{while(true){const {done,value}=await reader.read();if(done)return;bytes+=value.byteLength;if(bytes>maxBytes){await reader.cancel();return;}}}
 catch{/* The client may have already disconnected while its body was discarded. */}
 finally{reader.releaseLock();}
}
