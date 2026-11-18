import { createDrivePackClient } from './drive-packs.mjs';
import './core.js';
import { verifyDrivePackReceipt } from './receipt.js';
import{createClientConsentHost,createClientOperationBroker}from'./runtime.js';
import{runtimeFor}from'./sync-contract.js';import{syncOrigin,wnfsWrite,receiptKeys}from'./sync-config.js';
const core=window.AwaiDriveEncrypted;
const wnfs=window.AwaiDriveWNFS;
const b64=b=>{let s='';for(let i=0;i<b.length;i+=16384)s+=String.fromCharCode(...b.subarray(i,i+16384));return btoa(s);};
const unb64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
const invoke=(op,extra={})=>window.__TAURI__.core.invoke('drive_call',{request:{op,...extra}});
const runtime=runtimeFor(syncOrigin),selectors=runtime.operations.map(o=>[o.capability,o.service,o.operation]);
const broker=createClientOperationBroker({runtime,requestedCapabilities:['yataverse.store'],approvedOperations:runtime.operations,hostSupportedOperations:selectors,consentHost:createClientConsentHost()});
async function session(initialize=false){let s=await invoke('vaultSession',{initialize});if(!s.initialized)throw Error('recovery-required');const secret=unb64(s.secret);if(!s.record){const record=await core.newRecord(secret);await invoke('vaultRecord',{record});s={...s,record};}return {...s,secret};}
const packs = createDrivePackClient({ origin: syncOrigin, capability: 'yataverse.store', broker, sha256: bytes => core.sha256(bytes) });
function verifyReceipt(receipt, expected) {
  if (receiptKeys) verifyDrivePackReceipt(receipt, receiptKeys, expected);
}

function summarize(rows, basis, extension, openedAt) {
  if (rows.basis !== basis) throw Error('snapshot-basis-mismatch');
  const query = wnfs.project(rows, basis);
  const indexedAt = performance.now();
  const matches = query(basis, extension);
  return { basis, rows: rows.length, matches, indexMs: indexedAt - openedAt,
    queryMs: performance.now() - indexedAt };
}

// The app's host must supply previously authorized custody and the expected
// forest basis. This read-only path performs its own fresh consent and keeps
// plaintext file contents inside the app. It does not change the local vault.
export async function inspectAuthorizedSnapshot({ record, secret, root, pack, basis, origin }, extension) {
  if (origin !== syncOrigin || !basis) throw Error('recovery-required');
  const started = performance.now();
  const ciphertext = await packs.download(pack);
  const downloadedAt = performance.now();
  const rows = await wnfs.openSnapshot(record, secret, root, ciphertext);
  const openedAt = performance.now();
  try {
    const summary = summarize(rows, basis, extension, openedAt);
    const files = await Promise.all(Array.from(rows, async row => [row.path, await core.sha256(row.bytes)]));
    return { ...summary, files, bytes: ciphertext.length,
      downloadMs: downloadedAt - started, openMs: openedAt - downloadedAt };
  } finally {
    for (const row of rows) row.bytes.fill(0);
  }
}

export const configured=Boolean(syncOrigin);
export async function sync(){const s=await session(true);try{
 const {entries}=await invoke('vaultInventory');const rows=[];
 for(const e of entries){if(e.directory)continue;const bytes=new Uint8Array(e.size);for(let at=0;at<e.size;at+=65531){const r=await invoke('vaultRead',{path:e.path,offset:at,length:Math.min(65531,e.size-at)});bytes.set(unb64(r.bytes),at);}if(await core.sha256(bytes)!==e.sha256)throw Error('source-size-changed');rows.push({path:e.path,bytes});}
 rows.directories=entries.filter(e=>e.directory).map(e=>e.path);const sealed=await (wnfsWrite?wnfs:core).sealSnapshot(s.record,s.secret,rows);const id=await packs.publish(sealed.bytes,verifyReceipt);
 await invoke('vaultCommit',{root:sealed.root,pack:id,origin:syncOrigin,entries});return {files:rows.length,root:sealed.root,pack:id,basis:sealed.basis};
 }finally{s.secret.fill(0);}}
export async function evict(){return invoke('vaultEvict',{origin:syncOrigin});}
export async function restore(){const s=await session();try{if(!s.root||!s.pack||s.origin!==syncOrigin)throw Error('recovery-required');const bytes=await packs.download(s.pack);const rows=await wnfs.openSnapshot(s.record,s.secret,s.root,bytes);
 // Authenticate and validate all plaintext before staging or publishing output.
 await invoke('vaultRestoreBegin');for(const r of rows){if(r.bytes.length===0)await invoke('vaultRestoreWrite',{path:r.path,offset:0,bytes:''});for(let at=0;at<r.bytes.length;at+=65531)await invoke('vaultRestoreWrite',{path:r.path,offset:at,bytes:b64(r.bytes.subarray(at,at+65531))});r.bytes.fill(0);}await invoke('vaultRestorePublish');return {files:rows.length,basis:rows.basis};
 }finally{s.secret.fill(0);}}
export async function state(){const s=await invoke('vaultStatus');return {...s,synced:s.synced&&s.origin===syncOrigin,configured};}
