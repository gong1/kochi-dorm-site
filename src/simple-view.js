import {euros,monthBounds,today} from './engine.js';
import {accountSummary} from './accounts.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const decimal=value=>`${Math.floor(value/100)}.${String(value%100).padStart(2,'0')}`;
const action=(label,name,id='',className='secondary')=>`<button type="button" class="button ${className}" data-action="${esc(name)}"${id?` data-id="${esc(id)}"`:''}>${esc(label)}</button>`;
const field=(label,name,value='',type='text',extra='')=>`<label class="simple-field"><span>${esc(label)}</span><input name="${esc(name)}" type="${type}" value="${esc(value)}" ${extra}></label>`;
const activeStays=state=>{const now=today();return state.stays.filter(stay=>stay.start<=now&&(!stay.end||stay.end>now));};
const lastSettlement=state=>[
  ...(state.legacySettlements||[]).map(bill=>bill.periodEnd),
  ...(state.bills||[]).map(bill=>monthBounds(bill.month).end),
  ...(state.intervalBills||[]).map(bill=>bill.coverageEnd),
].sort().at(-1);
const empty=text=>`<p class="simple-empty">${esc(text)}</p>`;
const accountStatus=account=>`<span class="badge ${account.active?'green':''}">${account.active?'在住':'已建档'}</span>`;
function personCard(account,stay=null) {
  return `<article class="simple-person"><div class="simple-person-main"><strong>${esc(account.name)}</strong><p>${stay?`入住 ${esc(stay.start)}`:account.active?'目前在住':'目前不在住'}</p></div><div class="simple-person-money"><span>未收</span><strong>${euros(account.balanceCents)}</strong></div><div class="simple-person-actions">${action('查看账本','open-account',account.id)}${stay?action('办理搬出','start-move-out',stay.id):''}</div></article>`;
}

export function homeView(state) {
  const accounts=accountSummary(state),stays=activeStays(state),current=accounts.filter(account=>account.active);
  const outstanding=accounts.reduce((sum,account)=>sum+account.balanceCents,0),settled=lastSettlement(state),tasks=[];
  for(const [kind,label] of [['electric','电表'],['gas','气表']]) {
    const profile=state.meterProfiles?.[kind];
    if(!profile?.number||!profile?.location)tasks.push(`<li><a href="#/settings">补充${label}表号和位置</a><span>方便住户拍对表</span></li>`);
  }
  if(!state.readings.some(reading=>reading.confirmed))tasks.push('<li><a href="#/readings">拍电表和气表，建立起始读数</a></li>');
  const debtors=accounts.filter(account=>account.balanceCents>0).length;
  if(debtors)tasks.push(`<li><a href="#/accounts">${debtors} 位住户有未收款</a><span>实际到账后登记</span></li>`);
  return `<div class="simple-page"><section class="simple-metrics" aria-label="宿舍概况"><div class="simple-metric"><span>目前在住</span><strong>${current.length}<small> 人</small></strong></div><div class="simple-metric"><span>已确认未收</span><strong>${euros(outstanding)}</strong></div><div class="simple-metric"><span>最近结算截止</span><strong class="simple-date">${esc(settled||'尚未结算')}</strong></div></section><section class="simple-panel simple-start"><h2>有人入住或搬出？</h2><p>登记人员变化，拍两张表，再核对这段费用。</p><div class="simple-actions">${action('办理入住','start-move-in','','primary')}${action('办理搬出','start-move-out')}</div></section><section class="simple-panel"><div class="simple-section-header"><h2>当前住户</h2><a href="#/people">管理人员</a></div>${current.length?current.map(account=>personCard(account)).join(''):empty('目前没有在住人员。有人入住时，点击上方“办理入住”。')}</section>${tasks.length?`<section class="simple-panel"><h2>待办</h2><ul class="simple-todos">${tasks.join('')}</ul></section>`:''}<p class="simple-note">结算确认后记入个人账本；收到钱后再登记实收。两步分开，欠款就清楚。</p></div>`;
}

