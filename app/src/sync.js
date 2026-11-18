import { createDrivePackClient } from './drive-packs.mjs';
import './core.js';
import { createWnfsSync } from './wnfs-sync.js';
import { createAccountSharing } from './account-share.js';
import{createClientConsentHost,createClientOperationBroker}from'./runtime.js';
import{runtimeFor}from'./sync-contract.js';import{syncOrigin,receiptKeys,wnfsEnabled}from'./sync-config.js';import{verifyDrivePackReceipt}from'./receipt.js';
const core=window.AwaiDriveEncrypted;
const b64=b=>{let s='';for(let i=0;i<b.length;i+=16384)s+=String.fromCharCode(...b.subarray(i,i+16384));return btoa(s);};
const unb64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
const invoke=(op,extra={})=>window.__TAURI__.core.invoke('drive_call',{request:{op,...extra}});
const runtime=runtimeFor(syncOrigin,wnfsEnabled),selectors=runtime.operations.map(o=>[o.capability,o.service,o.operation]);
const broker=createClientOperationBroker({runtime,requestedCapabilities:['yataverse.store'],approvedOperations:runtime.operations,hostSupportedOperations:selectors,consentHost:createClientConsentHost()});
async function session(initialize=false){let s=await invoke('vaultSession',{initialize});if(!s.initialized)throw Error('recovery-required');const secret=unb64(s.secret);if(!s.record){const record=await core.newRecord(secret);await invoke('vaultRecord',{record});s={...s,record};}return {...s,secret};}
const packs = createDrivePackClient({ origin: syncOrigin, capability: 'yataverse.store', broker, sha256: bytes => core.sha256(bytes) });

function verifyReceipt(receipt, expected) {
  if (!receiptKeys) return;
  try {
    verifyDrivePackReceipt(receipt, receiptKeys, expected);
  } catch (error) {
    throw Error('storage-receipt-invalid:' + String(error?.message || error).slice(0, 80), { cause: error });
  }
}
const wnfs = createWnfsSync({ invoke, origin: syncOrigin, packs, verifyReceipt, sha256: core.sha256 });
const accountSharing = createAccountSharing({ invoke, wnfs, sha256: core.sha256, app: 'network.awai.yataverse' });
export const configured=Boolean(syncOrigin);
export const sharingEnabled=Boolean(syncOrigin && wnfsEnabled);
export async function sync(){const s=await session(true);try{
 if(wnfsEnabled)return await accountSharing.sync(s);
 if(s.wnfs)throw Error('recovery-required');
 const {entries}=await invoke('vaultInventory');const rows=[];
 for(const e of entries){if(e.directory)continue;const bytes=new Uint8Array(e.size);for(let at=0;at<e.size;at+=65531){const r=await invoke('vaultRead',{path:e.path,offset:at,length:Math.min(65531,e.size-at)});bytes.set(unb64(r.bytes),at);}if(await core.sha256(bytes)!==e.sha256)throw Error('source-size-changed');rows.push({path:e.path,bytes});}
 rows.directories=entries.filter(e=>e.directory).map(e=>e.path);const sealed=await core.sealSnapshot(s.record,s.secret,rows);const id=await packs.publish(sealed.bytes,verifyReceipt);
 await invoke('vaultCommit',{root:sealed.root,pack:id,origin:syncOrigin,entries});return {files:rows.length,root:sealed.root,pack:id};
 }finally{s.secret.fill(0);}}
export async function evict(){return invoke('vaultEvict',{origin:syncOrigin});}
export async function restore({legacy=false}={}){const s=await session();try{
 if(s.wnfs&&!legacy){if(!wnfsEnabled)throw Error('recovery-required');return await wnfs.restore(s);}
 if(!s.root||!s.pack||s.origin!==syncOrigin)throw Error('recovery-required');const bytes=await packs.download(s.pack);const rows=await core.openSnapshot(s.record,s.secret,s.root,bytes);
 if(wnfsEnabled)return await wnfs.restoreCopy(rows.map(row=>({path:row.path,chunks:[row.bytes]})),true);
 // Authenticate and validate all plaintext before staging or publishing output.
 await invoke('vaultRestoreBegin');for(const r of rows){if(r.bytes.length===0)await invoke('vaultRestoreWrite',{path:r.path,offset:0,bytes:''});for(let at=0;at<r.bytes.length;at+=65531)await invoke('vaultRestoreWrite',{path:r.path,offset:at,bytes:b64(r.bytes.subarray(at,at+65531))});r.bytes.fill(0);}await invoke('vaultRestorePublish');return {files:rows.length};
 }finally{s.secret.fill(0);}}
export async function state(){const s=await invoke('vaultStatus');return {...s,canEvict:!wnfsEnabled&&!s.wnfs,legacyRestore:wnfsEnabled&&s.wnfs&&s.legacy,synced:s.synced&&s.origin===syncOrigin,configured};}

export async function inspectAuthorizedSnapshot(owner, expectedBasis, extension) {
 if(!wnfsEnabled)throw Error('recovery-required');
 return wnfs.inspect(owner,expectedBasis,extension);
}

async function sharing(action) {
 if(!wnfsEnabled)throw Error('recovery-required');
 const owner = await session(true);
 try {return await action(owner);} finally {owner.secret.fill(0);}
}
export const publicSnapshotRecipient = () => sharing(owner => accountSharing.publicRecipient(owner));
export const grantSnapshotRecipient = recipient => sharing(owner => accountSharing.grant(owner, recipient));
export const revokeSnapshotRecipient = id => sharing(owner => accountSharing.revoke(owner, id));
export const restoreSharedSnapshot = (share, sender) => sharing(owner => accountSharing.restore(owner, share, sender));
