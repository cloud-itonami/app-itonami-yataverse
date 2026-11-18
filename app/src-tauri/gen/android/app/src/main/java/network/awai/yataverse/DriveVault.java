package network.awai.yataverse;
import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.*;
import java.io.*;
import java.nio.file.*;
import java.security.*;
import java.util.*;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;
/** Device custody and bounded local I/O only. Owner envelope/format is CLJC. */
public final class DriveVault {
 private final Context context; private final File control,cache;
 private static final long LEGACY_BYTES=8L*1024*1024, WNFS_BYTES=32L*1024*1024;
 private static final String ALIAS="awai.drive.vault.v1";
 public DriveVault(Context c){context=c;control=new File(c.getNoBackupFilesDir(),"drive-vault-v1.bin");cache=new File(c.getFilesDir(),"drive-local-v1");}
 private javax.crypto.SecretKey key(boolean create)throws Exception{KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);if(!store.containsAlias(ALIAS)){if(!create)throw new IOException("recovery-required");KeyGenerator g=KeyGenerator.getInstance("AES","AndroidKeyStore");g.init(new KeyGenParameterSpec.Builder(ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());g.generateKey();}return (javax.crypto.SecretKey)store.getKey(ALIAS,null);}
 private JSONObject load()throws Exception{if(!control.exists())return null;byte[] b=Files.readAllBytes(control.toPath());if(b.length<29||b.length>262144)throw new IOException("recovery-required");Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.DECRYPT_MODE,key(false),new GCMParameterSpec(128,Arrays.copyOf(b,12)));c.updateAAD(ALIAS.getBytes("UTF-8"));return new JSONObject(new String(c.doFinal(b,12,b.length-12),"UTF-8"));}
 private void save(JSONObject value,boolean create)throws Exception{byte[] p=value.toString().getBytes("UTF-8");if(p.length>240000)throw new IOException("state-limit");Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.ENCRYPT_MODE,key(create));c.updateAAD(ALIAS.getBytes("UTF-8"));byte[] body=c.doFinal(p);Arrays.fill(p,(byte)0);File temp=File.createTempFile(".vault-",".part",control.getParentFile());try{try(FileOutputStream out=new FileOutputStream(temp)){out.write(c.getIV());out.write(body);out.getFD().sync();}Files.move(temp.toPath(),control.toPath(),StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);sync(control.getParentFile());}finally{temp.delete();}}
 static void sync(File d)throws Exception{java.io.FileDescriptor fd=android.system.Os.open(d.getPath(),android.system.OsConstants.O_RDONLY,0);try{android.system.Os.fsync(fd);}finally{android.system.Os.close(fd);}}
 static String hash(File f)throws Exception{MessageDigest d=MessageDigest.getInstance("SHA-256");byte[] b=new byte[65536];try(InputStream in=new FileInputStream(f)){int n;while((n=in.read(b))!=-1)d.update(b,0,n);}StringBuilder h=new StringBuilder();for(byte x:d.digest())h.append(String.format(Locale.ROOT,"%02x",x&255));return h.toString();}
 private JSONArray inventory()throws Exception{return inventory(LEGACY_BYTES);}
 private JSONArray inventory(long limit)throws Exception{DriveFiles d=new DriveFiles(cache);JSONArray out=new JSONArray();walk(d,"",out,new long[]{0},limit);return out;}
 private void walk(DriveFiles d,String path,JSONArray out,long[] total,long limit)throws Exception{for(File f:d.list(path)){if(out.length()>=1000)throw new IOException("entry-limit");String p=d.path(f);if(f.isDirectory()){out.put(new JSONObject().put("path",p).put("directory",true));walk(d,p,out,total,limit);}else{if(!f.isFile())throw new IOException("invalid-path");total[0]+=f.length();if(total[0]>limit)throw new IOException("sync-size-limit");out.put(new JSONObject().put("path",p).put("directory",false).put("size",f.length()).put("sha256",hash(f)));}}}
 static boolean equalInventory(JSONArray a,JSONArray b)throws Exception{if(a.length()!=b.length())return false;for(int i=0;i<a.length();i++){JSONObject x=a.getJSONObject(i),y=b.getJSONObject(i);if(!x.getString("path").equals(y.getString("path"))||x.getBoolean("directory")!=y.getBoolean("directory"))return false;if(!x.getBoolean("directory")&&(x.getLong("size")!=y.getLong("size")||!x.getString("sha256").equals(y.getString("sha256"))))return false;}return true;}
 private void same(JSONArray expected)throws Exception{if(!equalInventory(inventory(),expected))throw new IOException("unsynced-data");}
 private void removeTree(File f)throws Exception{if(Files.isSymbolicLink(f.toPath()))throw new IOException("invalid-path");if(f.isDirectory()){File[] children=f.listFiles();if(children==null)throw new IOException("storage-unavailable");for(File x:children)removeTree(x);}if(!f.delete())throw new IOException("storage-unavailable");}
 private void noUnpublished(File dir)throws Exception{File[] children=dir.listFiles();if(children==null)throw new IOException("storage-unavailable");for(File f:children){if(Files.isSymbolicLink(f.toPath()))throw new IOException("invalid-path");if(f.getName().startsWith(".pending-")&&!f.getName().equals(".pending-writer.lock"))throw new IOException("unsynced-data");if(f.isDirectory())noUnpublished(f);}}
 private long allocated(File dir,int[] count,long limit)throws Exception{long bytes=0;for(File f:Objects.requireNonNull(dir.listFiles())){if(++count[0]>1000||Files.isSymbolicLink(f.toPath()))throw new IOException("entry-limit");if(f.isDirectory())bytes+=allocated(f,count,limit);else if(f.isFile())bytes+=f.length();else throw new IOException("invalid-path");if(bytes>limit)throw new IOException("sync-size-limit");}return bytes;}
 private static String digestId(String value)throws IOException {
  if(!value.matches("[a-f0-9]{64}"))throw new IOException("invalid-root");
  return value;
 }
 private static JSONObject wnfsHead(JSONObject control)throws IOException {
  JSONObject head=control==null?null:control.optJSONObject("wnfs");
  if(head==null||!"awai.drive.wnfs.v1".equals(head.optString("schema")))throw new IOException("recovery-required");
  return head;
 }
 private static JSONObject legacyHead(JSONObject control)throws IOException {
  if(control==null||!control.has("pack")||!control.has("entries"))throw new IOException("recovery-required");
  return control;
 }
 private String restoreOperation;
 private String restoreShare;
 private JSONArray restoreInventory;
 private static boolean samePaths(JSONArray actual,JSONArray expected)throws Exception {
  if(actual.length()!=expected.length())return false;
  Map<String,JSONObject> byPath=new HashMap<>();
  for(int i=0;i<expected.length();i++){
   JSONObject row=expected.getJSONObject(i);
   if(byPath.put(row.getString("path"),row)!=null)return false;
  }
  for(int i=0;i<actual.length();i++){
   JSONObject row=actual.getJSONObject(i), other=byPath.remove(row.getString("path"));
   if(other==null||row.getBoolean("directory")!=other.getBoolean("directory"))return false;
   if(!row.getBoolean("directory")&&(row.getLong("size")!=other.getLong("size")||
      !row.getString("sha256").equals(other.getString("sha256"))))return false;
  }
  return byPath.isEmpty();
 }
 private static JSONObject recipients(JSONObject control)throws JSONException {
  if(control!=null&&control.has("wnfsRecipients"))return control.getJSONObject("wnfsRecipients");
  return new JSONObject().put("revision",0).put("items",new JSONObject());
 }
 private JSONObject updateRecipient(JSONObject control,JSONObject request)throws Exception {
  if(control==null||!control.has("record"))throw new IOException("recovery-required");
  String id=request.getString("id");
  if(!id.matches("kv1:[A-Za-z0-9_-]{43}"))throw new IOException("invalid-recipient");
  JSONObject state=recipients(control), items=state.getJSONObject("items");
  if(request.has("recipient")){
   JSONObject entry=request.getJSONObject("recipient");
   if(entry.length()!=3||!id.equals(entry.getString("id"))||
      !entry.getString("pub").matches("[A-Za-z0-9_-]{43}")||
      !entry.getString("pq").matches("[A-Za-z0-9_-]{1579}"))throw new IOException("invalid-recipient");
   if(!items.has(id)&&items.length()>=8)throw new IOException("recipient-limit");
   items.put(id,entry);
  }else items.remove(id);
  state.put("revision",Math.addExact(state.getLong("revision"),1));
  control.put("wnfsRecipients",state);
  save(control,false);
  return new JSONObject().put("revision",state.getLong("revision"));
 }
 private void requireRestore(JSONObject request)throws Exception {
  if(restoreOperation==null||!restoreOperation.equals(request.getString("operation")))
   throw new IOException("restore-operation-mismatch");
 }
 private void clearRestore(){restoreOperation=null;restoreShare=null;restoreInventory=null;}
 private File wnfsStage(){return new File(context.getCacheDir(),"drive-restore-wnfs");}
 private JSONObject commitWnfs(JSONObject control,JSONObject request)throws Exception {
  if(control==null||!control.has("record"))throw new IOException("recovery-required");
  if(request.getLong("recipientRevision")!=recipients(control).getLong("revision"))throw new IOException("recipient-grants-changed");
  JSONArray entries=request.getJSONArray("entries");
  if(!equalInventory(inventory(WNFS_BYTES),entries))throw new IOException("unsynced-data");
  noUnpublished(cache);
  JSONArray packs=request.getJSONArray("packs");
  if(packs.length()<1||packs.length()>8)throw new IOException("invalid-root");
  Set<String> ids=new HashSet<>();
  String capsule=digestId(request.getString("capsule"));
  ids.add(capsule);
  for(int i=0;i<packs.length();i++){
   if(!ids.add(digestId(packs.getString(i))))throw new IOException("invalid-root");
  }
  JSONObject head=new JSONObject()
    .put("schema","awai.drive.wnfs.v1")
    .put("root",digestId(request.getString("root")))
    .put("capsule",capsule).put("packs",packs)
    .put("origin",request.getString("origin")).put("entries",entries);
  // Keep the v1 root, original inventory, owner record and keys intact.
  control.put("wnfs",head);
  save(control,false);
  return new JSONObject();
 }
 private JSONObject writeWnfs(JSONObject request)throws Exception {
  requireRestore(request);
  File stage=wnfsStage();
  if(!stage.isDirectory())throw new IOException("restore-required");
  File target=new DriveFiles(stage).resolve(request.getString("path"));
  long offset=request.getLong("offset");
  byte[] bytes=Base64.decode(request.getString("bytes"),Base64.NO_WRAP);
  try{
   if(bytes.length>65531||offset<0||offset>WNFS_BYTES-bytes.length)
    throw new IOException("invalid-path");
   if(allocated(stage,new int[]{0},WNFS_BYTES)+bytes.length>WNFS_BYTES)
    throw new IOException("sync-size-limit");
   if(stage.getUsableSpace()<DriveFiles.RESERVE+bytes.length)
    throw new IOException("storage-full");
   Files.createDirectories(target.getParentFile().toPath());
   try(RandomAccessFile out=new RandomAccessFile(target,"rw")){
    if(out.length()!=offset)throw new IOException("restore-mismatch");
    out.seek(offset);
    out.write(bytes);
   }
  }finally{Arrays.fill(bytes,(byte)0);}
  return new JSONObject();
 }
 private JSONObject publishWnfs(JSONObject request)throws Exception {
  requireRestore(request);
  File stage=wnfsStage();
  if(!stage.isDirectory())throw new IOException("restore-required");
  JSONArray expected=restoreInventory;
  DriveFiles files=new DriveFiles(stage);
  for(int i=0;i<expected.length();i++){
   JSONObject entry=expected.getJSONObject(i);
   File file=files.resolve(entry.getString("path"));
   if(entry.getBoolean("directory"))Files.createDirectories(file.toPath());
   else{
    if(!file.isFile())throw new IOException("restore-mismatch");
    try(RandomAccessFile data=new RandomAccessFile(file,"rw")){data.getFD().sync();}
   }
  }
  JSONArray actual=new JSONArray();
  walk(files,"",actual,new long[]{0},WNFS_BYTES);
  if(!samePaths(actual,expected))throw new IOException("restore-mismatch");
  for(File dir:allDirs(stage))sync(dir);
  DriveFiles destination=new DriveFiles(cache);
  if(destination.list("").length>=DriveFiles.MAX_ENTRIES)throw new IOException("entry-limit");
  String name=restoreShare==null?"Recovered "+UUID.randomUUID():"Shared "+restoreShare;
  // No overwrite and no detaching the user's original tree. Only a validated
  // staged subtree becomes visible, after one rename on the app volume.
  File target=destination.resolve(name);
  if(Files.exists(target.toPath(),LinkOption.NOFOLLOW_LINKS)){
   if(restoreShare==null||!target.isDirectory()||Files.isSymbolicLink(target.toPath()))throw new IOException("file-exists");
   JSONArray existing=new JSONArray();
   walk(new DriveFiles(target),"",existing,new long[]{0},WNFS_BYTES);
   if(!samePaths(existing,expected))throw new IOException("restore-mismatch");
   removeTree(stage);
   clearRestore();
   return new JSONObject().put("folder",name);
  }
  Files.move(stage.toPath(),target.toPath(),StandardCopyOption.ATOMIC_MOVE);
  sync(cache);
  clearRestore();
  return new JSONObject().put("folder",name);
 }
 public synchronized JSONObject execute(JSONObject q)throws Exception{String op=q.getString("op");JSONObject v=load();switch(op){
 case "vaultSession":{if(v==null){if(!q.optBoolean("initialize"))return new JSONObject().put("initialized",false);KeyStore existing=KeyStore.getInstance("AndroidKeyStore");existing.load(null);if(existing.containsAlias(ALIAS))throw new IOException("recovery-required");byte[] secret=new byte[32];new SecureRandom().nextBytes(secret);v=new JSONObject().put("secret",Base64.encodeToString(secret,Base64.NO_WRAP));Arrays.fill(secret,(byte)0);save(v,true);}JSONObject r=new JSONObject(v.toString());r.put("initialized",true);return r;}
 case "vaultRecord":{if(v==null||v.has("record"))throw new IOException("recovery-required");String record=q.getString("record");if(record.length()>16000)throw new IOException("state-limit");v.put("record",record);save(v,false);return new JSONObject();}
 case "vaultWnfsInventory":return new JSONObject().put("entries",inventory(WNFS_BYTES));
 case "vaultWnfsCommit":return commitWnfs(v,q);
 case "vaultWnfsRecipients":return recipients(v);
 case "vaultWnfsRecipientSet":return updateRecipient(v,q);
 case "vaultWnfsRestoreBegin":{
  if(restoreOperation!=null)throw new IOException("restore-in-progress");
  String share=q.has("share")?digestId(q.getString("share")):null;
  JSONArray expected=share==null?(q.optBoolean("legacy")?legacyHead(v):wnfsHead(v)).getJSONArray("entries"):q.getJSONArray("entries");
  if(expected.length()>1000||expected.toString().length()>240000)throw new IOException("state-limit");
  File stage=wnfsStage();
  if(stage.exists())removeTree(stage);
  Files.createDirectory(stage.toPath());
  restoreOperation=UUID.randomUUID().toString();
  restoreShare=share;
  restoreInventory=expected;
  return new JSONObject().put("operation",restoreOperation);
 }
 case "vaultWnfsRestoreAbort":{
  requireRestore(q);
  File stage=wnfsStage();
  try{if(stage.exists())removeTree(stage);}finally{clearRestore();}
  return new JSONObject();
 }
 case "vaultWnfsRestoreWrite":return writeWnfs(q);
 case "vaultWnfsRestorePublish":return publishWnfs(q);
 case "vaultStatus":{if(v!=null&&v.has("wnfs")){
  JSONObject head=wnfsHead(v);
  boolean clean;
  try{clean=equalInventory(inventory(WNFS_BYTES),head.getJSONArray("entries"));noUnpublished(cache);}
  catch(IOException e){if(!"sync-size-limit".equals(e.getMessage())&&!"unsynced-data".equals(e.getMessage()))throw e;clean=false;}
  return new JSONObject().put("initialized",true).put("synced",clean)
    .put("origin",head.getString("origin")).put("wnfs",true).put("legacy",v.has("pack")).put("evicted",false);
 }boolean same=false,empty=false;try{JSONArray entries=inventory();noUnpublished(cache);empty=entries.length()==0;same=v!=null&&v.has("entries")&&equalInventory(entries,v.getJSONArray("entries"));}catch(IOException e){if(!"sync-size-limit".equals(e.getMessage())&&!"unsynced-data".equals(e.getMessage()))throw e;same=false;empty=false;}return new JSONObject().put("initialized",v!=null).put("synced",same).put("origin",v==null?"":v.optString("origin")).put("legacy",v!=null&&v.has("pack")).put("evicted",empty&&v!=null&&v.has("pack")&&!same);}
 case "vaultInventory": return new JSONObject().put("entries",inventory());
 case "vaultRead":{DriveFiles d=new DriveFiles(cache);File f=d.resolve(q.getString("path"));long at=q.getLong("offset");int length=q.getInt("length");if(!f.isFile()||at<0||length<0||length>65531||at+length>f.length())throw new IOException("invalid-path");byte[] b=new byte[length];try(RandomAccessFile in=new RandomAccessFile(f,"r")){in.seek(at);in.readFully(b);}return new JSONObject().put("bytes",Base64.encodeToString(b,Base64.NO_WRAP));}
 case "vaultCommit":{if(v==null||!v.has("record"))throw new IOException("recovery-required");JSONArray entries=q.getJSONArray("entries");same(entries);noUnpublished(cache);String root=q.getString("root"),pack=q.getString("pack");if(!root.matches("[a-f0-9]{64}")||!pack.matches("[a-f0-9]{64}"))throw new IOException("invalid-root");v.put("root",root).put("pack",pack).put("origin",q.getString("origin")).put("entries",entries);save(v,false);return new JSONObject();}
 case "vaultEvict":{if(v==null||v.has("wnfs")||!v.has("entries")||!v.has("pack"))throw new IOException("unsynced-data");if(!v.optString("origin").equals(q.optString("origin")))throw new IOException("unsynced-data");same(v.getJSONArray("entries"));noUnpublished(cache);File detached=new File(context.getCacheDir(),"drive-evict-"+UUID.randomUUID());Files.move(cache.toPath(),detached.toPath(),StandardCopyOption.ATOMIC_MOVE);try{Files.createDirectory(cache.toPath());sync(cache.getParentFile());}catch(Exception e){Files.move(detached.toPath(),cache.toPath(),StandardCopyOption.ATOMIC_MOVE);throw e;}removeTree(detached);return new JSONObject();}
 case "vaultRestoreBegin":{if(v==null||!v.has("root")||inventory().length()!=0)throw new IOException("unsynced-data");noUnpublished(cache);File stage=new File(context.getCacheDir(),"drive-restore-v1");if(stage.exists())removeTree(stage);Files.createDirectory(stage.toPath());return new JSONObject();}
 case "vaultRestoreWrite":{File stage=new File(context.getCacheDir(),"drive-restore-v1");if(!stage.isDirectory())throw new IOException("restore-required");DriveFiles d=new DriveFiles(stage);String path=q.getString("path");File target=d.resolve(path);File dir=target.getParentFile();Files.createDirectories(dir.toPath());byte[] b=Base64.decode(q.getString("bytes"),Base64.NO_WRAP);if(b.length>65531)throw new IOException("state-limit");if(allocated(stage,new int[]{0},LEGACY_BYTES)+b.length>LEGACY_BYTES||stage.getUsableSpace()<67108864L+b.length)throw new IOException("sync-size-limit");long offset=q.getLong("offset");if(offset<0||offset>LEGACY_BYTES)throw new IOException("invalid-path");try(RandomAccessFile out=new RandomAccessFile(target,"rw")){if(out.length()!=offset)throw new IOException("invalid-path");out.seek(offset);out.write(b);out.getFD().sync();}return new JSONObject();}
 case "vaultRestorePublish":{if(v==null||inventory().length()!=0)throw new IOException("unsynced-data");noUnpublished(cache);File stage=new File(context.getCacheDir(),"drive-restore-v1");DriveFiles d=new DriveFiles(stage);JSONArray rows=v.getJSONArray("entries");for(int i=0;i<rows.length();i++){JSONObject row=rows.getJSONObject(i);File f=d.resolve(row.getString("path"));if(row.getBoolean("directory")){Files.createDirectories(f.toPath());}else if(!f.isFile()||f.length()!=row.getLong("size")||!hash(f).equals(row.getString("sha256")))throw new IOException("restore-mismatch");}DriveFiles check=new DriveFiles(stage);JSONArray actual=new JSONArray();walk(check,"",actual,new long[]{0},LEGACY_BYTES);if(!equalInventory(actual,rows))throw new IOException("restore-mismatch");for(File f:allDirs(stage))sync(f);File empty=new File(context.getCacheDir(),"drive-empty-"+UUID.randomUUID());Files.move(cache.toPath(),empty.toPath(),StandardCopyOption.ATOMIC_MOVE);try{Files.move(stage.toPath(),cache.toPath(),StandardCopyOption.ATOMIC_MOVE);}catch(Exception e){Files.move(empty.toPath(),cache.toPath(),StandardCopyOption.ATOMIC_MOVE);throw e;}sync(cache.getParentFile());removeTree(empty);return new JSONObject();}
 default:throw new IOException("unsupported-operation");}}
 private List<File> allDirs(File dir)throws Exception{List<File> out=new ArrayList<>();for(File f:Objects.requireNonNull(dir.listFiles()))if(f.isDirectory())out.addAll(allDirs(f));out.add(dir);return out;}
}