export function peopleView(state,{movement=null}={}) {
  const accounts=accountSummary(state),stays=activeStays(state);
  if(movement?.stage==='form') {
    const kind=['out','move-out'].includes(movement.kind)?'out':'in',selected=stays.find(stay=>stay.id===movement.stayId),isOut=kind==='out';
    const identity=isOut?`<label class="simple-field"><span>谁要搬出？</span><select name="stayId" required><option value="">请选择在住人员</option>${stays.map(stay=>`<option value="${esc(stay.id)}"${stay.id===movement.stayId?' selected':''}>${esc(stay.name)} · ${esc(stay.start)} 入住</option>`).join('')}</select></label>`:`<input type="hidden" name="stayId" value=""><label class="simple-field"><span>住户</span><select name="personId"><option value="">新住户</option>${accounts.map(account=>`<option value="${esc(account.id)}"${account.id===movement.personId?' selected':''}>${esc(account.name)}${account.active?'（目前在住）':''}</option>`).join('')}</select></label>${field('姓名','name',movement.name||accounts.find(account=>account.id===movement.personId)?.name||'','text','required maxlength="80" autocomplete="name"')}`;
    return `<div class="simple-page"><section class="simple-panel simple-flow"><div class="simple-step-title"><span>1 / 3</span><h2>${isOut?'办理搬出':'办理入住'}</h2></div><p class="simple-muted">先登记人员和日期，下一步拍电表、气表。</p><form id="movement-form" class="simple-form"><input type="hidden" name="kind" value="${kind}">${identity}${field(isOut?'搬出日期':'入住日期','date',movement.date||today(),'date','required')}${selected?`<p class="simple-muted">原入住日期：${esc(selected.start)}</p>`:''}<p class="simple-rule">入住当天拍表，费用从次日起算；搬出当天计费。同日多人进出共用一次表数，避免重复计算。</p><div class="simple-actions"><button type="submit" class="button primary">下一步：抄两张表</button>${action('取消','cancel-movement')}</div></form></section></div>`;
  }
  const currentIds=new Set(stays.map(stay=>stay.personId)),past=accounts.filter(account=>!currentIds.has(account.id));
  return `<div class="simple-page"><section class="simple-panel"><div class="simple-section-header"><div><h2>当前在住</h2><p>${new Set(stays.map(stay=>stay.personId)).size} 人</p></div>${action('办理入住','start-move-in','','primary')}</div>${stays.length?stays.map(stay=>personCard(accounts.find(account=>account.id===stay.personId),stay)).join(''):empty('还没有在住人员。点击“办理入住”开始。')}</section>${past.length?`<details class="simple-panel simple-details"><summary>其他已建档人员（${past.length}）</summary><div>${past.map(account=>personCard(account)).join('')}</div></details>`:''}</div>`;
}

