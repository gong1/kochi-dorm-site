import {validateState,validateReading,validDate,dayNumber,today} from './engine.js';
import {confirmInterval,validateIntervalState,latestSettledCheckpoint,assertCheckpointReading} from './intervals.js';
const uid=()=>crypto.randomUUID();
const plusOne=date=>new Date((dayNumber(date)+1)*86400000).toISOString().slice(0,10);
const stable=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item);
const same=(a,b)=>stable(a)===stable(b);
const historicalCutoff=(state,date)=> (state.legacySettlements||[]).find(bill=>bill.kind==='legacy-fixed'&&bill.periodEnd===date&&bill.meter.end.period===date&&bill.meter.end.actual!==date);
export function movementReadingForDate(state,date){
 return (state.movementEvents||[]).find(event=>event.date===date&&event.observation)?.observation||state.readings.find(reading=>reading.period===date&&reading.actual===date)||null;
}
export function billingCheckpoint(state){
 const settled=latestSettledCheckpoint(state);if(settled)return settled;
 return [...state.readings].sort((a,b)=>a.period.localeCompare(b.period))[0]||null;
}
export function assertMovementDate(state,date){
 if(!validDate(date)||date>today())throw new Error('进出日期须为有效的实际日期，不能晚于今天。');
 const lastEvent=(state.movementEvents||[]).map(event=>event.date).sort().at(-1);
 if(lastEvent&&date<lastEvent)throw new Error('进出日期不能早于最近已办理的人员变化；已确认资料需要单独更正。');
 const ordinary=[...state.bills.map(bill=>bill.result.end.period),...(state.intervalBills||[]).map(bill=>bill.coverageEnd)].sort().at(-1);
 if(ordinary&&date<ordinary)throw new Error('这段费用已按原入住情况结算，不能倒填进出日期；请先单独核对更正。');
 const checkpoint=billingCheckpoint(state);
 if(checkpoint&&date<checkpoint.period){
  const coveredFutureHistory=(state.legacySettlements||[]).some(bill=>bill.kind==='legacy-fixed'&&bill.periodEnd===checkpoint.period&&bill.periodEnd>today()&&date>=bill.periodStart&&date>=bill.meter.end.actual&&date<=bill.periodEnd);
  if(!coveredFutureHistory)throw new Error('进出日期早于现有抄表或结算基准，不能直接办理；请先单独核对更正。');
 }
 return date;
}
export function previewMovement(state,{kind,personId,name,stayId,date,reading},{now=new Date()}={}){
 validateIntervalState(state);
 if(!['in','out'].includes(kind)||!validDate(date)||date>today()||!reading||reading.period!==date||reading.actual!==date||reading.confirmed!==true)throw new Error('请按实际进出日期核对当天两张表；进出日期不能晚于今天。');
 assertMovementDate(state,date);
 const historical=historicalCutoff(state,date),observation=historical?structuredClone(reading):null;
 const frozenCheckpoint=latestSettledCheckpoint(state);if(!observation&&frozenCheckpoint&&date===frozenCheckpoint.period)assertCheckpointReading(frozenCheckpoint,reading);
 const next=structuredClone(state);let person,stay;
 const existing=next.readings.find(r=>r.period===date);
 if(observation){
  const shared=movementReadingForDate(state,date);
  if(!existing||existing.id!==historical.meter.end.id||observation.id===existing.id||state.readings.some(row=>row.id===observation.id))throw new Error('现场抄表须独立保存，不能改写历史计费基准。');
  if(shared&&!same(shared,observation))throw new Error('当天已有现场抄表，请共用该记录，不重复抄表或改写。');
 }
 else if(existing){if(!same(existing,reading))throw new Error('当天已有确认表数，请共用该记录；不要重复抄表或覆盖。');}
 else next.readings.push(structuredClone(reading));
 if(kind==='in'){
  const known=[...next.stays.map(s=>({id:s.personId,name:s.name})),...(next.legacySettlements||[]).flatMap(h=>h.rows.map(r=>({id:r.id,name:r.name})))];
  const prior=personId?known.find(p=>p.id===personId):null;
  if(personId&&!prior)throw new Error('请选择已有住户身份。');
  person=personId||uid();const personName=prior?.name||String(name||'').trim();
  if(!personName||personName.length>80)throw new Error('请填写住户姓名。');
  if(!prior&&known.some(p=>p.name===personName))throw new Error('已有同名住户，再次入住请选择原身份。');
  stay={id:uid(),personId:person,name:personName,start:date,chargeStart:plusOne(date),end:null};next.stays.push(stay);
 }else{
  stay=next.stays.find(s=>s.id===stayId);
  if(!stay||stay.end||stay.start>date)throw new Error('请选择这一天仍在住的住户。');
  person=stay.personId;stay.end=date;
 }
 validateState(next);
 const checkpoint=billingCheckpoint(state);let reason='baseline',settlementId=null;
 if(checkpoint&&date>checkpoint.period){
  const start=next.readings.find(r=>r.id===checkpoint.id);
  if(!start)throw new Error('上一结算基准缺失，请先核对资料。');
  const settled=confirmInterval(next,{startReadingId:start.id,endReadingId:reading.id,reason:kind==='in'?'move-in':'move-out',reviewed:true});
  next.intervalBills=settled.intervalBills;settlementId=next.intervalBills.at(-1).id;reason='interval';
 }else if(checkpoint){reason=observation?'covered':date===checkpoint.period?'same-day':'covered';}
 next.movementEvents=[...(next.movementEvents||[]),{id:uid(),kind,personId:person,stayId:stay.id,date,readingId:observation?historical.meter.end.id:reading.id,settlementId,createdAt:now.toISOString(),...(observation?{observation}:{} )}];
 validateMovementEvents(next);validateIntervalState(next);
 return {state:next,settlementId,reason,checkpoint,personId:person};
}
export function validateMovementEvents(state){
 const events=state.movementEvents===undefined?[]:state.movementEvents;
 if(!Array.isArray(events)||events.length>3000)throw new Error('进出记录格式无效。');
 const ids=new Set(),observations=new Map(),observationDates=new Map();let previousDate=null;
 for(const e of events){
  if(!e||typeof e!=='object'||Array.isArray(e)||Object.keys(e).sort().join(',')!==(Object.hasOwn(e,'observation')?'createdAt,date,id,kind,observation,personId,readingId,settlementId,stayId':'createdAt,date,id,kind,personId,readingId,settlementId,stayId')||typeof e.id!=='string'||!e.id||ids.has(e.id)||!['in','out'].includes(e.kind)||!validDate(e.date)||e.date>today()||typeof e.personId!=='string'||!e.personId||typeof e.stayId!=='string'||!e.stayId||typeof e.readingId!=='string'||!e.readingId||typeof e.createdAt!=='string'||!Number.isFinite(Date.parse(e.createdAt))||new Date(e.createdAt).toISOString()!==e.createdAt||Date.parse(e.createdAt)>Date.now()+300000)throw new Error('进出记录不完整。');
  const stay=state.stays.find(s=>s.id===e.stayId),reading=state.readings.find(r=>r.id===e.readingId),bill=(state.intervalBills||[]).find(b=>b.id===e.settlementId);
  let actualReading=reading;
  if(Object.hasOwn(e,'observation')){
   const observation=e.observation,historical=historicalCutoff(state,e.date),allowed=new Set(['id','period','actual','electric','gas','confirmed','override','note','electricPhoto','gasPhoto']);
   if(!observation||typeof observation!=='object'||Array.isArray(observation)||Object.keys(observation).some(key=>!allowed.has(key))||typeof observation.id!=='string'||!observation.id||observation.id.length>100||typeof observation.electric!=='number'||typeof observation.gas!=='number'||typeof observation.override!=='boolean'||!historical||!reading||reading.id!==historical.meter.end.id||observation.id===reading.id||state.readings.some(row=>row.id===observation.id)||e.settlementId!==null||observation.note!==undefined&&(typeof observation.note!=='string'||observation.note.length>300))throw new Error('历史截止日的现场抄表记录无效，不能改写历史基准或生成重复费用。');
   validateReading(observation);
   if(observationDates.has(observation.id)&&observationDates.get(observation.id)!==e.date||observations.has(e.date)&&!same(observations.get(e.date),observation))throw new Error('同日人员变化须共用同一份现场抄表，不能重复或改写。');
   observations.set(e.date,observation);observationDates.set(observation.id,e.date);actualReading=observation;
  }
  if(!stay||stay.personId!==e.personId||!actualReading||actualReading.period!==e.date||actualReading.actual!==e.date||actualReading.confirmed!==true||e.kind==='in'&&(stay.start!==e.date||stay.chargeStart!==plusOne(e.date))||e.kind==='out'&&stay.end!==e.date||e.settlementId!==null&&(!bill||bill.coverageEnd!==e.date||bill.result.end.id!==e.readingId||bill.reason!==(e.kind==='in'?'move-in':'move-out')))throw new Error('进出记录与人员、当天抄表或结算不一致。');
  if(previousDate&&e.date<previousDate)throw new Error('人员进出记录必须按实际日期先后办理，不能倒填已确认记录。');previousDate=e.date;
  ids.add(e.id);
 }
 return state;
}
