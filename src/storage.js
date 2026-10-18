const DB='kochi-dorm-v1';
let connection;
function db(){
  if(connection)return connection;
  connection=new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB,1);
    req.onupgradeneeded=()=>{req.result.createObjectStore('records');req.result.createObjectStore('photos');};
    req.onsuccess=()=>{const d=req.result;d.onversionchange=()=>d.close();resolve(d);};
    req.onerror=()=>{connection=null;reject(new Error('无法打开本机数据，请检查浏览器存储权限。'));};
    req.onblocked=()=>reject(new Error('存储正在被其他窗口占用，请关闭旧窗口后重试。'));
  });return connection;
}
async function operation(store,mode,run){
  const d=await db();return new Promise((resolve,reject)=>{
    const tx=d.transaction(store,mode),req=run(tx.objectStore(store));let result;
    req.onsuccess=()=>{result=req.result;};
    tx.oncomplete=()=>resolve(result);
    tx.onerror=()=>reject(new Error('本机保存失败，空间可能不足。请导出备份后重试。'));
    tx.onabort=()=>reject(new Error('保存被中断，数据未写入。'));
  });
}
export const loadLocal=key=>operation('records','readonly',s=>s.get(key));
export const saveLocal=(key,value)=>operation('records','readwrite',s=>s.put(value,key));
export const putPhoto=(id,blob)=>operation('photos','readwrite',s=>s.put(blob,id));
export const getPhoto=id=>operation('photos','readonly',s=>s.get(id));

// State, photos and revision are committed in one transaction. Two tabs cannot overwrite each other.
export async function saveWorkspace(key,state,revision,photos=[]) {
  const d=await db();
  return new Promise((resolve,reject)=>{
    const tx=d.transaction(['records','photos'],'readwrite');let conflict=false;
    const records=tx.objectStore('records'),req=records.get(key);
    req.onsuccess=()=>{
      if((req.result?.revision||0)!==revision){conflict=true;tx.abort();return;}
      for(const p of photos)tx.objectStore('photos').put(p.blob,p.id);
      records.put({state,revision:revision+1,savedAt:new Date().toISOString()},key);
    };
    tx.oncomplete=()=>resolve(revision+1);
    tx.onerror=()=>reject(new Error('本机保存失败，可能空间不足；本次修改未保存。'));
    tx.onabort=()=>reject(new Error(conflict?'其他窗口已更新本机数据。请刷新页面后重试，避免覆盖。':'保存被中断，本次修改未写入。'));
  });
}
