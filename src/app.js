import {FEES,calculateMonth,euros,monthBounds,shiftMonth,today,validateState} from './engine.js';
import {confirmMonth,exampleState,id,newLocalState,paidFor,photoIds,recordPayment,suggestedMonth,validateBackup} from './model.js';
import {getPhoto,loadLocal,saveWorkspace} from './storage.js';
import {createCloudClient} from './cloud-client.js';
import {CLOUD_CONFIG} from './cloud-config.js';
import {createCloudWorkspace} from './cloud-workspace.js';

const app=document.querySelector('#app');
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icons={home:'M3 10 12 3l9 7v11h-6v-7H9v7H3Z',people:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m14-13a4 4 0 0 1 0 8m6 5v-2a4 4 0 0 0-3-3M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',meter:'M4 7h16v14H4ZM8 3h8v4H8Zm0 8h8m-8 5h2m4 0h2',settings:'M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6m-6 0v6',wallet:'M3 6h17v15H3Zm0 0V3h14v3m-1 6h5v5h-5Z',box:'M3 7 12 3l9 4v14H3Zm0 0 9 4 9-4M12 11v10'};
const icon=name=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${icons[name]||icons.home}"/></svg>`;
const pages=[['dashboard','home','月结工作台','从抄表到结算，每月清楚一点。'],['residents','people','住户与入住','按实际入住日期，计算每一天。'],['readings','meter','抄表记录','保留原照片，手工核对每一个数字。'],['rates','settings','合同费率','按生效月份管理，保留历史依据。'],['payments','wallet','收款记录','每笔实际到账，都有清楚的记录。'],['backup','box','本机数据','备份住户、结算和原始抄表照片。']];
const cloud=createCloudClient({config:CLOUD_CONFIG}),cloudWorkspace=createCloudWorkspace(cloud);
let state,revision=0,month,editing=null,mode='demo',busy=false,urls=[],renderToken=0,viewEpoch=0;
let cloudUser=null,cloudChoices=[],cloudSelected=null,cloudSavedAt=null,cloudLoading=false,cloudError='';
const cloudEnabled=Boolean(CLOUD_CONFIG.supabaseUrl&&CLOUD_CONFIG.supabasePublishableKey);
const modeName=()=>mode==='cloud'?'云端数据':mode==='demo'?'示例数据':'本机数据';
const pageLabel=(key,label)=>mode==='cloud'&&key==='backup'?'数据与备份':label;
function clearPrivateView(){clearTimeout(notice.timer);const noticeEl=document.querySelector('#notice');noticeEl.textContent='';noticeEl.className='';urls.forEach(URL.revokeObjectURL);urls=[];renderToken++;document.querySelector('#print-root').replaceChildren();}
function readPhoto(key){return mode==='cloud'?cloudWorkspace.photo(key):getPhoto(key);}

try{const remembered=localStorage.getItem('kochi-dorm-mode');mode=remembered==='local'?'local':remembered==='cloud'&&cloudEnabled?'cloud':'demo';}catch{}
const current=()=>pages.find(p=>p[0]===location.hash.slice(2))||pages[0];
const bill=()=>state?.bills.find(b=>b.month===month);
const badge=(text,tone='')=>`<span class="badge ${tone}">${esc(text)}</span>`;
const empty=(title,text,link,label)=>`<div class="empty"><div class="empty-symbol">${icon('home')}</div><h3>${esc(title)}</h3><p>${esc(text)}</p>${link?`<a class="button primary" href="#/${link}">${esc(label)}</a>`:''}</div>`;
const field=(label,name,value='',type='text',extra='')=>`<label class="field"><span>${label}</span><input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
const check=(name,label,checked=false)=>`<label class="check"><input type="checkbox" name="${name}" ${checked?'checked':''}><span>${label}</span></label>`;
const option=(value,label,selected)=>`<option value="${esc(value)}" ${selected?'selected':''}>${esc(label)}</option>`;
const note=(text,tone='')=>`<div class="callout ${tone}">${text}</div>`;
const photo=(p,alt)=>p?`<img class="meter-photo" data-photo="${esc(p.id)}" alt="${esc(alt)}"><small>文件时间：${esc(p.fileDate||'未提供')} · 添加于 ${esc(p.addedAt?.slice(0,10)||'未知')}</small>`:'';
function notice(message,error=false){const el=document.querySelector('#notice');el.textContent=message;el.className=error?'show error':'show';clearTimeout(notice.timer);notice.timer=setTimeout(()=>el.className='',error?12000:4500);}

const authGateCodes=new Set(['AUTH_REQUIRED','AUTH_EXPIRED','UNAUTHORIZED','FORBIDDEN','MEMBER_REQUIRED','WORKSPACE_NOT_FOUND']);
function stale(){const e=new Error('数据来源已切换，本次结果不再显示。');e.code='STALE_OPERATION';return e;}
function checkView(epoch){if(epoch!==viewEpoch)throw stale();}
function rememberMode(){try{localStorage.setItem('kochi-dorm-mode',mode);}catch{}}
function gateFailure(error){
  if(error.code==='STALE_OPERATION')return;
  cloudError=error.message||'云端连接失败，请重试。';cloudLoading=false;
  if(authGateCodes.has(error.code)){
    viewEpoch++;busy=false;app.removeAttribute('aria-busy');clearPrivateView();cloudWorkspace.leave();state=undefined;cloudSelected=null;
    cloudUser=null;cloudChoices=[];cloudSavedAt=null;
  }
}
async function task(fn){
  if(busy)return;const epoch=viewEpoch;busy=true;app.setAttribute('aria-busy','true');
  app.querySelectorAll('button[type=submit]').forEach(b=>b.disabled=true);
  try{await fn(epoch);}catch(e){
    if(epoch===viewEpoch&&e.code!=='STALE_OPERATION'){
      if(mode==='cloud'&&authGateCodes.has(e.code)){gateFailure(e);render();}
      notice(e.message||'操作失败，请重试。',true);
    }
  }finally{
    if(epoch===viewEpoch){busy=false;app.removeAttribute('aria-busy');app.querySelectorAll('button[type=submit]').forEach(b=>b.disabled=false);}
  }
}
async function commit(next,photos=[],expectedEpoch=viewEpoch){
  checkView(expectedEpoch);
  if(next.mode!==mode)throw new Error('数据区不一致，请刷新后重试。');
  validateState(next);const epoch=expectedEpoch;
  if(mode==='cloud'){
    const saved=await cloudWorkspace.save(next,revision,photos);checkView(epoch);
    state=saved.state;revision=saved.revision;cloudSavedAt=saved.savedAt;
  }else{const rev=await saveWorkspace(mode,next,revision,photos);checkView(epoch);state=next;revision=rev;}
  editing=null;render();notice(mode==='cloud'?'已保存到云端':'已保存到本机浏览器');
}
async function openMode(nextMode){
  if(!['demo','local'].includes(nextMode))throw new Error('无效的数据区。');
  const epoch=++viewEpoch;busy=false;app.removeAttribute('aria-busy');cloudWorkspace.leave();clearPrivateView();state=undefined;
  mode=nextMode;cloudSelected=null;cloudSavedAt=null;app.innerHTML='<p class="loading">正在打开本机数据…</p>';
  try{
  const saved=await loadLocal(nextMode);checkView(epoch);
  const nextState=saved?.state||(nextMode==='demo'?exampleState():newLocalState());
  validateState(nextState);if(nextState.mode!==nextMode)throw new Error('本机数据区标识不一致，请检查备份。');
  let nextRevision=saved?.revision||0;if(!saved)nextRevision=await saveWorkspace(nextMode,nextState,nextRevision);
  checkView(epoch);state=nextState;revision=nextRevision;month=suggestedMonth(state);editing=null;rememberMode();render();
  }catch(e){if(epoch!==viewEpoch||e.code==='STALE_OPERATION')return;busy=false;app.removeAttribute('aria-busy');app.innerHTML=`<section class="cloud-gate"><h1>本机数据未能打开</h1><p>${esc(e.message)}</p><button class="button secondary" data-action="open-cloud">打开云端登录</button><p>本机记录未被替换。请保留当前浏览器数据并刷新重试。</p></section>`;}
}
async function selectCloud(workspaceId){
  const epoch=++viewEpoch;busy=false;app.removeAttribute('aria-busy');clearPrivateView();state=undefined;cloudLoading=true;cloudError='';render();
  try{
    const saved=await cloudWorkspace.load(workspaceId);checkView(epoch);
    const next=saved.state||{...newLocalState(),mode:'cloud'};validateState(next);
    if(next.mode!=='cloud')throw new Error('云端返回的数据区不正确。');
    state=next;revision=saved.revision;cloudSelected=saved.workspace;cloudSavedAt=saved.savedAt;
    month=suggestedMonth(state);editing=null;cloudLoading=false;render();
  }catch(e){if(epoch!==viewEpoch||e.code==='STALE_OPERATION')return;gateFailure(e);render();}
}
async function openCloud(){
  const epoch=++viewEpoch;busy=false;app.removeAttribute('aria-busy');cloudWorkspace.leave();clearPrivateView();state=undefined;
  mode='cloud';cloudSelected=null;cloudSavedAt=null;cloudUser=null;cloudChoices=[];cloudError='';rememberMode();
  if(!cloudEnabled){cloudLoading=false;render();return;}
  if(!cloud.hasSession()){cloudLoading=false;render();return;}
  cloudLoading=true;render();
  try{
    const opened=await cloudWorkspace.open();checkView(epoch);cloudUser=opened.user;cloudChoices=opened.workspaces;
    cloudLoading=false;
    if(cloudChoices.length===1)await selectCloud(cloudChoices[0].id);else render();
  }catch(e){if(epoch!==viewEpoch||e.code==='STALE_OPERATION')return;gateFailure(e);render();}
}
async function signOutCloud(){
  const epoch=++viewEpoch;busy=false;app.removeAttribute('aria-busy');clearPrivateView();state=undefined;cloudSelected=null;cloudSavedAt=null;
  cloudUser=null;cloudChoices=[];cloudError='';cloudLoading=false;mode='cloud';render();
  try{await cloudWorkspace.signOut();}catch{}
  if(epoch===viewEpoch){render();notice('已退出云端登录');}
}
function renderCloudGate(){
  clearPrivateView();
  let body;
  if(!cloudEnabled)body=note('云端连接正在准备。当前仍可使用独立的示例演练和本机数据；本机资料不会自动上传。');
  else if(cloudLoading)body='<p class="loading" role="status">正在连接宿舍云端…</p>';
  else if(cloudUser&&cloudChoices.length)body='<form id="cloud-workspace-form"><label class="field"><span>选择宿舍</span><select name="workspaceId">'+cloudChoices.map(w=>option(w.id,w.name,false)).join('')+'</select></label><button type="submit" class="button primary">打开云端宿舍</button></form>';
  else if(cloudUser)body=note('当前账号尚未开通宿舍访问。请由管理方添加成员权限后，再刷新连接。','warning');
  else body='<form id="cloud-login-form">'+field('管理方邮箱','email','','email','required autocomplete="username"')+field('密码','password','','password','required autocomplete="current-password"')+'<button type="submit" class="button primary">登录宿舍云端</button></form><p class="muted">仅已开通的管理方账号可访问，不提供公开注册。</p>';
  const account=cloud.hasSession()?'<button class="text-button" data-action="cloud-refresh">刷新连接</button><button class="text-button" data-action="cloud-sign-out">退出登录</button>':'';
  app.innerHTML='<main class="cloud-gate" id="main"><section class="panel cloud-login"><a class="brand" href="#/dashboard"><span class="brand-mark">'+icon('home')+'</span><span>Kochi<span class="brand-sub">宿舍月结</span></span></a><div class="eyebrow">KOCHI DORM / CLOUD</div><h1>宿舍云端登录</h1><p>登录后，在你的设备之间使用同一份宿舍记录。</p>'+ (cloudError?'<div class="callout warning" role="alert">'+esc(cloudError)+'</div>':'')+body+'<div class="cloud-gate-actions">'+account+'<button class="text-button" data-action="open-demo">示例演练</button><button class="text-button" data-action="open-local">打开本机数据</button></div><small>示例、本机与云端数据相互独立。照片自动识别尚未接通。</small></section></main>';
}
function displayResult(){const b=bill();if(b)return {result:b.result,confirmed:true};try{return {result:calculateMonth({...state,month}),confirmed:false};}catch(e){return {error:e.message};}}
function monthControl(){return `<div class="month-picker"><button class="icon-button" data-action="prev" aria-label="上一个月">‹</button><label><span class="sr-only">结算月份</span><input id="month" type="month" value="${month}" aria-label="结算月份"></label><button class="icon-button" data-action="next" aria-label="下一个月">›</button></div>`;}
function render(){
  if(mode==='cloud'&&!state){renderCloudGate();return;}
  urls.forEach(URL.revokeObjectURL);urls=[];const token=++renderToken;
  const [view,,baseTitle,subtitle]=current(),title=pageLabel(view,baseTitle);
  app.innerHTML=`<a class="skip" href="#main">跳到主要内容</a><aside class="sidebar"><a class="brand" href="#/dashboard"><span class="brand-mark">${icon('home')}</span><span>Kochi<span class="brand-sub">宿舍月结</span></span></a><div class="workspace-label">${mode==='cloud'?'住宿管理 / 云端':'住宿管理 / 本机预览'}</div><nav aria-label="主要导航">${pages.map(([key,i,label])=>`<a href="#/${key}" class="nav-item ${view===key?'active':''}" ${view===key?'aria-current="page"':''}>${icon(i)}<span>${pageLabel(key,label)}</span>${key==='dashboard'?'<span class="nav-dot"></span>':''}</a>`).join('')}</nav><div class="sidebar-bottom"><div class="local-dot"></div><div>${mode==='cloud'?'<strong>已连接宿舍云端</strong><p>定期导出完整备份</p>':'<strong>数据仅存本机</strong><p>未连接云端数据库</p>'}</div></div></aside><div class="workspace"><header class="topbar"><span class="breadcrumb">Kochi 宿舍 <span>/</span> ${title}</span><div class="top-actions">${badge(modeName(),mode==='demo'?'amber':'green')}<button class="text-button" data-action="switch-mode">切换到${mode==='demo'?'本机数据':'示例数据'}</button>${mode==='cloud'?'<button class="text-button" data-action="cloud-refresh">刷新云端</button>'+(cloudChoices.length>1?'<button class="text-button" data-action="open-cloud">切换宿舍</button>':'')+'<button class="text-button" data-action="cloud-sign-out">退出登录</button>':'<button class="text-button" data-action="open-cloud">云端登录</button>'}<span class="avatar" aria-label="管理方">宿</span></div></header><main id="main" tabindex="-1"><div class="page-heading"><div><div class="eyebrow">KOCHI DORM / ${mode==='cloud'?'CLOUD':mode==='demo'?'DEMO':'LOCAL'}</div><h1>${title}</h1><p>${subtitle}</p></div>${['dashboard','payments'].includes(view)?monthControl():''}</div><div class="mode-banner ${mode==='demo'?'demo':'local'}"><span>${mode==='demo'?'<strong>示例演练中</strong> · 人员和表数均为虚构，仅用于体验完整流程。':mode==='cloud'?'<strong>云端数据区</strong> · '+esc(cloudSelected?.name||'宿舍')+'；修改保存后可在其他设备登录读取。':'<strong>本机数据区</strong> · 仅保存在当前浏览器，不会自动同步到其他设备。'}</span><a href="#/backup">备份与数据说明 ↗</a></div>${({dashboard:dashboard,residents:residents,readings:readings,rates:rates,payments:payments,backup:backup}[view])()}<footer>KOCHI DORM <span>${mode==='cloud'?'云端记录':'本机预览'} · 费用按已确认规则估分 · 定期导出备份</span></footer></main></div>`;
  for(const el of app.querySelectorAll('[data-photo]'))readPhoto(el.dataset.photo).then(blob=>{if(blob&&token===renderToken&&el.isConnected){const url=URL.createObjectURL(blob);urls.push(url);el.src=url;}else if(!blob&&token===renderToken&&el.isConnected){el.alt='原照片缺失，请检查备份';}}).catch(error=>{if(token!==renderToken||!el.isConnected)return;if(mode==='cloud'&&authGateCodes.has(error.code)){gateFailure(error);render();}else el.alt='照片读取失败，请刷新核对登录状态';});
}
function dashboard(){
  const {result:r,confirmed,error}=displayResult(),b=bill();
  const received=b?(b.payments||[]).reduce((n,p)=>n+p.cents,0):0;
  const due=r?r.rows.filter(x=>x.id!=='__owner').reduce((n,p)=>n+p.total,0):0;
  const prev=monthBounds(month).previous,end=monthBounds(month).end;
  return `<div class="stats"><div class="stat"><span>本月住户应交</span><strong>${r?euros(due):'—'}</strong><small>${r?`${r.rows.filter(x=>x.id!=='__owner').length} 位住户 · ${r.personDays} 入住人天`:'等待完整资料'}</small></div><div class="stat"><span>已收款</span><strong>${euros(received)}</strong><small>${b?`${b.payments.length} 笔实际收款`:'确认月结后可登记'}</small></div><div class="stat"><span>待收款</span><strong class="accent">${r?euros(due-received):'—'}</strong><small>${confirmed?'以已确认结算单为准':'当前为草稿预估'}</small></div><div class="stat status-stat"><span>月结状态</span><strong>${confirmed?'已确认':'待核对'}</strong><small>${confirmed?'计算依据已冻结':'核对后生成结算快照'}</small></div></div><div class="section-title"><h2>本月结算</h2>${badge(confirmed?'已冻结 · 可收款':'草稿 · 请核对',confirmed?'green':'amber')}</div><div class="steps">${[['01','住户入住','residents',state.stays.length],['02','月末表数','readings',state.readings.some(x=>x.period===prev)&&state.readings.some(x=>x.period===end)],['03','核对并确认','dashboard',confirmed],['04','收款与打印','payments',received>0]].map(([n,label,link,done])=>`<a href="#/${link}" class="step ${done?'done':''}"><span>${done?'✓':n}</span><div>${label}<small>${done?'已有记录':'下一步'}</small></div><b>↗</b></a>`).join('')}</div>${error?`<section class="panel">${empty('还需要一些月结资料',error,'readings','录入上月底 / 本月底表数')}</section>`:`<div class="billing-grid"><section class="panel bill-panel"><div class="panel-heading"><div><h2>${esc(month)} 月度费用明细</h2><p>${esc(confirmed?b.homeName:state.homeName)} · ${confirmed?'已确认结算':'草稿预览'}</p></div>${confirmed?'<button class="button secondary small" data-action="print">打印签字单 ↗</button>':''}</div><div class="usage-summary"><div><span>电表用量</span><strong>${Number(r.electricKwh.toFixed(4))} <small>kWh</small></strong></div><div><span>燃气用量</span><strong>${Number(r.gasM3.toFixed(4))} <small>m³</small></strong></div><div><span>计费区间</span><strong class="date-range">${esc(r.start.period)}<small>至 ${esc(r.end.period)}</small></strong></div></div><div class="table-scroll desktop-bill"><table class="bill-table"><thead><tr><th>住户 / 人天</th>${FEES.map(([,label])=>`<th>${label==='Nebenkosten'?'杂费 NK':label}</th>`).join('')}<th>应交合计</th></tr></thead><tbody>${r.rows.map(row=>`<tr><th>${esc(row.name)}<small>${row.id==='__owner'?'空置': '入住'} ${row.days} 天</small></th>${FEES.map(([key])=>`<td>${euros(row[key])}</td>`).join('')}<td><strong>${euros(row.total)}</strong></td></tr>`).join('')}</tbody><tfoot><tr><th>全部费用</th>${FEES.map(([key])=>`<td>${euros(r.totals[key])}</td>`).join('')}<td>${euros(r.total)}</td></tr></tfoot></table></div><div class="mobile-bills">${r.rows.map(row=>`<details class="mobile-bill"><summary><span>${esc(row.name)}<small>${row.id==='__owner'?'空置':'入住'} ${row.days} 天 · 点开看费用明细</small></span><strong>${euros(row.total)}</strong></summary><dl>${FEES.map(([key,label])=>`<div><dt>${label}</dt><dd>${euros(row[key])}</dd></div>`).join('')}</dl></details>`).join('')}<div class="mobile-total"><span>全部费用</span><strong>${euros(r.total)}</strong></div></div><div class="bill-footnote">含管理方承担的空置费用（如有）。各项分摊按分币尾差调平，合计一致。</div>${confirmed?note('该月住户、表数、费率已冻结。后续修改基础资料不会更改此结算单。','success'):`<form id="confirm-form" class="confirm-area">${check('reviewed','我已核对住户、表数、费率及下方估算说明，同意按当前规则结算。')}<button class="button primary" type="submit">确认月结并冻结 →</button></form>`}</section><aside class="panel rule-panel"><span class="eyebrow">BILLING NOTES</span><h2>这笔费用怎么算？</h2><div class="rule"><span>01</span><div><strong>用量按入住人天</strong><p>电、气用量和电视费，按本月实际入住人天比例估分。</p></div></div><div class="rule"><span>02</span><div><strong>基本费按当天人数</strong><p>年基本费 ÷ 12，逐日按当天人数分配，空置日归管理方。</p></div></div><div class="rule"><span>03</span><div><strong>Nebenkosten ${r.rate.includeNk?'已开启':'未计入'}</strong><p>电视费 ${euros(Math.round(r.rate.tv*100))}/月；默认不收杂费。</p></div></div><div class="warning-list"><strong>核对与估算说明</strong>${r.warnings.map(w=>`<p>· ${esc(w)}</p>`).join('')}</div><a class="inline-link" href="#/rates">查看合同费率 →</a></aside></div>`}<section class="panel lower-panel"><div><h2>先核对，再确认。</h2><p>照片自动识别尚未接通。请对照原照片手工输入读数，确认后再结算。</p></div><a class="button secondary" href="#/readings">查看抄表记录 →</a></section>`;
}
function residents(){
  const s=state.stays.find(x=>x.id===editing)||{};
  const people=[...new Map(state.stays.map(x=>[x.personId,x.name])).entries()];
  return `<div class="content-grid"><section class="panel"><div class="panel-heading"><div><h2>入住记录</h2><p>${people.length} 位住户 · 同一人可分段入住</p></div>${badge('离开日计入')}</div>${state.stays.length?`<div class="resident-list">${state.stays.map(x=>`<article class="resident-card"><span class="person-avatar">${esc(x.name.slice(0,1))}</span><div class="resident-info"><h3>${esc(x.name)}</h3><p>${esc(x.start)} → ${esc(x.end||'尚未填写退房日')}</p><small>${x.end?'已有退房日期':'入住记录开放中'}</small></div><div class="row-actions"><button class="text-button" data-action="edit-stay" data-id="${esc(x.id)}">编辑</button><button class="text-button danger" data-action="delete-stay" data-id="${esc(x.id)}">删除</button></div></article>`).join('')}</div>`:empty('还没有住户','从右侧添加第一位住户的入住记录。')}</section><section class="panel form-panel" id="editor"><h2>${s.id?'编辑入住记录':'添加入住记录'}</h2><p>再次入住时选回原住户，避免重复身份。</p><form id="stay-form"><input type="hidden" name="id" value="${esc(s.id||'')}"><label class="field"><span>住户身份</span><select name="personId" ${s.id?'disabled':''}>${option('','新住户',!s.personId)}${people.map(([pid,name])=>option(pid,name,pid===s.personId)).join('')}</select></label>${s.id?`<input type="hidden" name="existingPersonId" value="${esc(s.personId)}">`:''}${field('姓名','name',s.name,'text','required maxlength="80" placeholder="请输入住户姓名"')}${field('入住日期','start',s.start||today(),'date','required')}${field('退房日期（可留空）','end',s.end,'date')}${note('同一住户的入住时间不能重叠；退房当天仍计入。已确认的历史结算保持不变。')}<div class="form-actions"><button class="button primary" type="submit">保存入住记录</button>${s.id?'<button class="button secondary" type="button" data-action="cancel-edit">取消</button>':''}</div></form></section></div>`;
}
function readings(){
  const r=state.readings.find(x=>x.id===editing)||{};
  return `${note('<strong>照片自动识别尚未接通</strong> · 不会自动生成读数。请对照照片手工填写并明确核对。实际抄表日与结算归属日分别保存。','warning')}<div class="content-grid"><section class="panel"><div class="panel-heading"><div><h2>已核对表数</h2><p>每个月结需要上月底和本月底两次读数</p></div>${badge(`${state.readings.length} 次记录`)}</div>${state.readings.length?`<div class="reading-list">${[...state.readings].sort((a,b)=>b.period.localeCompare(a.period)).map(x=>`<article class="reading-card"><div class="reading-title"><div><h3>归属 ${esc(x.period)}</h3><p>实际抄表 ${esc(x.actual)} ${x.actual!==x.period?'· 日期按约定归属':''}</p></div><button class="text-button" data-action="edit-reading" data-id="${esc(x.id)}">核对 / 编辑</button></div><div class="reading-values"><div><span>电表 · kWh</span><strong>${esc(x.electric)}</strong>${photo(x.electricPhoto,'电表原照片')}</div><div><span>燃气表 · m³</span><strong>${esc(x.gas)}</strong>${photo(x.gasPhoto,'燃气表原照片')}</div></div><small>${esc(x.note||'人工输入，已核对')} · ${x.electricPhoto||x.gasPhoto?(mode==='cloud'?'原照片保存在私有云端':'原照片仅保存在本机'):'未附照片'}</small></article>`).join('')}</div>`:empty('先添加基准表数','例如要结算9月，需要8月31日与9月30日的已确认读数。')}</section><section class="panel form-panel" id="editor"><h2>${r.id?'核对抄表记录':'添加抄表记录'}</h2><form id="reading-form"><input name="id" type="hidden" value="${esc(r.id||'')}">${field('结算归属日期','period',r.period||monthBounds(month).end,'date','required')}${field('实际抄表日期','actual',r.actual||today(),'date','required')}<div class="two-fields">${field('电表累计数（kWh）','electric',r.electric,'number','required min="0" max="1000000000" step="any" inputmode="decimal"')}${field('燃气累计数（m³）','gas',r.gas,'number','required min="0" max="1000000000" step="any" inputmode="decimal"')}</div>${['electric','gas'].map((key,i)=>`<label class="field upload"><span>${i?'燃气表':'电表'}原照片（可选）</span><span class="upload-label">＋ 拍照或选取照片</span><input type="file" name="${key}Photo" accept="image/jpeg,image/png,image/webp,image/gif" capture="environment"><span class="upload-preview"></span></label>${photo(r[key+'Photo'],i?'已保存燃气照片':'已保存电表照片')}`).join('')}<small class="muted">支持 JPG / PNG / WebP / GIF，每张最多 8 MB。保存原图与文件时间；文件时间不代表已验证的拍摄日期。</small>${field('备注（可选）','note',r.note,'text','maxlength="300" placeholder="如：已与原照片核对"')}${check('override','实际抄表日不同于归属日时，我明确同意按归属日结算（不补估差额）。',r.override)}${check('confirmed','我已人工核对电、气两项累计表数。',false)}<div class="form-actions"><button type="submit" class="button primary">保存已核对表数</button>${r.id?'<button type="button" class="button secondary" data-action="cancel-edit">取消</button>':''}</div></form></section></div>`;
}
function rates(){
  const latest=[...state.rates].sort((a,b)=>b.from.localeCompare(a.from))[0];
  const r=state.rates.find(x=>x.id===editing)||{...latest,id:'',from:shiftMonth(month,1)};
  return `${note('费率只支持<strong>月初生效</strong>。合同月中改价需另行分段处理，不能在这里直接套用整月；供应商月预付款和附条件奖励不重复计费。')}<div class="content-grid"><section class="panel"><div class="panel-heading"><div><h2>合同版本</h2><p>已确认的月结使用当时冻结的费率</p></div></div>${[...state.rates].sort((a,b)=>b.from.localeCompare(a.from)).map(x=>`<article class="contract-card"><div class="reading-title"><h3>${esc(x.from)} 月起生效</h3><button class="text-button" data-action="edit-rate" data-id="${esc(x.id)}">编辑</button></div><dl class="rate-details"><div><dt>电用量 / 基本费</dt><dd>€ ${esc(x.electricRate)}/kWh · € ${esc(x.electricBase)}/年</dd></div><div><dt>燃气用量 / 基本费</dt><dd>€ ${esc(x.gasRate)}/kWh · € ${esc(x.gasBase)}/年</dd></div><div><dt>燃气转换</dt><dd>${esc(x.brennwert)} × ${esc(x.zustand)} ${badge(x.gasConversion==='estimated'?'估算':'供应商系数',x.gasConversion==='estimated'?'amber':'green')}</dd></div><div><dt>电视费 / Nebenkosten</dt><dd>€ ${esc(x.tv)}/月 · ${x.includeNk?`€ ${esc(x.nk)}/月`:'NK 关闭'}</dd></div></dl><p class="muted">${esc(x.note)}</p></article>`).join('')}</section><section class="panel form-panel" id="editor"><h2>${r.id?'编辑合同版本':'新增合同版本'}</h2><form id="rate-form"><input name="id" type="hidden" value="${esc(r.id)}">${field('生效月份（该月1日起）','from',r.from,'month','required')}<h3 class="form-section">电力 · 含税</h3><div class="two-fields">${field('电单价（€/kWh）','electricRate',r.electricRate,'number','required min="0" max="1000000" step="any"')}${field('电年基本费（€）','electricBase',r.electricBase,'number','required min="0" max="1000000" step="0.01"')}</div><h3 class="form-section">燃气 · 含税</h3><div class="two-fields">${field('燃气单价（€/kWh）','gasRate',r.gasRate,'number','required min="0" max="1000000" step="any"')}${field('燃气年基本费（€）','gasBase',r.gasBase,'number','required min="0" max="1000000" step="0.01"')}${field('Brennwert','brennwert',r.brennwert,'number','required min="0.000001" max="1000000" step="any"')}${field('Zustandszahl','zustand',r.zustand,'number','required min="0.000001" max="1000000" step="any"')}</div><label class="field"><span>燃气换算依据</span><select name="gasConversion">${option('estimated','估算系数（默认 10 × 1）',r.gasConversion==='estimated')}${option('actual','已核对供应商系数',r.gasConversion==='actual')}</select></label><h3 class="form-section">其他费用</h3><div class="two-fields">${field('电视费（€/月）','tv',r.tv,'number','required min="0" max="1000000" step="0.01"')}${field('Nebenkosten（€/月）','nk',r.nk,'number','required min="0" max="1000000" step="0.01"')}</div>${check('includeNk','明确开启 Nebenkosten（默认关闭）',r.includeNk)}${field('合同备注','note',r.note,'text','maxlength="500"')}<div class="form-actions"><button type="submit" class="button primary">保存合同版本</button>${r.id?'<button type="button" class="button secondary" data-action="cancel-edit">取消</button>':''}</div></form></section></div>`;
}
function payments(){
  const b=bill();if(!b)return `<section class="panel">${empty('先确认本月结算','收款只能登记到已确认的月结，签字不能代替实际付款。','dashboard','去核对月结')}</section>`;
  const rows=b.result.rows.filter(r=>r.id!=='__owner'),paid=b.payments.reduce((n,p)=>n+p.cents,0),total=rows.reduce((n,r)=>n+r.total,0);
  return `<div class="stats three"><div class="stat"><span>住户应交</span><strong>${euros(total)}</strong></div><div class="stat"><span>实际已收</span><strong>${euros(paid)}</strong></div><div class="stat"><span>尚待收款</span><strong class="accent">${euros(total-paid)}</strong></div></div><div class="content-grid"><section class="panel"><div class="panel-heading"><div><h2>住户收款进度</h2><p>${esc(month)} · 以实际到账为准</p></div><button class="button secondary small" data-action="print">打印签字单 ↗</button></div>${rows.map(r=>`<div class="payment-person"><div><strong>${esc(r.name)}</strong><p>已收 ${euros(paidFor(b,r.id))} / 应交 ${euros(r.total)}</p></div>${badge(paidFor(b,r.id)===r.total?'已结清':`待收 ${euros(r.total-paidFor(b,r.id))}`,paidFor(b,r.id)===r.total?'green':'amber')}</div>`).join('')}<div class="panel-heading border-top"><div><h2>逐笔收款记录</h2><p>仅登记实际收到的金额，支持部分付款</p></div></div>${b.payments.length?`<div class="table-scroll"><table><thead><tr><th>日期 / 住户</th><th>方式 / 备注</th><th>金额</th></tr></thead><tbody>${[...b.payments].reverse().map(p=>`<tr><td>${esc(p.date)}<small>${esc(rows.find(r=>r.id===p.personId)?.name)}</small></td><td>${esc(p.method)}<small>${esc(p.note)}</small></td><td>${euros(p.cents)}</td></tr>`).join('')}</tbody></table></div>`:empty('还没有收款记录','确认结算和签字都不会自动标记为付款。')}</section><section class="panel form-panel"><h2>登记实际收款</h2><form id="payment-form"><label class="field"><span>付款住户</span><select name="personId" required><option value="">请选择住户</option>${rows.filter(r=>r.total>paidFor(b,r.id)).map(r=>option(r.id,`${r.name} · 待收 ${euros(r.total-paidFor(b,r.id))}`,false)).join('')}</select></label>${field('本次实收（€）','value','','number','required min="0.01" step="0.01" inputmode="decimal"')}${field('实际收款日期','date',today(),'date',`required max="${today()}"`)}<label class="field"><span>收款方式</span><select name="method"><option>现金</option><option>银行转账</option><option>其他</option></select></label>${field('备注（可选）','note','','text','maxlength="300" placeholder="例如：第一笔部分付款"')}${note('此处只记录你已核实到账的款项，未连接银行接口。')}<button type="submit" class="button primary">保存实际收款</button></form></section></div>`;
}
function backup(){
  if(mode==='cloud')return '<div class="backup-grid"><section class="panel backup-card"><h2>导出云端完整备份</h2><p>包含本宿舍的入住、费率、表数、确认快照、收款及原照片。</p><button class="button primary" data-action="export">导出完整备份 ↓</button><small>备份含个人资料和照片，请妥善保管，勿上传代码仓库。</small></section><section class="panel backup-card"><h2>云端保存范围</h2><p>记录保存在当前登录账号获准访问的宿舍。照片通过私有存储授权读取。</p><p>云端暂不支持整份替换恢复；现有本机资料不会自动上传。</p><button class="button secondary" data-action="cloud-refresh">刷新云端数据</button></section></div><section class="panel settings-panel"><h2>宿舍名称</h2><form id="home-form" class="inline-form">'+field('显示在月结单与签字单上','homeName',state.homeName,'text','required maxlength="80"')+'<button class="button secondary" type="submit">保存名称</button></form></section>'+note('云端保存失败或版本冲突时，请先刷新核对结果，不要重复登记收款。照片自动识别尚未接通。');
  return `<div class="backup-grid"><section class="panel backup-card"><span class="feature-icon">${icon('box')}</span><h2>把本机数据带走</h2><p>导出当前${mode==='demo'?'示例':'本机'}数据区的全部住户、费率、表数、已确认结算、收款和原照片。</p><button class="button primary" data-action="export">导出完整备份 ↓</button><small>备份含个人资料和照片，请妥善保管，勿上传代码仓库。</small></section><section class="panel backup-card"><span class="feature-icon">${icon('home')}</span><h2>恢复已有备份</h2><p>先检查备份格式与照片，确认后替换当前数据区。恢复前请先导出备份。</p><form id="import-form"><label class="field"><span>选择 .json 完整备份（最多 80 MB）</span><input name="backup" type="file" accept="application/json,.json" required></label><button type="submit" class="button secondary">检查并恢复备份</button></form></section></div><section class="panel settings-panel"><h2>宿舍名称</h2><form id="home-form" class="inline-form">${field('显示在月结单与签字单上','homeName',state.homeName,'text','required maxlength="80"')}<button class="button secondary" type="submit">保存名称</button></form></section>${note('<strong>本机保存范围</strong><br>数据保存在当前浏览器、当前网址的 IndexedDB。清除网站数据、使用隐私模式、换浏览器或换端口，都会影响可见数据。照片不会上传，未连接旧管理系统或任何生产数据库。建议每次结算后导出备份。')}<section class="panel lower-panel"><div><h2>${mode==='demo'?'重新演练示例':'示例数据与本机数据相互独立'}</h2><p>${mode==='demo'?'只重置示例数据区，不影响已保存的本机数据。':'可切换到示例区演练，不会混入本机数据。'}</p></div><button class="button secondary" data-action="${mode==='demo'?'reset-demo':'switch-mode'}">${mode==='demo'?'重置示例':'切换到示例'}</button></section>`;
}

async function readUpload(file){
  if(!file?.size)return null;
  if(file.size>8*1024*1024||!['image/jpeg','image/png','image/webp','image/gif'].includes(file.type))throw new Error('照片限 JPG / PNG / WebP / GIF，且每张不超过8 MB；HEIC请先转为JPG。');
  // Verify browser decoding before committing the original file.
  const url=URL.createObjectURL(file);
  try{const image=new Image();image.src=url;await image.decode();}catch{throw new Error('照片无法打开，请换一张有效图片。');}finally{URL.revokeObjectURL(url);}
  return {id:id(),blob:file,meta:{name:file.name,type:file.type,fileDate:file.lastModified?new Date(file.lastModified).toISOString():null,addedAt:new Date().toISOString()}};
}
app.addEventListener('submit',event=>{
  event.preventDefault();const form=event.target;if(!form.reportValidity())return;
  task(async operationEpoch=>{
    const saveCurrent=(next,photos=[])=>commit(next,photos,operationEpoch);
    const f=new FormData(form),v=Object.fromEntries(f);
    if(form.id==='cloud-login-form'){await cloud.signIn(String(v.email).trim(),v.password);form.reset();await openCloud();return;}
    if(form.id==='cloud-workspace-form'){await selectCloud(v.workspaceId);return;}
    if(!state)throw new Error('请先打开数据区。');
    const next=structuredClone(state);
    if(form.getAttribute('id')==='stay-form'){
      const old=state.stays.find(s=>s.id===v.id),pid=old?.personId||v.personId||id();
      const name=String(v.name).trim();
      if(!name)throw new Error('请填写住户姓名。');
      const existing=state.stays.find(s=>s.personId===pid);
      if(existing&&!old&&existing.name!==name)throw new Error('再次入住请使用原住户姓名；改名请编辑原记录。');
      if(!existing&&state.stays.some(s=>s.name===name))throw new Error('已存在同名住户。再次入住请在住户身份中选择原住户；不同人员请在姓名中添加区分。');
      const stay={id:old?.id||id(),personId:pid,name,start:v.start,end:v.end||null};
      if(old)next.stays[next.stays.findIndex(s=>s.id===old.id)]=stay;else next.stays.push(stay);
      next.stays.forEach(s=>{if(s.personId===pid)s.name=name;});await saveCurrent(next);
    }else if(form.getAttribute('id')==='reading-form'){
      const old=state.readings.find(r=>r.id===v.id),photos=[];
      const r={...old,id:old?.id||id(),period:v.period,actual:v.actual,electric:v.electric,gas:v.gas,confirmed:f.has('confirmed'),override:f.has('override'),note:v.note};
      if(next.readings.some(x=>x.period===r.period&&x.id!==r.id))throw new Error('该归属日期已有表数，请编辑已有记录。');
      for(const key of ['electricPhoto','gasPhoto']){const p=await readUpload(f.get(key));if(p){photos.push(p);r[key]={id:p.id,...p.meta};}}
      if(old)next.readings[next.readings.findIndex(x=>x.id===old.id)]=r;else next.readings.push(r);
      await saveCurrent(next,photos);
    }else if(form.getAttribute('id')==='rate-form'){
      const r={...v,id:v.id||id(),includeNk:f.has('includeNk')};
      for(const key of ['electricRate','electricBase','gasRate','gasBase','brennwert','zustand','tv','nk'])r[key]=v[key]===''?'':Number(v[key]);
      if(v.id)next.rates[next.rates.findIndex(x=>x.id===v.id)]=r;else next.rates.push(r);await saveCurrent(next);
    }else if(form.getAttribute('id')==='confirm-form')await saveCurrent(confirmMonth(state,month,f.has('reviewed')));
    else if(form.getAttribute('id')==='payment-form')await saveCurrent(recordPayment(state,{billId:bill()?.id,...v}));
    else if(form.getAttribute('id')==='home-form'){next.homeName=v.homeName.trim();if(!next.homeName)throw new Error('请填写宿舍名称。');await saveCurrent(next);}
    else if(form.getAttribute('id')==='import-form'){
      if(mode==='cloud')throw new Error('云端暂不支持整份替换恢复。');
      const file=f.get('backup');if(!file?.size||file.size>80*1024*1024)throw new Error('请选择80 MB以内的JSON备份。');
      let data;try{data=JSON.parse(await file.text());}catch{throw new Error('无法读取JSON备份。');}validateBackup(data,mode);
      const photos=[];
      for(const p of data.photos){const [header,encoded]=p.data.split(',');const type=header.slice(5,header.indexOf(';'));const blob=new Blob([Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))],{type});await readUpload(new File([blob],'backup',{type}));photos.push({id:p.id,blob});}
      if(!confirm(`备份检查通过：${data.state.stays.length} 条入住、${data.state.bills.length} 个月结、${photos.length} 张照片。\n将替换当前${mode==='demo'?'示例':'本机'}数据区。请先保留原备份，确认恢复？`))return;
      await saveCurrent(data.state,photos);month=suggestedMonth(state);render();notice('备份已恢复，照片与数据均已保存');
    }
  });
});
app.addEventListener('click',event=>{
  const button=event.target.closest('[data-action]');if(!button)return;
  if(button.dataset.action==='cloud-sign-out'){void signOutCloud();return;}
  task(async operationEpoch=>{
    const saveCurrent=(next,photos=[])=>commit(next,photos,operationEpoch);
    const action=button.dataset.action,key=button.dataset.id;
    if(action==='open-cloud')await openCloud();
    else if(action==='open-demo')await openMode('demo');
    else if(action==='open-local')await openMode('local');
    else if(action==='cloud-refresh'){if(cloudSelected)await selectCloud(cloudSelected.id);else await openCloud();}
    else if(action==='prev'||action==='next'){month=shiftMonth(month,action==='prev'?-1:1);render();}
    else if(action==='switch-mode')await openMode(mode==='demo'?'local':'demo');
    else if(action.startsWith('edit-')){editing=key;render();document.querySelector('#editor')?.scrollIntoView({behavior:'smooth',block:'start'});}
    else if(action==='cancel-edit'){editing=null;render();}
    else if(action==='delete-stay'){
      if(!confirm('删除这条入住记录？尚未确认的月结会重新计算；已确认结算不变。'))return;
      const next=structuredClone(state);next.stays=next.stays.filter(s=>s.id!==key);await saveCurrent(next);
    }else if(action==='print')printBill();
    else if(action==='export'){
      const exportedState=structuredClone(state),exportEpoch=viewEpoch;const photos=[];for(const key of photoIds(exportedState)){const blob=await readPhoto(key);checkView(exportEpoch);if(!blob)throw new Error('有原照片缺失，备份未导出。请先检查抄表记录。');const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('照片导出失败。'));reader.readAsDataURL(blob);});photos.push({id:key,data});}
      const data=JSON.stringify({format:mode==='cloud'?'kochi-dorm-cloud-backup':'kochi-dorm-local-backup',version:1,exportedAt:new Date().toISOString(),state:exportedState,photos});
      if(new Blob([data]).size>80*1024*1024)throw new Error('完整备份超过80 MB，请勿继续积累大照片；当前版本需先缩小原图后再录入。');
      checkView(exportEpoch);const url=URL.createObjectURL(new Blob([data],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=`kochi-dorm-${mode}-${today()}.backup.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);notice('备份已导出，请妥善保存下载文件');
    }else if(action==='reset-demo'){
      if(confirm('重置示例区的住户、表数、月结和收款？不会影响本机数据区。')){await saveCurrent(exampleState());month=suggestedMonth(state);render();}
    }
  });
});
app.addEventListener('change',event=>{
  const el=event.target;
  if(el.id==='month'){try{monthBounds(el.value);month=el.value;render();}catch(e){notice(e.message,true);}}
  if(el.name==='personId'&&el.closest('#stay-form')){const p=state.stays.find(s=>s.personId===el.value);const input=el.form.elements.name;if(p)input.value=p.name;else input.value='';}
  if(el.type==='file'&&el.closest('.upload')){
    const target=el.closest('.upload').querySelector('.upload-preview');target.replaceChildren();const f=el.files[0];if(f&&['image/jpeg','image/png','image/webp','image/gif'].includes(f.type)){const img=new Image();const url=URL.createObjectURL(f);urls.push(url);img.src=url;img.alt='待保存的原照片预览';target.append(img);}
  }
});
function printBill(openDialog=true){
  const b=bill();if(!b)throw new Error('请先确认月结，再打印签字单。');
  document.querySelector('#print-root').innerHTML=b.result.rows.filter(r=>r.id!=='__owner').map(r=>`<section class="print-sheet"><div class="print-heading"><div>KOCHI DORM<h1>宿舍费用结算确认单</h1></div><div>${b.mode==='cloud'?'云端记录':b.mode==='demo'?'示例数据 · 演练用':'本机记录'}<br>${esc(b.month)}</div></div><h2>${esc(b.homeName||state.homeName)}</h2><p>住户：<strong>${esc(r.name)}</strong>　入住：${r.days} 天　月结编号：${esc(b.id.slice(0,8))}</p><p>归属区间：${esc(b.result.start.period)} 至 ${esc(b.result.end.period)}<br>实际抄表：${esc(b.result.start.actual)} 至 ${esc(b.result.end.actual)}</p><table><thead><tr><th>费用项目</th><th>本月应交</th></tr></thead><tbody>${FEES.map(([key,label])=>`<tr><td>${label}</td><td>${euros(r[key])}</td></tr>`).join('')}</tbody><tfoot><tr><th>应交合计</th><td>${euros(r.total)}</td></tr></tfoot></table><div class="print-payment"><p>已登记实收：${euros(paidFor(b,r.id))}　　尚待支付：${euros(r.total-paidFor(b,r.id))}</p><strong>本单确认费用分摊；签字不代表已付款，也不是收款收据。</strong></div><div class="print-notes"><strong>分摊依据与估算说明</strong><p>用量费、电视费及开启的杂费按入住人天；基本费逐日按当天人数，空置日由管理方承担。Nebenkosten：${b.result.rate.includeNk?'开启':'关闭'}。</p><p>电：€${esc(b.result.rate.electricRate)}/kWh，€${esc(b.result.rate.electricBase)}/年；燃气：€${esc(b.result.rate.gasRate)}/kWh，€${esc(b.result.rate.gasBase)}/年；燃气转换 ${esc(b.result.rate.brennwert)} × ${esc(b.result.rate.zustand)}。</p>${b.result.warnings.map(w=>`<p>· ${esc(w)}</p>`).join('')}</div><div class="signatures"><div>住户签字：________________<br>日期：____________________</div><div>管理方签字：______________<br>日期：____________________</div></div><small>结算确认时间：${esc(new Date(b.confirmedAt).toLocaleString('zh-CN',{timeZone:'Europe/Berlin'}))} · 本机打印</small></section>`).join('');
  if(!document.querySelector('#print-root').children.length)throw new Error('本月没有住户，只有管理方费用，无需住户签字单。');
  if(openDialog)window.print();
}
window.addEventListener('hashchange',()=>{editing=null;if(state)render();window.scrollTo({top:0,behavior:'instant'});});
window.addEventListener('beforeprint',()=>{if(state&&bill())printBill(false);else document.querySelector('#print-root').innerHTML='<p>请先确认月结，再从月结工作台打印住户签字单。</p>';});
(mode==='cloud'?openCloud():openMode(mode)).catch(e=>{app.innerHTML=`<div class="fatal"><h1>无法打开本机数据</h1><p>${esc(e.message)}</p><p>请检查浏览器存储权限，重新载入页面。不要清除已有网站数据。</p><button id="reload" class="button primary">重新载入</button></div>`;document.querySelector('#reload').onclick=()=>location.reload();});
