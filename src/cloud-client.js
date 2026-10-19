import {CLOUD_CONFIG, validateCloudConfig} from './cloud-config.js';
import {validateMeterRecognition} from './engine.js';

const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PHOTO = 8 * 1024 * 1024;
const SAFE_ERRORS = Object.freeze({
  AUTH_REQUIRED: '登录已过期，请重新登录。',
  WORKSPACE_NOT_FOUND: '当前账号无权打开这个云端数据区，或数据区不存在。',
  REVISION_CONFLICT: '另一台设备已更新数据。本次未覆盖，请刷新核对后重试。',
  STATE_INVALID: '云端资料未通过检查，请核对填写内容。',
  PHOTO_MISSING: '原照片尚未完整上传，资料未保存。请核对照片后重试。',
  BILL_FROZEN: '已确认月结的计算依据不能改写，请刷新核对。',
  PAYMENT_APPEND_ONLY: '已有收款不能删除或改写，请刷新核对。',
  OCR_NOT_CONFIGURED: 'AI识别尚未开通，请先手工输入；管理方需要配置服务器API密钥。',
  OCR_PAGE_OUTDATED: '抄表页面版本已过期，请刷新页面后重新拍照识别；仍可手工录入。',
  OCR_RATE_LIMITED: '识别次数已达到限制，请稍后再试，或手工录入。',
  OCR_PROVIDER_AUTH: 'AI服务密钥不可用，请联系管理方检查服务器配置。',
  OCR_PROVIDER_CREDIT: 'Anthropic API额度不足，请检查API账户余额或用量上限；仍可手工录入。',
  OCR_PROVIDER_RATE_LIMIT: 'Anthropic服务限流或达到API账户限额，请稍后重试或检查API账户；仍可手工录入。',
  OCR_PROVIDER_LIMIT: 'Anthropic服务未接受请求，请检查API账户或服务配置；仍可手工录入。',
  OCR_PROVIDER_MODEL: 'Anthropic未接受当前模型，请检查模型权限与服务配置；仍可手工录入。',
  OCR_PROVIDER_THINKING: 'Anthropic未接受thinking参数，请管理方调整服务配置；仍可手工录入。',
  OCR_PROVIDER_EFFORT: 'Anthropic未接受effort参数，请管理方调整服务配置；仍可手工录入。',
  OCR_PROVIDER_TOKENS: 'Anthropic未接受输出长度参数，请管理方调整服务配置；仍可手工录入。',
  OCR_PROVIDER_PARAMETERS: 'Anthropic未接受请求参数，请管理方检查服务配置；仍可手工录入。',
  OCR_PROVIDER_SCHEMA: 'Anthropic未接受识别结果格式，请管理方检查服务配置；仍可手工录入。',
  OCR_PROVIDER_IMAGE: 'Anthropic未能读取照片，请重新选择清晰的JPG或PNG照片；仍可手工录入。',
  INTERVAL_INVALID:'区间结算内容无效，请重新核对。',
  INTERVAL_INPUTS_MISMATCH:'区间结算依据不一致，请刷新核对。',
  BILL_COVERAGE_OVERLAP:'这个区间已结算过，不能重复收费。',
  ONE_CONFIRMATION_PER_SAVE:'每次只确认一段费用。',
  METER_PROFILE_REQUIRED:'表资料已改变，请刷新并保留当前配置。',
  MOVEMENT_APPEND_ONLY:'已保存的人员进出记录不能改写。',
  ONE_MOVEMENT_PER_SAVE:'每次办理一位人员的入住或搬出。',
  MOVEMENT_INVALID:'人员进出与抄表资料不一致，请重新核对。',
  TASK_UNAVAILABLE:'抄表任务不可用、已过期或已撤销，请刷新任务列表。',
  TASK_CLOSED:'抄表任务已提交或关闭，请刷新核对，不能重复提交。',
  TASK_CHANGED:'抄表任务或指引已变化，请刷新后核对。',
  TASK_LIMIT:'今日创建任务次数已达限制，请稍后再试。',
  METER_CONFIG_REQUIRED:'请先在设置中填好电表和气表的可信表号、位置。',
  SERIAL_REVIEW_REQUIRED:'表号未自动核对通过，请对照原照片填写复核说明。',
  TASK_READING_MISMATCH:'采用的表数或照片与待审核资料不一致，请刷新核对。',
  OCR_UNAVAILABLE: 'AI服务暂时不可用，本次不会自动重试，请手工核对或稍后重新识别。',
  OCR_INVALID_RESULT: 'AI未能可靠识别，请重拍清晰照片，或手工输入。',
  PHOTO_INVALID: '识别照片格式或大小无效，请重新拍照。'
});