export function accountsView(state,personId=null) {
  const accounts=accountSummary(state),account=accounts.find(person=>person.id===personId);
  if(!account) {
    const sorted=[...accounts].sort((a,b)=>Number(b.active)-Number(a.active)||b.balanceCents-a.balanceCents||a.name.localeCompare(b.name,'zh-CN'));
    return `<div class="simple-page"><section class="simple-panel"><div class="simple-section-header"><div><h2>个人账本</h2><p>已确认费用减去实际收款，就是还欠的钱。</p></div></div>${sorted.length?sorted.map(person=>personCard(person)).join(''):empty('人员办理入住后，会在这里建立个人账本。')}</section></div>`;
  }
  const charges=account.charges.map(charge=>`<li class="simple-ledger-row"><div><strong>${esc(charge.title)}</strong><p>${esc(charge.date)} · ${charge.kind==='legacy'?'历史约定':charge.kind==='interval'?'区间结算':'月结'}</p><small>已收 ${euros(charge.paidCents)} · 未收 ${euros(charge.balanceCents)}</small></div><strong>应收 ${euros(charge.dueCents)}</strong></li>`).join('');
  const payments=account.payments.map(payment=>`<li class="simple-ledger-row"><div><strong>${esc(payment.date)} · ${esc(payment.method)}</strong><p>${esc(payment.title)}</p>${payment.note?`<small>${esc(payment.note)}</small>`:''}</div><strong class="simple-received">实收 ${euros(payment.cents)}</strong></li>`).join('');
  return `<div class="simple-page"><div class="simple-section-header"><div><button type="button" class="text-button" data-action="open-account">← 全部账本</button><h2>${esc(account.name)}的账本</h2>${accountStatus(account)}</div>${account.charges.length?action('打印对账单','print-account',account.id):''}</div><section class="simple-metrics" aria-label="个人余额"><div class="simple-metric"><span>累计应收</span><strong>${euros(account.dueCents)}</strong></div><div class="simple-metric"><span>累计实收</span><strong>${euros(account.paidCents)}</strong></div><div class="simple-metric"><span>${account.balanceCents?'尚未收款':'已结清'}</span><strong>${euros(account.balanceCents)}</strong></div></section>${account.balanceCents?`<section class="simple-panel"><h2>登记实际收款</h2><p class="simple-muted">可以一次付清，也可以分次付款。按最早的未收费用依次登记。</p><form id="account-payment-form" class="simple-form"><input type="hidden" name="personId" value="${esc(account.id)}">${field('本次实际收到（€）','value',decimal(account.balanceCents),'number','required min="0.01" step="0.01" inputmode="decimal"')}${field('实际到账日期','date',today(),'date',`required max="${today()}"`)}<label class="simple-field"><span>收款方式</span><select name="method" required><option>现金</option><option>银行转账</option><option>其他</option></select></label>${field('备注（可选）','note','','text','maxlength="300"')}<label class="simple-checkbox"><input name="received" type="checkbox" value="1" required><span>我已核实这笔钱实际到账。</span></label><button type="submit" class="button primary">登记实收</button></form></section>`:`<section class="simple-panel"><p class="simple-settled">${account.charges.length?'目前已结清。':'还没有已确认费用。'}</p></section>`}<details class="simple-panel simple-details"><summary>费用与收款明细</summary><div><h3>已确认费用</h3>${charges?`<ol class="simple-ledger">${charges}</ol>`:empty('暂无已确认费用。')}<h3>实际收款</h3>${payments?`<ol class="simple-ledger">${payments}</ol>`:empty('还没有实际收款记录。')}<p class="simple-note">签字确认费用不代表已经付款。</p></div></details></div>`;
}

export function settingsView(state) {
  return `<div class="simple-page"><section class="simple-panel"><h2>抄表指引</h2><p class="simple-muted">填写两只正确表的表号和位置。拍照识别后会核对表号；没读清或不匹配时，需要管理方复核。</p><form id="meter-profile-form" class="simple-form"><div class="simple-profile-grid">${[['electric','电表','kWh'],['gas','气表','m³']].map(([kind,label,unit])=>{const profile=state.meterProfiles?.[kind]||{};return `<fieldset class="simple-profile"><legend>${label} · ${unit}</legend>${field('表号',kind+'Number',profile.number||'','text','maxlength="80" autocomplete="off"')}${field('到哪里找',kind+'Location',profile.location||'','text','maxlength="160"')}${field('拍照提示（可选）',kind+'Hint',profile.hint||'','text','maxlength="300"')}<p class="simple-note">请按表身标签填写表号，保留开头的 0。</p></fieldset>`;}).join('')}</div><button type="submit" class="button primary">保存抄表指引</button></form></section><section class="simple-panel"><h2>给住户拍表</h2><p>使用单独的拍表任务链接，不要分享管理方账号。任务只提供两只表的指引，不向拍表人展示住户或费用。</p><p class="simple-note">任务权限与可用状态以任务页面为准；链接持有人可以提交，请只发给本次拍表人。</p></section><section class="simple-panel"><h2>其他设置与记录</h2><nav class="simple-route-list" aria-label="其他设置"><a href="#/rates"><strong>合同费率</strong><span>电、气、电视费及可选杂费</span></a><a href="#/history"><strong>历史结算</strong><span>查看原有固定费用约定</span></a><a href="#/monthly"><strong>月结明细</strong><span>查看原有月度结算功能</span></a><a href="#/backup"><strong>数据与备份</strong><span>导出、查看数据保存位置</span></a></nav></section></div>`;
}
