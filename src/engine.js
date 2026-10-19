import {validateLegacyState, assertMonthOutsideLegacy} from './history.js';
export const VERSION = 1;
export const FEES = [
  ['electricUsage', '电用量费'], ['electricBase', '电基本费'],
  ['gasUsage', '燃气用量费'], ['gasBase', '燃气基本费'],
  ['tv', '电视费'], ['nk', 'Nebenkosten']
];
const DAY = 86400000;
export function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  const t = Date.parse(s + 'T00:00:00Z');
  return Number.isFinite(t) && new Date(t).toISOString().slice(0,10) === s;
}
export function dayNumber(s) {
  if (!validDate(s)) throw new Error('日期无效，请使用年-月-日。');
  return Date.parse(s + 'T00:00:00Z') / DAY;
}
export function monthBounds(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('请选择有效月份。');
  const start = month + '-01', [y,m] = month.split('-').map(Number);
  const end = new Date(Date.UTC(y,m,0)).toISOString().slice(0,10);
  const previous = new Date(Date.UTC(y,m-1,0)).toISOString().slice(0,10);
  return {start,end,previous,days:dayNumber(end)-dayNumber(start)+1};
}
export function shiftMonth(month, delta) {
  monthBounds(month);
  const [y,m] = month.split('-').map(Number);
  return new Date(Date.UTC(y,m-1+delta,1)).toISOString().slice(0,7);
}
export function today() {
  const parts = new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const get = x => parts.find(p=>p.type===x).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function amount(value, label, max=1e9) {
  if (value === '' || value == null || typeof value === 'boolean') throw new Error(`${label}不能为空。`);
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > max) throw new Error(`${label}必须是0至${max}之间的数字。`);
  return n;
}
export const cents = n => Math.round((n + Number.EPSILON)*100);
export const euros = c => new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR'}).format(c/100);
export function allocate(total, weights) {
  if (!Number.isSafeInteger(total) || total<0) throw new Error('费用超出有效范围。');
  const sum=weights.reduce((a,b)=>a+b,0);
  if (!sum) return weights.map(()=>0);
  const exact=weights.map(w=>total*w/sum), result=exact.map(Math.floor);
  const order=exact.map((v,i)=>({i,rem:v-result[i]})).sort((a,b)=>b.rem-a.rem || a.i-b.i);
  const remainder=total-result.reduce((a,b)=>a+b,0);
  for (let n=0;n<remainder;n++) result[order[n].i]++;
  return result;
}
export function validateStays(stays) {
  const ids = new Set();
  for (const s of stays) {
    if (!s.id || ids.has(s.id)) throw new Error('入住记录编号重复。');
    ids.add(s.id);
    if (typeof s.personId!=='string' || !s.personId || s.personId==='__owner' || typeof s.name!=='string' || !s.name.trim() || s.name.length>80) throw new Error('请填写有效的住户姓名和身份。');
    dayNumber(s.start); if (s.end) dayNumber(s.end);
    if (s.end && s.end<s.start) throw new Error(`${s.name}的退房日期早于入住日期。`);
  }
  for (let i=0;i<stays.length;i++) for(let j=i+1;j<stays.length;j++) {
    const a=stays[i],b=stays[j];
    if (a.personId===b.personId && a.start<=(b.end||'9999-12-31') && b.start<=(a.end||'9999-12-31'))
      throw new Error(`${a.name}有重叠的入住记录。`);
  }
}
export function validateRate(r) {
  if (!r.id) throw new Error('合同版本缺少编号。');
  monthBounds(r.from);
  for (const key of ['electricRate','electricBase','gasRate','gasBase','brennwert','zustand','tv','nk']) amount(r[key],key,1e6);
  if (Number(r.brennwert)<=0 || Number(r.zustand)<=0) throw new Error('燃气换算系数必须大于0。');
  if (!['estimated','actual'].includes(r.gasConversion)) throw new Error('请选择燃气换算方式。');
  if (typeof r.includeNk!=='boolean') throw new Error('请明确设置是否开启Nebenkosten。');
}
export function rateFor(rates,month) {
  const applicable=rates.filter(r=>r.from<=month).sort((a,b)=>b.from.localeCompare(a.from));
  if (!applicable.length) throw new Error('该月还没有生效的合同费率，请在合同设置中添加。');
  validateRate(applicable[0]); return applicable[0];
}
const OCR_UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function exactKeys(value,keys) {
  return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
}
// Recognition is an untrusted suggestion, stored separately from the confirmed reading.
export function validateMeterResult(result,kind) {
  const invalid=()=>{throw new Error('AI识别结果无效，请对照原照片手工核对。');};
  if(!['electric','gas'].includes(kind)||!exactKeys(result,['meterType','value','display','unit','meterNumber','warnings','status']))invalid();
  if(!['electric','gas','unknown'].includes(result.meterType)||!['ok','uncertain','wrong_meter'].includes(result.status)||
    ![null,'kWh','m3'].includes(result.unit)||typeof result.display!=='string'||result.display.length>80||
    !(result.meterNumber===null||typeof result.meterNumber==='string'&&result.meterNumber.length<=80)||
    !Array.isArray(result.warnings)||result.warnings.length>6||result.warnings.some(w=>typeof w!=='string'||!w||w.length>160))invalid();
  if(result.status==='ok') {
    if(result.meterType!==kind||result.unit!==(kind==='electric'?'kWh':'m3')||typeof result.value!=='number'||
      !Number.isFinite(result.value)||result.value<0||result.value>1e9||result.warnings.length)invalid();
  } else if(result.value!==null)invalid();
  return result;
}
export function validateMeterRecognition(metadata,kind) {
  if(!exactKeys(metadata,['version','provider','model','recognizedAt','requestId','result'])||metadata.version!==1||metadata.provider!=='OpenAI'||
    typeof metadata.model!=='string'||!metadata.model||metadata.model.length>100||typeof metadata.requestId!=='string'||!OCR_UUID.test(metadata.requestId)||
    typeof metadata.recognizedAt!=='string'||!Number.isFinite(Date.parse(metadata.recognizedAt))||new Date(metadata.recognizedAt).toISOString()!==metadata.recognizedAt)
    throw new Error('AI识别记录无效，请重新核对照片。');
  validateMeterResult(metadata.result,kind);return metadata;
}
export function validateReading(r) {
  if (!validDate(r.period) || !validDate(r.actual)) throw new Error('请填写读数所属日期和实际抄表日期。');
  amount(r.electric,'电表读数'); amount(r.gas,'燃气表读数');
  for(const kind of ['electric','gas'])if(r[kind+'Photo']?.recognition!==undefined)validateMeterRecognition(r[kind+'Photo'].recognition,kind);
  if (!r.confirmed) throw new Error('请核对并确认两项表数。');
  if (r.actual!==r.period && !r.override) throw new Error('实际抄表日与归属日期不同，请明确确认按归属日期处理。');
}
export function calculateMonth({month,stays,readings,rates,legacySettlements,legacyOccupancyReviewedAt}) {
  assertMonthOutsideLegacy({legacySettlements,legacyOccupancyReviewedAt},month);
  const b=monthBounds(month), r=rateFor(rates,month);
  validateStays(stays);
  const start=readings.find(x=>x.period===b.previous), end=readings.find(x=>x.period===b.end);
  if (!start || !end) throw new Error(`需要 ${b.previous} 和 ${b.end} 两次已确认的表数，不能把多月用量当作一个月。`);
  validateReading(start); validateReading(end);
  if (end.actual<start.actual) throw new Error('期末实际抄表日期不能早于期初。');
  const e=amount(end.electric,'期末电表')-amount(start.electric,'期初电表');
  const g=amount(end.gas,'期末气表')-amount(start.gas,'期初气表');
  if (e<0 || g<0) throw new Error('期末表数小于期初；请核对读数。换表须另行处理，不能直接相减。');
  const people=new Map();
  for(const s of stays) if(s.start<=b.end && (!s.end || s.end>=b.start)) {
    if (!people.has(s.personId)) people.set(s.personId,{id:s.personId,name:s.name,days:0,fixedWeight:0});
  }
  const rows=[...people.values()];
  const owner={id:'__owner',name:'空置期（管理方承担）',days:0,fixedWeight:0};
  for(let day=dayNumber(b.start);day<=dayNumber(b.end);day++) {
    const ds=new Date(day*DAY).toISOString().slice(0,10);
    const present=new Set(stays.filter(s=>s.start<=ds && (!s.end||s.end>=ds)).map(s=>s.personId));
    if(!present.size){owner.fixedWeight+=1;owner.days++;}
    for(const row of rows) if(present.has(row.id)){row.days++;row.fixedWeight+=1/present.size;}
  }
  if(owner.fixedWeight) rows.push(owner);
  const useWeights=rows.map(x=>x.id==='__owner' ? 0 : x.days);
  if (!useWeights.some(Boolean)) useWeights[rows.findIndex(x=>x.id==='__owner')]=1;
  const fixedWeights=rows.map(x=>x.fixedWeight);
  const kwh=g*Number(r.brennwert)*Number(r.zustand);
  const totals={electricUsage:cents(e*Number(r.electricRate)),electricBase:cents(Number(r.electricBase)/12),gasUsage:cents(kwh*Number(r.gasRate)),gasBase:cents(Number(r.gasBase)/12),tv:cents(Number(r.tv)),nk:r.includeNk?cents(Number(r.nk)):0};
  for(const [key] of FEES) {
    const distribution=allocate(totals[key],['electricBase','gasBase'].includes(key)?fixedWeights:useWeights);
    rows.forEach((row,i)=>row[key]=distribution[i]);
  }
  rows.forEach(row=>row.total=FEES.reduce((s,[key])=>s+row[key],0));
  const warnings=[];
  if(r.gasConversion!=='actual') warnings.push('燃气采用估算换算系数，最终需与供应商账单核对。');
  if(start.actual!==start.period||end.actual!==end.period) warnings.push('实际抄表日期与结算归属日期不同，用量按约定归属整月。');
  if(owner.days) warnings.push(`本月空置${owner.days}天，空置期间基本费由管理方承担。`);
  if(stays.some(s=>s.start>b.start&&s.start<=b.end || s.end&&s.end>=b.start&&s.end<b.end)) warnings.push('本月人员有进出，用量按人天估分，无法还原各人实际消耗。');
  warnings.push('每人的用量按入住人天估分；未反映个人用量或月内供暖差异。');
  return {version:VERSION,month,bounds:b,rate:structuredClone(r),start:structuredClone(start),end:structuredClone(end),electricKwh:e,gasM3:g,gasKwh:kwh,personDays:rows.filter(x=>x.id!=='__owner').reduce((s,x)=>s+x.days,0),rows,totals,total:Object.values(totals).reduce((a,b)=>a+b,0),warnings};
}
export function blankState() {
  return {version:VERSION,homeName:'Kochi 员工宿舍',stays:[],readings:[],bills:[],rates:[{id:'contract-2026',from:'2026-01',electricRate:.4108,electricBase:141.16,gasRate:.0862,gasBase:239.95,brennwert:10,zustand:1,gasConversion:'estimated',tv:19,nk:160,includeNk:false,note:'依据提供的2026年合同选定档位；未扣燃气附条件奖励。请按实际账单核对档位及换算系数。'}]};
}
export function validateState(s) {
  if (!s || s.version!==VERSION || !Array.isArray(s.stays)||!Array.isArray(s.readings)||!Array.isArray(s.rates)||!Array.isArray(s.bills)) throw new Error('备份格式或版本不正确。');
  if(typeof s.homeName!=='string'||!s.homeName.trim()||s.homeName.length>80 || s.mode!==undefined&&!['demo','local','cloud'].includes(s.mode)) throw new Error('宿舍名称或数据区无效。');
  if(s.stays.length>2000||s.readings.length>3000||s.bills.length>1500||!s.rates.length) throw new Error('数据量或合同配置无效。');
  validateStays(s.stays); s.rates.forEach(validateRate);
  if(new Set(s.rates.map(r=>r.from)).size!==s.rates.length) throw new Error('同一生效月份有重复合同。');
  if(new Set(s.rates.map(r=>r.id)).size!==s.rates.length) throw new Error('合同编号重复。');
  s.readings.forEach(validateReading);
  if(new Set(s.readings.map(r=>r.period)).size!==s.readings.length) throw new Error('同一归属日期有重复抄表。');
  if(new Set(s.bills.map(b=>b.month)).size!==s.bills.length) throw new Error('同月结算单重复。');
  if(new Set(s.bills.map(b=>b.id)).size!==s.bills.length) throw new Error('结算单编号重复。');
  for(const b of s.bills){
    monthBounds(b.month);
    if(!b.id || !b.result || b.result.month!==b.month || !Array.isArray(b.result.rows)) throw new Error('结算记录不完整。');
    if(!Number.isSafeInteger(b.result.total)||b.result.total<0 || !b.result.totals) throw new Error('结算总额无效。');
    if(new Set(b.result.rows.map(r=>r.id)).size!==b.result.rows.length) throw new Error('结算住户重复。');
    let total=0;
    for(const row of b.result.rows){
      if(!row.id||typeof row.name!=='string'||!Number.isInteger(row.days)||row.days<0||row.days>monthBounds(b.month).days) throw new Error('结算住户或入住天数无效。');
      for(const [key] of FEES) if(!Number.isSafeInteger(row[key])||row[key]<0) throw new Error('结算金额无效。');
      if(row.total!==FEES.reduce((s,[k])=>s+row[k],0)) throw new Error('结算明细金额不一致。');
      total+=row.total;
    }
    if(total!==b.result.total) throw new Error('结算总额不一致。');
    for(const [key] of FEES) if(!Number.isSafeInteger(b.result.totals[key])||b.result.rows.reduce((n,r)=>n+r[key],0)!==b.result.totals[key]) throw new Error('结算分项合计不一致。');
    if(!Array.isArray(b.payments)) throw new Error('收款记录格式无效。');
    if(new Set(b.payments.map(p=>p.id)).size!==b.payments.length) throw new Error('收款编号重复。');
    for(const p of b.payments) if(!p.id || p.personId==='__owner' || !b.result.rows.some(r=>r.id===p.personId)||!Number.isSafeInteger(p.cents)||p.cents<=0||!validDate(p.date)) throw new Error('收款记录无效。');
    for(const row of b.result.rows) if((b.payments||[]).filter(p=>p.personId===row.id).reduce((s,p)=>s+p.cents,0)>row.total) throw new Error('收款超过应交金额。');
  }
  return validateLegacyState(s);
}
