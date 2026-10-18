import {blankState, calculateMonth, cents, monthBounds, today, validateState, validDate} from './engine.js';

export const id = () => crypto.randomUUID();
export function exampleState() {
  const s=blankState();
  s.mode='demo';
  s.stays=[
    {id:'demo-stay-1',personId:'demo-person-1',name:'林一（示例）',start:'2026-09-01',end:null},
    {id:'demo-stay-2',personId:'demo-person-2',name:'陈二（示例）',start:'2026-09-01',end:null},
    {id:'demo-stay-3',personId:'demo-person-3',name:'周三（示例）',start:'2026-09-16',end:null}
  ];
  s.readings=[
    {id:'demo-reading-1',period:'2026-08-31',actual:'2026-08-31',electric:1000,gas:100,confirmed:true,override:false},
    {id:'demo-reading-2',period:'2026-09-30',actual:'2026-09-30',electric:1120,gas:124,confirmed:true,override:false}
  ];
  return s;
}
export function newLocalState() {return {...blankState(),mode:'local'};}
export function paidFor(bill,personId) {return (bill.payments||[]).filter(p=>p.personId===personId).reduce((n,p)=>n+p.cents,0);}
export function confirmMonth(state,month,reviewed) {
  if(!reviewed) throw new Error('请先核对分摊规则、估算说明和金额。');
  if(state.bills.some(b=>b.month===month)) throw new Error('该月已经确认，不能重复生成或覆盖。');
  const result=calculateMonth({...state,month});
  const next=structuredClone(state);
  next.bills.push({id:id(),month,confirmedAt:new Date().toISOString(),homeName:state.homeName,mode:state.mode,
    inputs:structuredClone({stays:state.stays,readings:[result.start,result.end],rates:[result.rate]}),result,payments:[]});
  return validateState(next);
}
export function recordPayment(state,{billId,personId,value,date,method,note}) {
  const next=structuredClone(state),bill=next.bills.find(b=>b.id===billId);
  if(!bill) throw new Error('请先确认该月结算单。');
  const row=bill.result.rows.find(r=>r.id===personId && r.id!=='__owner');
  if(!row) throw new Error('请选择需要收款的住户。');
  if(!/^\d+(\.\d{1,2})?$/.test(String(value))) throw new Error('收款金额必须为正数，最多两位小数。');
  const amount=cents(Number(value));
  if(!Number.isSafeInteger(amount)||amount<=0||amount>row.total-paidFor(bill,personId)) throw new Error('收款须大于零，且不能超过该住户剩余应收。');
  if(!validDate(date)||date>today()) throw new Error('请选择有效的收款日期，不能晚于今天。');
  if(!['现金','银行转账','其他'].includes(method)) throw new Error('请选择收款方式。');
  bill.payments.push({id:id(),personId,cents:amount,date,method,note:String(note||'').slice(0,300)});
  return validateState(next);
}
export function photoIds(state) {
  const readings=[...state.readings,...state.bills.flatMap(b=>b.inputs?.readings||[])];
  return [...new Set(readings.flatMap(r=>[r.electricPhoto?.id,r.gasPhoto?.id]).filter(Boolean))];
}
export function validateBackup(data,mode) {
  if(mode==='cloud')throw new Error('云端暂不支持整份替换恢复，请保留导出备份并联系管理方。');
  if(data?.format!=='kochi-dorm-local-backup'||data.version!==1||data.state?.mode!==mode) throw new Error('备份格式不正确或数据区不同；请先切换至备份对应的示例/本机数据区。');
  validateState(data.state);
  if(!Array.isArray(data.photos)||data.photos.length>6000) throw new Error('照片备份格式不正确。');
  const ids=new Set();
  for(const p of data.photos) {
    if(!p.id||ids.has(p.id)||typeof p.data!=='string'||!/^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(p.data)||p.data.length>12e6) throw new Error('备份含无效或过大的照片。');
    ids.add(p.id);
  }
  if(photoIds(data.state).some(key=>!ids.has(key))) throw new Error('备份缺少抄表照片，不能恢复。');
  return data;
}
export function suggestedMonth(state) {
  const latest=state.readings.map(r=>r.period.slice(0,7)).sort().at(-1);
  const month=latest||today().slice(0,7);monthBounds(month);return month;
}
