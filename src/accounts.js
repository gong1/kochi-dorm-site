import {monthBounds,today,validDate} from './engine.js';
import {recordPayment} from './model.js';
import {recordLegacyPayment} from './history.js';
import {recordIntervalPayment,validateIntervalState} from './intervals.js';

const fail=message=>{throw new Error(message);};
const sumCents=(left,right)=>{
  const value=left+right;
  if(!Number.isSafeInteger(left)||left<0||!Number.isSafeInteger(right)||right<0||!Number.isSafeInteger(value))fail('个人账户金额无效或超出范围。');
  return value;
};
const sourceOrder={legacy:0,monthly:1,interval:2};
const chronological=(a,b)=>a.date.localeCompare(b.date)||sourceOrder[a.kind]-sourceOrder[b.kind]||a.billId.localeCompare(b.billId)||(a.id||'').localeCompare(b.id||'');

// A projection of confirmed charges and actual receipts only. Readings and
// unconfirmed calculation previews never become a personal debt here.
export function accountSummary(state) {
  const people=new Map(),now=today();
  const person=(personId,name)=>{
    if(personId==='__owner')return null;
    if(typeof personId!=='string'||!personId||typeof name!=='string'||!name.trim())fail('个人账户身份无效。');
    if(!people.has(personId))people.set(personId,{id:personId,name,active:false,dueCents:0,paidCents:0,balanceCents:0,charges:[],payments:[]});
    return people.get(personId);
  };
  function addBill(kind,bill,rows,date,title,dueFor) {
    if(typeof bill.id!=='string'||!bill.id||!validDate(date)||!Array.isArray(rows)||!Array.isArray(bill.payments))fail('个人账户结算记录不完整。');
    const rowPeople=new Set();
    for(const row of rows) {
      const account=person(row.id,row.name);if(!account)continue;
      if(rowPeople.has(row.id))fail('个人账户结算住户重复。');
      rowPeople.add(row.id);
      const dueCents=dueFor(row),receipts=bill.payments.filter(payment=>payment.personId===row.id);
      let paidCents=0;
      for(const payment of receipts) {
        if(!validDate(payment.date)||typeof payment.id!=='string'||!payment.id||payment.cents<=0)fail('个人账户收款记录无效。');
        paidCents=sumCents(paidCents,payment.cents);
        account.payments.push({id:payment.id,kind,billId:bill.id,personId:row.id,date:payment.date,title,cents:payment.cents,method:payment.method,note:payment.note||''});
      }
      sumCents(0,dueCents);
      if(paidCents>dueCents)fail('个人账户实收超过应收。');
      account.charges.push({kind,billId:bill.id,personId:row.id,date,title,dueCents,paidCents,balanceCents:dueCents-paidCents});
      account.dueCents=sumCents(account.dueCents,dueCents);
      account.paidCents=sumCents(account.paidCents,paidCents);
    }
    if(bill.payments.some(payment=>!rowPeople.has(payment.personId)))fail('个人账户收款没有对应住户费用。');
  }
  for(const bill of state.legacySettlements||[])addBill('legacy',bill,bill.rows,bill.periodEnd,bill.title,row=>row.totalCents);
  for(const bill of state.bills||[])addBill('monthly',bill,bill.result?.rows,monthBounds(bill.month).end,`${bill.month} 月结`,row=>row.total);
  for(const bill of state.intervalBills||[])addBill('interval',bill,bill.result?.rows,bill.coverageEnd,`${bill.coverageStart} 至 ${bill.coverageEnd} 结算`,row=>row.total);
  // Current names come from occupancy, while every frozen charge keeps its own
  // original bill. A second stay reuses the existing person identity.
  for(const stay of [...state.stays].sort((a,b)=>a.start.localeCompare(b.start)||a.id.localeCompare(b.id))) {
    const account=person(stay.personId,stay.name);if(!account)continue;
    account.name=stay.name;
    if(stay.start<=now&&(!stay.end||stay.end>now))account.active=true;
  }
  return [...people.values()].map(account=>({
    ...account,balanceCents:account.dueCents-account.paidCents,
    charges:account.charges.sort(chronological),payments:account.payments.sort(chronological),
  }));
}

function paymentCents(value) {
  const text=String(value);
  if(text.length>20||!/^\d+(\.\d{1,2})?$/.test(text))fail('收款金额必须为正数，最多两位小数。');
  const [whole,fraction='']=text.split('.'),amount=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
  if(amount<=0n||amount>BigInt(Number.MAX_SAFE_INTEGER))fail('收款金额无效。');
  return Number(amount);
}
const decimalCents=value=>`${Math.floor(value/100)}.${String(value%100).padStart(2,'0')}`;

// Build every allocation in memory and return one next state. The caller makes
// exactly one normal CAS save, never a separate network write per charge.
export function recordAccountPayment(state,{personId,value,date,method,note}) {
  validateIntervalState(state);
  const amount=paymentCents(value),account=accountSummary(state).find(person=>person.id===personId);
  if(!account)fail('请选择有效的收款住户。');
  if(amount>account.balanceCents)fail('收款不能超过该住户剩余应收。');
  if(!validDate(date)||date>today())fail('请选择有效的收款日期，不能晚于今天。');
  if(!['现金','银行转账','其他'].includes(method))fail('请选择收款方式。');
  const common={personId,date,method,note:String(note||'').slice(0,300)};
  let next=state,remaining=amount;
  for(const charge of account.charges) {
    const allocation=Math.min(remaining,charge.balanceCents);
    if(!allocation)continue;
    const input={...common,value:decimalCents(allocation)};
    if(charge.kind==='legacy')next=recordLegacyPayment(next,{...input,settlementId:charge.billId});
    else if(charge.kind==='monthly')next=recordPayment(next,{...input,billId:charge.billId});
    else next=recordIntervalPayment(next,{...input,billId:charge.billId});
    remaining-=allocation;
    if(!remaining)break;
  }
  if(remaining)fail('收款分配未完成，请刷新核对账户。');
  return validateIntervalState(next);
}
