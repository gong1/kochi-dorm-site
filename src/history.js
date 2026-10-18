// Generic historical agreements only. Real names, readings and amounts belong in
// the owner's private import payload, never in source or synthetic test fixtures.
const HISTORY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const historyDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value+'T00:00:00Z')) && new Date(value+'T00:00:00Z').toISOString().slice(0,10) === value;
const historyTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && historyDate(value.slice(0,10)) && Number.isFinite(Date.parse(value));
const historyToday = () => new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const historyMoney = value => Number.isSafeInteger(value) && value >= 0;
const historyError = text => {throw new Error(text);};
export function legacyPaidFor(settlement, personId) {
  return (settlement.payments || []).filter(p=>p.personId===personId).reduce((sum,p)=>sum+p.cents,0);
}
export function legacyNextMonth(state) {
  const end=(state.legacySettlements || []).map(h=>h.periodEnd).sort().at(-1);
  if(!end)return null;
  const [y,m]=end.slice(0,7).split('-').map(Number);
  return new Date(Date.UTC(y,m,1)).toISOString().slice(0,7);
}
export function assertMonthOutsideLegacy(state,month) {
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || ''))historyError('请选择有效月份。');
  const legacy=state.legacySettlements || [];
  if(legacy.some(h=>month>=h.periodStart.slice(0,7)&&month<=h.periodEnd.slice(0,7)))historyError('该月份属于已确认历史协议，不能再次生成月结或重复收费。');
  if(legacy.length && (!historyTime(state.legacyOccupancyReviewedAt) || Date.parse(state.legacyOccupancyReviewedAt)>Date.now()))historyError('请先核对历史住户当前谁仍在住、离开或新入住，并明确确认当前入住资料。');
}
export function validateLegacyState(state) {
  const list=state.legacySettlements === undefined ? [] : state.legacySettlements;
  if(!Array.isArray(list)||list.length>50)historyError('历史结算格式无效。');
  if(list.length && !Object.hasOwn(state,'legacyOccupancyReviewedAt'))historyError('缺少当前入住核对状态，请使用支持历史结算的新版页面。');
  if(state.legacyOccupancyReviewedAt!=null && (!historyTime(state.legacyOccupancyReviewedAt)||Date.parse(state.legacyOccupancyReviewedAt)>Date.now()))historyError('当前入住核对时间无效或晚于现在。');
  const ids=new Set((state.bills || []).map(b=>b.id)),keys=new Set(),paymentIds=new Set();
  for(const b of state.bills || [])for(const p of b.payments || []){if(paymentIds.has(p.id))historyError('月结与历史收款编号必须全局唯一。');paymentIds.add(p.id);}
  for(const h of list) {
    if(!h || !HISTORY_UUID.test(h.id)||ids.has(h.id)||!HISTORY_UUID.test(h.importKey)||keys.has(h.importKey)||h.kind!=='legacy-fixed')historyError('历史结算编号或类型无效。');
    ids.add(h.id);keys.add(h.importKey);
    if(typeof h.title!=='string'||!h.title.trim()||h.title.length>120||!historyDate(h.periodStart)||!historyDate(h.periodEnd)||h.periodEnd<h.periodStart||!historyTime(h.confirmedAt)||Date.parse(h.confirmedAt)>Date.now()||h.includeNk!==false)historyError('历史结算日期、登记时间或固定协议设置无效。');
    if(!Array.isArray(h.notes)||h.notes.length>20||h.notes.some(n=>typeof n!=='string'||n.length>2000)||!Array.isArray(h.rows)||!h.rows.length||h.rows.length>2000||!Array.isArray(h.payments))historyError('历史结算明细或说明无效。');
    const people=new Set();let total=0;
    for(const row of h.rows) {
      if(!HISTORY_UUID.test(row.id)||people.has(row.id)||typeof row.name!=='string'||!row.name.trim()||row.name.length>80||!historyDate(row.stayStart)||row.stayStart<h.periodStart||!historyDate(row.settledThrough)||row.settledThrough!==h.periodEnd||row.stayStart>row.settledThrough||!Number.isInteger(row.months)||row.months<1||row.months>1200||!historyMoney(row.totalCents))historyError('历史人员固定应收、起日或结算截止资料无效。');
      people.add(row.id);total+=row.totalCents;
    }
    if(!historyMoney(total)||!historyMoney(h.totalCents)||total!==h.totalCents)historyError('历史分人金额与协议总额不一致。');
    const start=h.meter?.start,end=h.meter?.end;
    if(!start||!end||start.period!==h.periodStart||end.period!==h.periodEnd||!HISTORY_UUID.test(end.id)||!historyDate(end.actual)||end.actual<start.period||end.confirmed!==true||typeof end.override!=='boolean'||end.actual!==end.period&&!end.override)historyError('历史首尾表数或实际/归属日期说明无效。');
    for(const key of ['electric','gas'])if(typeof start[key]!=='number'||typeof end[key]!=='number'||!Number.isFinite(start[key])||!Number.isFinite(end[key])||start[key]<0||end[key]<start[key]||end[key]>1e9)historyError('历史表数无效。');
    const current=(state.readings || []).filter(r=>r.period===end.period);
    if(current.length!==1 || ['id','period','actual','electric','gas','confirmed','override'].some(k=>current[0][k]!==end[k]))historyError('历史期末基准表数不可删除、替换或改写。');
    for(const p of h.payments) {
      if(!p||!HISTORY_UUID.test(p.id)||paymentIds.has(p.id)||!people.has(p.personId)||!Number.isSafeInteger(p.cents)||p.cents<=0||!historyDate(p.date)||p.date>historyToday()||!['现金','银行转账','其他'].includes(p.method)||typeof p.note!=='string'||p.note.length>300)historyError('历史收款编号、日期、金额或方式无效。');
      paymentIds.add(p.id);
    }
    for(const row of h.rows)if(legacyPaidFor(h,row.id)>row.totalCents)historyError('历史收款不能超过该住户固定应收。');
  }
  const sorted=[...list].sort((a,b)=>a.periodStart.localeCompare(b.periodStart));
  for(let i=1;i<sorted.length;i++)if(sorted[i].periodStart<=sorted[i-1].periodEnd)historyError('历史协议覆盖期不能重叠。');
  for(const b of state.bills || [])assertMonthOutsideLegacy(state,b.month);
  return state;
}
export function recordLegacyPayment(state,{settlementId,personId,value,date,method,note}) {
  validateLegacyState(state);
  const next=structuredClone(state),h=(next.legacySettlements || []).find(x=>x.id===settlementId),row=h?.rows.find(r=>r.id===personId);
  if(!h||!row)historyError('请选择有效的历史结算住户。');
  const str=String(value);
  if(str.length>20||!/^\d+(\.\d{1,2})?$/.test(str))historyError('收款金额必须为正数，最多两位小数。');
  const [whole,fraction='']=str.split('.'),big=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
  if(big>BigInt(Number.MAX_SAFE_INTEGER)||big<=0n)historyError('收款金额无效。');
  const cents=Number(big);
  if(cents>row.totalCents-legacyPaidFor(h,personId))historyError('收款不能超过该住户历史剩余应收。');
  if(!historyDate(date)||date>historyToday())historyError('收款日期无效或晚于今天。');
  if(!['现金','银行转账','其他'].includes(method))historyError('请选择收款方式。');
  h.payments.push({id:crypto.randomUUID(),personId,cents,date,method,note:String(note || '').slice(0,300)});
  return validateLegacyState(next);
}
export function confirmLegacyOccupancy(state,reviewed) {
  if(!reviewed)historyError('请明确确认已核对当前入住资料，结算截止日不代表实际退房。');
  const next=structuredClone(state);next.legacyOccupancyReviewedAt=new Date().toISOString();return validateLegacyState(next);
}
