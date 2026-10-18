import {validateState} from './engine.js';

const fail=(code,message)=>Object.assign(new Error(message),{code});
const copy=value=>structuredClone(value);
function cloudState(state) {
  if(state?.mode!=='cloud') throw fail('INVALID_STATE','只允许独立的云端数据，不能自动上传本机或示例数据。');
  try {return validateState(copy(state));}
  catch {throw fail('INVALID_STATE','云端数据内容无效，请核对资料。');}
}
function workspace(value) {
  if(!value||typeof value.id!=='string'||!value.id||typeof value.name!=='string'||!value.name.trim())
    throw fail('INVALID_RESPONSE','云端宿舍资料无效。');
  return {id:value.id,name:value.name};
}
function record(value,id) {
  const home=workspace(value?.workspace);
  if(home.id!==id||!Number.isSafeInteger(value.revision)||value.revision<0||
    !(value.savedAt===null&&value.revision===0||typeof value.savedAt==='string'&&Number.isFinite(Date.parse(value.savedAt))))
    throw fail('INVALID_RESPONSE','云端返回了不匹配的宿舍或保存版本。');
  if(value.state===null&&value.revision!==0) throw fail('INVALID_RESPONSE','云端数据版本不完整。');
  return {workspace:home,revision:value.revision,state:value.state===null?null:cloudState(value.state),savedAt:value.savedAt};
}

// Selection epochs invalidate every late completion, including failed requests.
export function createCloudWorkspace(client) {
  let epoch=0,user=null,allowed=new Map(),current=null,blocked=false,saving=false;
  const guard=ticket=>{if(ticket!==epoch) throw fail('STALE_OPERATION','页面已切换，请重新打开云端宿舍。');};
  const clear=()=>{epoch++;current=null;blocked=false;saving=false;};
  const leave=()=>{clear();allowed=new Map();user=null;};
  const selected=()=>{
    if(!current) throw fail('NO_WORKSPACE','请先选择并读取云端宿舍。');
    return {ticket:epoch,id:current.workspace.id,revision:current.revision};
  };
  return {
    async open() {
      clear();user=null;allowed=new Map();const ticket=epoch;
      try {
        if(!client.hasSession()) throw fail('AUTH_REQUIRED','请先登录云端账号。');
        const nextUser=await client.getUser();guard(ticket);
        if(!nextUser?.id||typeof nextUser.email!=='string') throw fail('INVALID_RESPONSE','云端账号资料无效。');
        const result=await client.listWorkspaces();guard(ticket);
        if(!Array.isArray(result?.workspaces)) throw fail('INVALID_RESPONSE','云端宿舍列表无效。');
        const homes=result.workspaces.map(item=>{
          const home=workspace(item);
          if(item.role!=='admin'||!Number.isSafeInteger(item.revision)||item.revision<0)
            throw fail('INVALID_RESPONSE','云端宿舍授权或版本无效。');
          return {...home,revision:item.revision,savedAt:item.savedAt,role:item.role};
        });
        if(new Set(homes.map(home=>home.id)).size!==homes.length) throw fail('INVALID_RESPONSE','云端宿舍编号重复。');
        user={id:nextUser.id,email:nextUser.email};allowed=new Map(homes.map(home=>[home.id,home]));
        return {user:copy(user),workspaces:copy(homes)};
      } catch(error) {guard(ticket);throw error;}
    },
    async load(workspaceId) {
      if(!allowed.has(workspaceId)) throw fail('FORBIDDEN','当前账号无权打开此宿舍。');
      clear();const ticket=epoch;
      try {
        const loaded=record(await client.loadWorkspace(workspaceId),workspaceId);guard(ticket);
        current=loaded;return copy(loaded);
      } catch(error) {guard(ticket);throw error;}
    },
    async save(next,expectedRevision,photos=[]) {
      const {ticket,id,revision}=selected();
      if(blocked) throw fail('RELOAD_REQUIRED','保存结果需要核对，请重新读取云端数据后再修改。');
      if(saving) throw fail('SAVE_IN_PROGRESS','上一次保存仍在处理中。');
      if(expectedRevision!==revision) {
        blocked=true;throw fail('REVISION_CONFLICT','云端版本已变化，请重新读取后再修改。');
      }
      const state=cloudState(next);
      if(!Array.isArray(photos)||photos.some(photo=>typeof photo?.id!=='string'||!photo.id||!(photo.blob instanceof Blob))||
        new Set(photos.map(photo=>photo.id)).size!==photos.length) throw fail('INVALID_PHOTO','抄表照片格式无效。');
      saving=true;let submitted=false;
      try {
        for(const photo of photos) {await client.uploadPhoto(id,photo.id,photo.blob);guard(ticket);}
        guard(ticket);submitted=true;
        const value=await client.saveWorkspace(id,state,revision);guard(ticket);
        const saved=record(value,id);
        if(saved.revision!==revision+1||saved.state===null) throw fail('INVALID_RESPONSE','云端保存版本不匹配。');
        current=saved;return copy(saved);
      } catch(error) {
        guard(ticket);
        if(submitted&&['INVALID_RESPONSE','INVALID_STATE'].includes(error.code))
          error=fail('SAVE_UNCERTAIN','保存响应异常，请重新读取云端数据核对结果。');
        if(['REVISION_CONFLICT','SAVE_UNCERTAIN'].includes(error.code)) blocked=true;
        throw error;
      } finally {if(ticket===epoch) saving=false;}
    },
    async photo(photoId) {
      const {ticket,id}=selected();
      try {const blob=await client.getPhoto(id,photoId);guard(ticket);return blob;}
      catch(error) {guard(ticket);throw error;}
    },
    leave,
    async signOut() {leave();await client.signOut();},
    info() {return Object.freeze({workspaceId:current?.workspace.id??null,revision:current?.revision??null,blocked});}
  };
}
