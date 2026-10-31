// Monthly employee reimbursements are independent of accommodation dates.
const fail=()=>{throw new Error('固定费用或收款记录无效，请核对人员、月份和金额。');};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const month=value=>typeof value==='string'&&/^(20|21)\d{2}-(0[1-9]|1[0-2])$/.test(value);
const date=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const text=(value,max)=>typeof value==='string'&&value.trim().length>0&&value.length<=max;
const exact=(obj,keys)=>obj&&Object.keys(obj).sort().join(',')===keys.sort().join(',');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
export function feeToday(){return new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
export function feeCents(value){
  if(!/^\d{1,6}(\.\d{1,2})?$/.test(String(value)))fail();
  const [whole,part='']=String(value).split('.'),n=Number(whole)*100+Number(part.padEnd(2,'0'));
  if(!Number.isSafeInteger(n)||n<=0||n>10000000)fail();return n;
}
export function validateRecurring(state){
  const fees=state.recurringFees??[],payments=state.feePayments??[];
  if(!Array.isArray(fees)||!Array.isArray(payments)||fees.length>1000||payments.length>10000)fail();
  const ids=new Set(),people=new Set([...(state.stays||[]).map(s=>s.personId),...(state.legacySettlements||[]).flatMap(b=>b.rows.map(r=>r.id))]);
  for(const fee of fees){
    if(!exact(fee,['id','personId','name','label','cents','start','end'])||!uuid.test(fee.id)||ids.has(fee.id)||!text(fee.personId,100)||fee.personId==='__owner'||!text(fee.name,80)||!text(fee.label,80)||!Number.isSafeInteger(fee.cents)||fee.cents<=0||fee.cents>10000000||!month(fee.start)||!(fee.end===null||month(fee.end)&&fee.end>=fee.start))fail();
    ids.add(fee.id);people.add(fee.personId);
  }
  for(const a of fees)for(const b of fees)if(a.id!==b.id&&a.personId===b.personId&&a.label===b.label&&(!a.end||a.end>=b.start)&&(!b.end||b.end>=a.start))fail();
  const paymentIds=new Set([...(state.bills||[]),...(state.intervalBills||[]),...(state.legacySettlements||[])].flatMap(b=>(b.payments||[]).map(p=>p.id))),paid=new Map();
  for(const p of payments){
    const fee=fees.find(f=>f.id===p.feeId),key=p.feeId+'/'+p.month;
    if(!exact(p,['id','feeId','personId','month','cents','date','method','note'])||!uuid.test(p.id)||paymentIds.has(p.id)||!fee||p.personId!==fee.personId||!month(p.month)||p.month<fee.start||fee.end&&p.month>fee.end||!Number.isSafeInteger(p.cents)||p.cents<=0||!date(p.date)||p.date.slice(0,7)<p.month||!['现金','银行转账','其他'].includes(p.method)||typeof p.note!=='string'||p.note.length>300)fail();
    paymentIds.add(p.id);paid.set(key,(paid.get(key)||0)+p.cents);if(paid.get(key)>fee.cents)fail();
  }
  return state;
}
export function recurringCharges(state,asOf=feeToday()){
  validateRecurring(state);if(!date(asOf))fail();const limit=asOf.slice(0,7),charges=[];
  for(const fee of state.recurringFees||[]){
    let current=fee.start;
    while(current<=limit&&(!fee.end||current<=fee.end)){
      const receipts=(state.feePayments||[]).filter(p=>p.feeId===fee.id&&p.month===current),paidCents=receipts.reduce((n,p)=>n+p.cents,0);
      charges.push({kind:'recurring',billId:fee.id+'/'+current,feeId:fee.id,personId:fee.personId,name:fee.name,month:current,date:current+'-01',title:current+' '+fee.label,dueCents:fee.cents,paidCents,balanceCents:fee.cents-paidCents,payments:receipts});
      const [y,m]=current.split('-').map(Number);current=m===12?String(y+1)+'-01':String(y)+'-'+String(m+1).padStart(2,'0');
    }
  }return charges;
}
export function validateRecurringTransition(previous,next,asOf=feeToday()){
  validateRecurring(next);const current=asOf.slice(0,7),oldFees=previous?.recurringFees||[],fees=next.recurringFees||[],oldPayments=previous?.feePayments||[],payments=next.feePayments||[];
  for(const old of oldFees){const fee=fees.find(f=>f.id===old.id);if(!fee||!same({...old,end:null},{...fee,end:null})||old.end!==null&&old.end!==fee.end||old.end===null&&fee.end!==null&&fee.end<current)fail();}
  for(const fee of fees.filter(f=>!oldFees.some(old=>old.id===f.id))){if(Number(current.slice(0,4))-Number(fee.start.slice(0,4))>10)fail();}
  if(payments.length<oldPayments.length||!oldPayments.every((p,i)=>same(p,payments[i])))fail();
  for(const p of payments.slice(oldPayments.length))if(p.date>asOf||p.month>current)fail();
  return next;
}
export function addRecurringFee(state,input){
  const next=structuredClone(state),fee={id:crypto.randomUUID(),personId:input.personId||crypto.randomUUID(),name:String(input.name||'').trim(),label:String(input.label||'').trim(),cents:feeCents(input.value),start:input.start,end:input.end||null};
  const names=[...(state.stays||[]),...(state.recurringFees||[]),...(state.legacySettlements||[]).flatMap(b=>b.rows.map(r=>({personId:r.id,name:r.name})))];
  const existing=names.find(p=>p.personId===fee.personId);if(existing)fee.name=existing.name;
  if(!input.personId&&names.some(p=>p.name===fee.name))throw new Error('已有同名人员，请选择已有员工，避免分开记账。');
  if((next.recurringFees||[]).some(f=>f.personId===fee.personId&&f.label===fee.label&&(!f.end||f.end>=fee.start)&&(!fee.end||fee.end>=f.start)))throw new Error('该员工已有重叠月份的同名费用，请勿重复添加。');
  (next.recurringFees??=[]).push(fee);return validateRecurringTransition(state,next);
}
export function stopRecurringFee(state,feeId,end){
  const next=structuredClone(state),fee=next.recurringFees?.find(f=>f.id===feeId);if(!fee||fee.end!==null||!month(end)||end<fee.start)fail();fee.end=end;return validateRecurringTransition(state,next);
}
export function recordFeePayment(state,charge,input){
  const next=structuredClone(state);(next.feePayments??=[]).push({id:crypto.randomUUID(),feeId:charge.feeId,personId:charge.personId,month:charge.month,cents:feeCents(input.value),date:input.date,method:input.method,note:String(input.note||'').slice(0,300)});return validateRecurringTransition(state,next);
}