export class CloudError extends Error {
  constructor(code, message) {super(message); this.name = 'CloudError'; this.code = code;}
}
const fail = (code, message) => new CloudError(code, message);
const changed = () => fail('SESSION_CHANGED', '登录或数据区已改变，本次结果已停止显示。请重新打开云端数据。');
const uncertain = () => fail('SAVE_UNCERTAIN', '尚不能确认云端是否已保存。为避免重复收款，请先刷新核对，再决定是否重试。');
const expired = () => fail('AUTH_EXPIRED', '登录已过期，请重新登录后再打开云端数据。');
const publicUser = user => user && UUID.test(user.id || '') ? {id: user.id, email: typeof user.email === 'string' ? user.email : ''} : null;
const validTokens = data => data && typeof data.access_token === 'string' && data.access_token.length > 0 && data.access_token.length <= 16384 &&
  typeof data.refresh_token === 'string' && data.refresh_token.length > 0 && data.refresh_token.length <= 16384;

export function createCloudClient(options = {}) {
  if (options && Object.hasOwn(options, 'supabaseUrl')) options = {config: options};
  let {config = CLOUD_CONFIG, fetchImpl = globalThis.fetch?.bind(globalThis), storage, now = () => Date.now(), timeoutMs = 15000, ocrProvider} = options;
  const settings = validateCloudConfig(config);
  if (!settings) {
    const unavailable = async () => {throw fail('CLOUD_NOT_CONFIGURED', '独立云端项目尚未配置，请先使用示例或本机数据。');};
    return Object.freeze({configured: false, signIn: unavailable, getUser: unavailable, refreshSession: unavailable,
      signOut: async () => ({remoteRevoked: true}), hasSession: () => false, getSessionInfo: () => null,
      listWorkspaces: unavailable, loadWorkspace: unavailable, saveWorkspace: unavailable, uploadPhoto: unavailable, getPhoto: unavailable, ocrStatus: unavailable, recognizeMeters: unavailable, listMeterTasks:unavailable,createMeterTask:unavailable,revokeMeterTask:unavailable,adoptMeterTask:unavailable});
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('当前浏览器不支持云端连接。');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('请求时限无效。');
  if (storage === undefined) {try {storage = globalThis.sessionStorage;} catch {storage = null;}}
  const sessionKey = `kochi-dorm-cloud-session-v1:${settings.supabaseUrl}`;
  let session = null, generation = 0, refreshFlight = null;
  const pending = new Set();

  function clearStored() {try {storage?.removeItem(sessionKey);} catch {}}
  function invalidate() {
    generation++; session = null; refreshFlight = null; clearStored();
    for (const controller of pending) controller.abort();
  }
  function check(captured) {if (captured !== generation) throw changed();}
  function setSession(data, captured) {
    check(captured);
    if (!validTokens(data)) throw fail('BAD_RESPONSE', '登录服务返回的数据不完整，请重新登录。');
    const expiresAt = Number(data.expires_at) || Math.floor(now() / 1000) + Number(data.expires_in || 3600);
    if (!Number.isFinite(expiresAt)) throw fail('BAD_RESPONSE', '登录服务返回的数据不完整，请重新登录。');
    session = {access_token: data.access_token, refresh_token: data.refresh_token, expires_at: expiresAt, user: publicUser(data.user)};
    try {storage?.setItem(sessionKey, JSON.stringify(session));} catch {}
    return session.user;
  }
  try {
    const saved = JSON.parse(storage?.getItem(sessionKey) || 'null');
    if (validTokens(saved) && Number.isFinite(saved.expires_at)) session = {...saved, user: publicUser(saved.user)};
    else clearStored();
  } catch {clearStored();}

  async function send(path, {method = 'GET', body, token, contentType, extraHeaders, captured = generation, mutation = false, deadlineMs = timeoutMs} = {}) {
    check(captured);
    const controller = new AbortController(); pending.add(controller);
    let timer;
    const timedOut = new Promise((_, reject) => {timer = setTimeout(() => {controller.abort(); reject(fail('TIMEOUT', '云端连接超时，请稍后重试。'));}, deadlineMs);});
    try {
      const headers = {'apikey': settings.supabasePublishableKey, ...extraHeaders};
      if (token) headers.Authorization = `Bearer ${token}`;
      if (contentType) headers['Content-Type'] = contentType;
      const response = await Promise.race([fetchImpl(settings.supabaseUrl + path, {method, headers, body, signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error'}), timedOut]);
      check(captured);
      return response;
    } catch (error) {
      check(captured);
      if (mutation) throw uncertain();
      if (error instanceof CloudError) throw error;
      throw fail('NETWORK_ERROR', '暂时无法连接云端，请检查网络后重试。');
    } finally {clearTimeout(timer); pending.delete(controller);}
  }
  async function readBody(response, kind, captured) {
    let timer;
    try {
      return await Promise.race([response[kind](), new Promise((_, reject) => {timer = setTimeout(() => {
        try {response.body?.cancel()?.catch(() => {});} catch {}
        reject(fail('TIMEOUT', '云端返回超时，请刷新核对后重试。'));
      }, timeoutMs);})]);
    } finally {clearTimeout(timer); check(captured);}
  }
  async function parse(response, captured) {
    let data;
    try {data = await readBody(response, 'json', captured);} catch (error) {check(captured); if (error instanceof CloudError) throw error; throw fail('BAD_RESPONSE', '云端返回的数据无法读取，请刷新重试。');}
    check(captured); return data;
  }
  function responseError(status, mutation) {
    if (status === 403) return fail('MEMBER_REQUIRED', '此账号未获宿舍管理权限，或权限已撤销。请联系管理方。');
    if (status === 409) return fail('REVISION_CONFLICT', '另一台设备已更新数据。本次未覆盖，请刷新核对后重试。');
    if (status === 413) return fail('PAYLOAD_TOO_LARGE', '提交内容过大，请减少照片大小后重试。');
    if (status === 429) return fail('RATE_LIMITED', '操作过于频繁，请稍后重试。');
    if (mutation && (status === 408 || status >= 500)) return uncertain();
    if (status >= 500) return fail('SERVER_ERROR', '云端暂时不可用，请稍后重试。');
    return fail('REQUEST_REJECTED', '云端未接受本次操作，请核对资料后重试。');
  }
  async function serverError(response, captured, mutation) {
    if(mutation&&(response.status===408||response.status>=500))return uncertain();
    if ([400, 402, 403, 404, 409, 422, 429, 502, 503].includes(response.status)) {
      try {
        const code = (await parse(response, captured))?.error?.code;
        if (Object.hasOwn(SAFE_ERRORS, code)) return fail(code, SAFE_ERRORS[code]);
      } catch {check(captured);}
    }
    return responseError(response.status, mutation);
  }
  async function refreshSession() {
    const captured = generation;
    if (!session) throw expired();
    if (refreshFlight) return refreshFlight;
    const refreshToken = session.refresh_token;
    const flight = (async () => {
      const response = await send('/auth/v1/token?grant_type=refresh_token', {method: 'POST', contentType: 'application/json', body: JSON.stringify({refresh_token: refreshToken}), captured});
      if (response.status === 400 || response.status === 401) {check(captured); invalidate(); throw expired();}
      if (!response.ok) throw responseError(response.status, false);
      const data = await parse(response, captured); setSession(data, captured);
      return getSessionInfo();
    })();
    refreshFlight = flight;
    try {return await flight;} finally {if (refreshFlight === flight) refreshFlight = null;}
  }
  async function authed(path, options = {}) {
    const captured = generation;
    if (!session) throw expired();
    if (session.expires_at * 1000 <= now() + 30000) await refreshSession();
    check(captured);
    let token = session.access_token;
    let response = await send(path, {...options, token, captured});
    if (response.status === 401) {
      check(captured);
      if(options.noRetry){invalidate();throw expired();}
      if (session?.access_token === token) {
        try {await refreshSession();} catch (error) {
          if (options.mutation && !['SESSION_CHANGED', 'AUTH_EXPIRED'].includes(error.code)) throw uncertain();
          throw error;
        }
      }
      check(captured);
      if (options.mutation) throw uncertain();
      token = session.access_token;
      response = await send(path, {...options, token, captured});
      if (response.status === 401) {check(captured); invalidate(); throw expired();}
    }
    if (!response.ok) throw await serverError(response, captured, options.mutation);
    return {response, captured};
  }
  function identifier(value) {if (typeof value !== 'string' || !UUID.test(value)) throw fail('INVALID_ID', '云端记录编号无效，请刷新后重试。'); return value;}
  function getSessionInfo() {return session ? {user: session.user ? {...session.user} : null, expiresAt: session.expires_at, generation} : null;}
  async function signIn(email, password) {
    if (typeof email !== 'string' || !email.trim() || email.length > 254 || typeof password !== 'string' || !password || password.length > 4096) throw fail('INVALID_LOGIN', '请输入邮箱和密码。');
    invalidate(); const captured = generation;
    const response = await send('/auth/v1/token?grant_type=password', {method: 'POST', body: JSON.stringify({email: email.trim(), password}), contentType: 'application/json', captured});
    if (!response.ok) {
      if (response.status === 400 || response.status === 401) throw fail('LOGIN_FAILED', '登录未成功，请核对邮箱、密码或确认邮箱状态。');
      throw responseError(response.status, false);
    }
    return setSession(await parse(response, captured), captured);
  }
  async function getUser() {
    const {response, captured} = await authed('/auth/v1/user');
    const user = publicUser(await parse(response, captured));
    if (!user) throw fail('BAD_RESPONSE', '无法确认登录账号，请重新登录。');
    check(captured); session.user = user;
    try {storage?.setItem(sessionKey, JSON.stringify(session));} catch {}
    return {...user};
  }
  async function signOut() {
    const token = session?.access_token;
    invalidate(); const captured = generation;
    if (!token) return {remoteRevoked: true};
    try {
      const response = await send('/auth/v1/logout?scope=local', {method: 'POST', token, captured});
      return {remoteRevoked: response.ok};
    } catch {return {remoteRevoked: false};}
  }
  async function jsonRequest(path, options) {
    const {response, captured} = await authed(path, options);
    try {const result = await parse(response, captured); check(captured); return result;} catch (error) {if (options?.mutation && error.code !== 'SESSION_CHANGED') throw uncertain(); throw error;}
  }
  function workspaceResult(data, workspaceId) {
    if (!data || data.workspace?.id !== workspaceId || !Number.isSafeInteger(data.revision) || data.revision < 0 ||
      data.state !== null && (!data.state || data.state.mode !== 'cloud')) throw fail('BAD_RESPONSE', '云端数据区返回格式不正确，请刷新核对。');
    return data;
  }
  async function listWorkspaces() {
    const captured = generation;
    const data = await jsonRequest('/functions/v1/workspace');
    check(captured);
    if (!Array.isArray(data?.workspaces) || data.workspaces.some(w => !w || !UUID.test(w.id || '') || typeof w.name !== 'string')) throw fail('BAD_RESPONSE', '无法读取云端数据区列表，请刷新重试。');
    return data;
  }
  async function loadWorkspace(workspaceId) {
    const captured = generation;
    const data = await jsonRequest(`/functions/v1/workspace?workspaceId=${identifier(workspaceId)}`);
    check(captured); return workspaceResult(data, workspaceId);
  }
  async function saveWorkspace(workspaceId, state, expectedRevision) {
    const captured = generation;
    identifier(workspaceId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || state?.mode !== 'cloud') throw fail('INVALID_STATE', '云端数据或版本无效，请刷新核对。');
    let body;
    try {body = JSON.stringify({workspaceId, expectedRevision, state});} catch {throw fail('INVALID_STATE', '云端资料格式无效。');}
    const result = await jsonRequest('/functions/v1/workspace', {method: 'POST', contentType: 'application/json', body, mutation: true});
    check(captured);
    try {return workspaceResult(result, workspaceId);} catch {throw uncertain();}
  }
  async function uploadPhoto(workspaceId, photoId, file) {
    const captured = generation;
    identifier(workspaceId); identifier(photoId);
    if (!(file instanceof Blob) || !PHOTO_TYPES.has(file.type) || !file.size || file.size > MAX_PHOTO) throw fail('INVALID_PHOTO', '照片限 JPG / PNG / WebP / GIF，每张最多8 MB。');
    await authed(`/storage/v1/object/dorm-photos/${workspaceId}/${photoId}`, {method: 'POST', contentType: file.type, body: file, extraHeaders: {'x-upsert': 'false'}, mutation: true});
    check(captured);
    return {id: photoId};
  }
  async function getPhoto(workspaceId, photoId) {
    identifier(workspaceId); identifier(photoId);
    const {response, captured} = await authed(`/storage/v1/object/authenticated/dorm-photos/${workspaceId}/${photoId}`);
    let blob;
    try {blob = await readBody(response, 'blob', captured);} catch {check(captured); throw fail('PHOTO_UNAVAILABLE', '原照片读取失败，请刷新后重试。');}
    check(captured);
    if (!PHOTO_TYPES.has(blob.type) || !blob.size || blob.size > MAX_PHOTO) throw fail('INVALID_PHOTO', '云端原照片格式或大小不符合要求。');
    return blob;
  }
  function taskRecord(value){
    if(!value||!UUID.test(value.id||'')||typeof value.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value.date)||!Number.isFinite(Date.parse(value.date))||new Date(value.date).toISOString().slice(0,10)!==value.date||!['open','submitted','adopted','revoked','expired'].includes(value.status)||typeof value.expiresAt!=='string'||!Number.isFinite(Date.parse(value.expiresAt)))throw fail('BAD_RESPONSE','抄表任务信息无效，请刷新列表。');
    return value;
  }
  async function listMeterTasks(workspaceId){
    identifier(workspaceId);const data=await jsonRequest(`/functions/v1/meter-task?action=list&workspaceId=${workspaceId}`);
    if(!Array.isArray(data?.tasks)||data.tasks.length>200)throw fail('BAD_RESPONSE','抄表任务列表无效。');data.tasks.forEach(taskRecord);if(new Set(data.tasks.map(t=>t.id)).size!==data.tasks.length)throw fail('BAD_RESPONSE','抄表任务列表无效。');return data;
  }
  async function createMeterTask(workspaceId,expectedRevision){
    identifier(workspaceId);if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw fail('INVALID_STATE','云端版本无效，请刷新核对。');const data=await jsonRequest('/functions/v1/meter-task',{method:'POST',contentType:'application/json',mutation:true,noRetry:true,body:JSON.stringify({action:'create',workspaceId,expectedRevision,expiresInHours:24})});
    try{taskRecord(data?.task);if(data.task.status!=='open'||typeof data.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(data.token))throw uncertain();return data;}catch{throw uncertain();}
  }
  async function revokeMeterTask(workspaceId,taskId,expectedRevision){
    identifier(workspaceId);identifier(taskId);if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw fail('INVALID_STATE','云端版本无效，请刷新核对。');const data=await jsonRequest('/functions/v1/meter-task',{method:'POST',contentType:'application/json',mutation:true,noRetry:true,body:JSON.stringify({action:'revoke',workspaceId,taskId,expectedRevision})});try{taskRecord(data?.task);if(data.task.id!==taskId||data.task.status!=='revoked')throw uncertain();return data;}catch{throw uncertain();}
  }
  async function adoptMeterTask(workspaceId,taskId,state,expectedRevision,reviewNote=''){
    if(state?.mode!=='cloud')throw fail('INVALID_STATE','云端数据无效，请刷新核对。');
    identifier(workspaceId);identifier(taskId);if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw fail('INVALID_STATE','云端版本无效，请刷新核对。');const data=await jsonRequest('/functions/v1/meter-task',{method:'POST',contentType:'application/json',mutation:true,noRetry:true,body:JSON.stringify({action:'adopt',workspaceId,taskId,expectedRevision,state,reviewNote})});try{workspaceResult(data,workspaceId);if(data?.adoptedTaskId!==taskId||data.revision!==expectedRevision+1||data.state===null)throw uncertain();return data;}catch{throw uncertain();}
  }
  async function ocrStatus(workspaceId, checkProtocol = false) {
    if(ocrProvider!=='Anthropic')throw fail('OCR_PAGE_OUTDATED',SAFE_ERRORS.OCR_PAGE_OUTDATED);
    identifier(workspaceId);
    if(typeof checkProtocol!=='boolean')throw fail('BAD_RESPONSE','AI服务检查选项无效。');
    const data=await jsonRequest(`/functions/v1/meter-ocr?workspaceId=${workspaceId}${checkProtocol?'&check=protocol':''}`);
    if(data?.workspaceId!==workspaceId||typeof data.available!=='boolean'||data.provider!=='Anthropic'||data.dailyLimit!==12)
      throw fail('BAD_RESPONSE','无法确认AI识别服务状态，仍可手工录入。');
    if(checkProtocol&&(data.available!==true||data.protocolChecked!==true||data.generationVerified!==false||JSON.stringify(data.modelsChecked)!==JSON.stringify(['claude-haiku-5-5','claude-sonnet-5-5'])))
      throw fail('BAD_RESPONSE','服务预检尚未确认，请刷新页面；仍可手工录入。');
    return data;
  }
  async function recognizeMeters(workspaceId,expectedRevision,photos) {
    if(ocrProvider!=='Anthropic')throw fail('OCR_PAGE_OUTDATED',SAFE_ERRORS.OCR_PAGE_OUTDATED);
    identifier(workspaceId);
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||!Array.isArray(photos)||photos.length!==2||
      new Set(photos.map(p=>p?.kind)).size!==2||photos.some(p=>!['electric','gas'].includes(p?.kind)||
        !['image/jpeg','image/png','image/webp'].includes(p.mimeType)||typeof p.data!=='string'||!p.data.length||p.data.length>2097152))
      throw fail('INVALID_PHOTO','请分别选择电表和燃气表两张清晰照片。');
    const captured=generation;
    let data;
    try {
      data=await jsonRequest('/functions/v1/meter-ocr',{method:'POST',contentType:'application/json',
        body:JSON.stringify({workspaceId,expectedRevision,provider:'Anthropic',photos:photos.map(({kind,mimeType,data})=>({kind,mimeType,data}))}),deadlineMs:60000,noRetry:true});
    } catch(error) {
      check(captured);
      if(['TIMEOUT','NETWORK_ERROR','SERVER_ERROR'].includes(error.code))throw fail('OCR_UNAVAILABLE',SAFE_ERRORS.OCR_UNAVAILABLE);
      throw error;
    }
    check(captured);
    if(data?.workspaceId!==workspaceId||data.revision!==expectedRevision||!data.readings||
      Object.keys(data.readings).length!==2||!['electric','gas'].every(k=>Object.hasOwn(data.readings,k)))
      throw fail('BAD_RESPONSE','识别结果不属于当前宿舍或版本，请重新读取后核对。');
    try {
      const tried=data.modelsTried,primary='claude-haiku-5-5',review='claude-sonnet-5-5';
      if(data.provider!=='Anthropic'||!Array.isArray(tried)||![1,2].includes(tried.length)||tried[0]!==primary||
        tried.length===2&&tried[1]!==review||data.upgraded!==(tried.length===2)||data.model!==tried.at(-1)||
        !data.models||typeof data.models!=='object'||Array.isArray(data.models)||Object.keys(data.models).length!==2||
        !['electric','gas'].every(kind=>Object.hasOwn(data.models,kind)&&tried.includes(data.models[kind]))||
        !(data.reviewWarning===null||data.upgraded&&data.reviewWarning==='升级复核未完成，请人工核对未读清项。'))
        throw new Error('Unsupported OCR provider or model routing.');
      for(const kind of ['electric','gas'])validateMeterRecognition({version:1,provider:data.provider,model:data.models[kind],
        recognizedAt:data.recognizedAt,requestId:data.requestId,result:data.readings[kind]},kind);
    }catch {throw fail('OCR_INVALID_RESULT',SAFE_ERRORS.OCR_INVALID_RESULT);}
    return data;
  }
  return Object.freeze({configured: true, signIn, getUser, refreshSession, signOut, hasSession: () => !!session, getSessionInfo, listWorkspaces, loadWorkspace, saveWorkspace, uploadPhoto, getPhoto, ocrStatus, recognizeMeters,listMeterTasks,createMeterTask,revokeMeterTask,adoptMeterTask});
}
