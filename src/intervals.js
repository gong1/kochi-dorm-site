import {FEES, allocate, cents, dayNumber, monthBounds, rateFor, today, validateReading, validateState, validDate} from './engine.js';

const DAY = 86400000;
const MAX_DAYS = 3660;
const REASONS = new Set(['manual', 'move-in', 'move-out', 'change', 'month-end']);
const MONEY_KEYS = FEES.map(([key]) => key);
const METHODS = new Set(['现金', '银行转账', '其他']);
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const same = (a, b) => canonical(a) === canonical(b);
const dateAt = day => new Date(day * DAY).toISOString().slice(0, 10);
const nextDate = date => dateAt(dayNumber(date) + 1);
const validCents = value => Number.isSafeInteger(value) && value >= 0;
const fail = message => {throw new Error(message);};

function chargeStart(stay) {
  if (stay.chargeStart === undefined) return stay.start;
  if (!validDate(stay.chargeStart) || stay.chargeStart < stay.start) fail('入住计费起日无效，不能早于实际入住日。');
  return stay.chargeStart;
}

function boundsFor(start, end) {
  const days = dayNumber(end.period) - dayNumber(start.period);
  if (days <= 0) fail('本次抄表日期须晚于上次结算基准；同日人员变化共用一次抄表和结算。');
  if (days > MAX_DAYS) fail('单次结算区间最长十年，请按真实抄表分段结算。');
  return {start: nextDate(start.period), end: end.period, previous: start.period, days};
}

// Each month's rounded fee is assigned to calendar days once. Summing any
// partition of that month therefore recovers the same cents without per-event
// rounding drift. Earlier calendar days receive the deterministic remainder.
function dailyCents(monthly, date) {
  const days = monthBounds(date.slice(0, 7)).days;
  const quotient = Math.floor(monthly / days), remainder = monthly % days;
  return quotient + (Number(date.slice(8, 10)) <= remainder ? 1 : 0);
}

function calculate({stays, readings, rates}, {startReadingId, endReadingId, reason = 'manual'}) {
  if (!REASONS.has(reason)) fail('请选择有效的结算原因。');
  if (typeof startReadingId !== 'string' || typeof endReadingId !== 'string' || !startReadingId || !endReadingId) fail('请选择首尾两次已核对的抄表记录。');
  const starts = readings.filter(reading => reading.id === startReadingId), ends = readings.filter(reading => reading.id === endReadingId);
  if (starts.length !== 1 || ends.length !== 1) fail('首尾抄表记录缺失或编号重复。');
  const start = starts[0], end = ends[0];
  validateReading(start);validateReading(end);
  const bounds = boundsFor(start, end);
  if (end.actual < start.actual) fail('期末实际抄表日期不能早于期初。');
  if (end.actual > today() || end.period > today()) fail('不能提前确认未来日期的区间费用，请使用已完成的真实抄表。');
  const electricKwh = Number(end.electric) - Number(start.electric), gasM3 = Number(end.gas) - Number(start.gas);
  if (electricKwh < 0 || gasM3 < 0) fail('期末表数小于期初；请核对读数。换表须另行处理，不能直接相减。');
  const rate = rateFor(rates, bounds.start.slice(0, 7));
  for (let day = dayNumber(bounds.start); day <= dayNumber(bounds.end); day++) {
    if (!same(rateFor(rates, dateAt(day).slice(0, 7)), rate)) fail('区间内合同费率发生变化；请在变更处取得真实读数并分段结算，不能推算分价用量。');
  }

  const people = new Map();
  for (const stay of stays) {
    const first = chargeStart(stay);
    if (first <= bounds.end && (!stay.end || stay.end >= bounds.start)) {
      if (!people.has(stay.personId)) people.set(stay.personId, {id: stay.personId, name: stay.name, days: 0, fixedWeight: 0});
    }
  }
  const rows = [...people.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const row of rows) for (const key of MONEY_KEYS) row[key] = 0;
  const owner = {id: '__owner', name: '空置期（管理方承担）', days: 0, fixedWeight: 0};
  for (const key of MONEY_KEYS) owner[key] = 0;
  const totals = {electricUsage: 0, electricBase: 0, gasUsage: 0, gasBase: 0, tv: 0, nk: 0};
  const monthly = {electricBase: cents(Number(rate.electricBase) / 12), gasBase: cents(Number(rate.gasBase) / 12), tv: cents(Number(rate.tv)), nk: rate.includeNk ? cents(Number(rate.nk)) : 0};
  for (let day = dayNumber(bounds.start); day <= dayNumber(bounds.end); day++) {
    const date = dateAt(day);
    const presentIds = new Set(stays.filter(stay => chargeStart(stay) <= date && (!stay.end || stay.end >= date)).map(stay => stay.personId));
    const present = rows.filter(row => presentIds.has(row.id));
    const recipients = present.length ? present : [owner];
    if (!present.length) owner.days++;
    for (const row of present) {row.days++;row.fixedWeight += 1 / present.length;}
    if (!present.length) owner.fixedWeight++;
    for (const key of ['electricBase', 'gasBase', 'tv', 'nk']) {
      const value = dailyCents(monthly[key], date);totals[key] += value;
      if (key === 'electricBase' || key === 'gasBase') {
        // Rotate the stable ID order by the calendar day so the same resident
        // does not receive every daily remainder. A checkpoint never resets it.
        const offset = ((day % recipients.length) + recipients.length) % recipients.length;
        const order = [...recipients.slice(offset), ...recipients.slice(0, offset)];
        const shares = allocate(value, order.map(() => 1));
        order.forEach((row, index) => row[key] += shares[index]);
      }
    }
  }
  if (owner.days) rows.push(owner);
  const useWeights = rows.map(row => row.id === '__owner' ? 0 : row.days);
  if (!useWeights.some(Boolean)) useWeights[rows.findIndex(row => row.id === '__owner')] = 1;
  const gasKwh = gasM3 * Number(rate.brennwert) * Number(rate.zustand);
  totals.electricUsage = cents(electricKwh * Number(rate.electricRate));
  totals.gasUsage = cents(gasKwh * Number(rate.gasRate));
  for (const key of ['electricUsage', 'gasUsage', 'tv', 'nk']) {
    const shares = allocate(totals[key], useWeights);
    rows.forEach((row, index) => row[key] = shares[index]);
  }
  for (const row of rows) row.total = MONEY_KEYS.reduce((sum, key) => sum + row[key], 0);
  const total = Object.values(totals).reduce((sum, value) => sum + value, 0);
  if (!validCents(total) || Object.values(totals).some(value => !validCents(value))) fail('区间费用超出有效范围。');
  const warnings = [];
  if (rate.gasConversion !== 'actual') warnings.push('燃气采用估算换算系数，最终需与供应商账单核对。');
  if (start.actual !== start.period || end.actual !== end.period) warnings.push('实际抄表日期与结算归属日期不同，用量按明确确认的归属区间处理。');
  if (owner.days) warnings.push(`区间空置${owner.days}天，空置期间基本费由管理方承担。`);
  if (stays.some(stay => chargeStart(stay) > bounds.start && chargeStart(stay) <= bounds.end || stay.end && stay.end >= bounds.start && stay.end < bounds.end)) warnings.push('区间内人员有变化，用量按入住人天估分；如有人员变化时的真实读数，宜按检查点分段结算。');
  warnings.push('每人的用量及电视费按计费人天分摊；电、气基本费按当日人数分摊。');
  warnings.push('入住当次结算截至当天，新入住从下一计费区间开始；搬出当天计入。');
  return {version: 1, kind: 'interval', reason, bounds, rate: structuredClone(rate), start: structuredClone(start), end: structuredClone(end), electricKwh, gasM3, gasKwh, personDays: rows.filter(row => row.id !== '__owner').reduce((sum, row) => sum + row.days, 0), rows, totals, total, warnings};
}

function coverage(state) {
  const entries = [];
  for (const historical of state.legacySettlements || []) entries.push({id: historical.id, start: historical.periodStart, end: historical.periodEnd});
  for (const bill of state.bills) {const bounds = monthBounds(bill.month);entries.push({id: bill.id, start: bounds.start, end: bounds.end});}
  for (const bill of state.intervalBills || []) entries.push({id: bill.id, start: bill.coverageStart, end: bill.coverageEnd});
  return entries;
}

function assertNoOverlap(state, bounds, excludingId) {
  if (coverage(state).some(entry => entry.id !== excludingId && entry.start <= bounds.end && entry.end >= bounds.start)) fail('该区间与已确认历史、月结或区间结算重叠，不能重复收费。');
}

export function latestSettledCheckpoint(state) {
  const readings = [...(state.legacySettlements || []).map(bill => bill.meter.end), ...state.bills.map(bill => bill.result.end), ...(state.intervalBills || []).map(bill => bill.result.end)];
  return readings.sort((a, b) => a.period < b.period ? -1 : a.period > b.period ? 1 : 0).at(-1) || null;
}

const readingCore = reading => ({id: reading.id, period: reading.period, actual: reading.actual, electric: reading.electric, gas: reading.gas, confirmed: reading.confirmed, override: reading.override ?? false});

export function assertCheckpointReading(checkpoint, reading) {
  if (!same(readingCore(reading), readingCore(checkpoint))) fail('当前抄表与已冻结结算基准不一致，请先核对并单独更正；不能用改写后的表数继续收费。');
}

function assertCurrentCheckpoint(state, startReadingId) {
  const checkpoint = latestSettledCheckpoint(state) || [...state.readings].sort((a, b) => a.period < b.period ? -1 : a.period > b.period ? 1 : 0)[0];
  if (!checkpoint) fail('缺少起始抄表基准，请先核对资料。');
  const start = state.readings.find(reading => reading.id === startReadingId);
  if (!start || start.id !== checkpoint.id || start.period !== checkpoint.period) fail('本次须从最近已确认结算基准连续计算，不能跳过尚未结算的日期或用量。');
  assertCheckpointReading(checkpoint, start);
}

export function calculateInterval(state, options) {
  validateIntervalState(state);
  if ((state.legacySettlements || []).length && !state.legacyOccupancyReviewedAt) fail('请先核对历史住户当前入住状态。');
  const result = calculate(state, options);
  assertNoOverlap(state, result.bounds);
  assertCurrentCheckpoint(state, options?.startReadingId);
  return result;
}

export function confirmInterval(state, {reviewed, ...options}) {
  if (!reviewed) fail('请先核对本次结算区间、住户、表数和金额。');
  if (!['demo', 'local', 'cloud'].includes(state.mode)) fail('请先选择有效的数据区。');
  const result = calculateInterval(state, options), next = structuredClone(state);
  next.intervalBills ||= [];
  next.intervalBills.push({id: crypto.randomUUID(), kind: 'interval', coverageStart: result.bounds.start, coverageEnd: result.bounds.end, reason: result.reason, confirmedAt: new Date().toISOString(), homeName: state.homeName, mode: state.mode, inputs: structuredClone({stays: state.stays, readings: [result.start, result.end], rates: [result.rate]}), result, payments: []});
  return validateIntervalState(next);
}

export function intervalPaidFor(bill, personId) {
  return (bill.payments || []).filter(payment => payment.personId === personId).reduce((sum, payment) => sum + payment.cents, 0);
}

export function validateIntervalState(state) {
  validateState(state);
  const bills = state.intervalBills === undefined ? [] : state.intervalBills;
  if (!Array.isArray(bills) || bills.length > 1500) fail('区间结算资料无效或超过当前上限。');
  for (const stay of state.stays) chargeStart(stay);
  const ids = new Set([...state.bills.map(bill => bill.id), ...(state.legacySettlements || []).map(bill => bill.id)]);
  const paymentIds = new Set();
  for (const bill of [...state.bills, ...(state.legacySettlements || [])]) for (const payment of bill.payments || []) {
    if (paymentIds.has(payment.id)) fail('所有结算的收款编号须全局唯一。');
    paymentIds.add(payment.id);
  }
  for (const bill of bills) {
    if (!bill || typeof bill.id !== 'string' || !bill.id || bill.id.length > 100 || ids.has(bill.id) || bill.kind !== 'interval' || !REASONS.has(bill.reason) || typeof bill.homeName !== 'string' || !bill.homeName.trim() || bill.homeName.length > 80 || !['demo', 'local', 'cloud'].includes(bill.mode)) fail('区间结算编号或快照资料无效。');
    ids.add(bill.id);
    if (!validDate(bill.coverageStart) || !validDate(bill.coverageEnd) || bill.coverageStart > bill.coverageEnd) fail('区间结算覆盖日期无效。');
    if (typeof bill.confirmedAt !== 'string' || !Number.isFinite(Date.parse(bill.confirmedAt)) || new Date(bill.confirmedAt).toISOString() !== bill.confirmedAt || Date.parse(bill.confirmedAt) > Date.now() + 300000) fail('区间结算确认时间无效。');
    if (!bill.inputs || !Array.isArray(bill.inputs.stays) || !Array.isArray(bill.inputs.readings) || bill.inputs.readings.length !== 2 || !Array.isArray(bill.inputs.rates) || bill.inputs.rates.length !== 1) fail('区间结算缺少冻结计算依据。');
    // Validate snapshots independently from today's editable records. Changes to
    // current occupancy, rates, readings or names must not rewrite old bills.
    validateState({...state, stays: bill.inputs.stays, readings: bill.inputs.readings, rates: bill.inputs.rates, bills: [], legacySettlements: [], intervalBills: []});
    const [start, end] = bill.inputs.readings;
    const expected = calculate(bill.inputs, {startReadingId: start.id, endReadingId: end.id, reason: bill.reason});
    if (bill.coverageStart !== expected.bounds.start || bill.coverageEnd !== expected.bounds.end || !same(expected, bill.result)) fail('区间结算金额或冻结依据不一致。');
    if (!Array.isArray(bill.payments)) fail('区间收款记录格式无效。');
    for (const payment of bill.payments) {
      if (!payment || typeof payment.id !== 'string' || !payment.id || payment.id.length > 100 || paymentIds.has(payment.id) || payment.personId === '__owner' || !bill.result.rows.some(row => row.id === payment.personId) || !Number.isSafeInteger(payment.cents) || payment.cents <= 0 || !validDate(payment.date) || payment.date > today() || !METHODS.has(payment.method) || typeof payment.note !== 'string' || payment.note.length > 300) fail('区间收款编号、日期、金额或方式无效。');
      paymentIds.add(payment.id);
    }
    for (const row of bill.result.rows) if (intervalPaidFor(bill, row.id) > row.total) fail('区间收款不能超过该住户剩余应收。');
    assertNoOverlap(state, expected.bounds, bill.id);
  }
  return state;
}

export function recordIntervalPayment(state, {billId, personId, value, date, method, note}) {
  validateIntervalState(state);
  const next = structuredClone(state), bill = (next.intervalBills || []).find(entry => entry.id === billId);
  const row = bill?.result.rows.find(entry => entry.id === personId && entry.id !== '__owner');
  if (!row) fail('请选择已确认区间结算中的有效住户。');
  const input = String(value);
  if (input.length > 20 || !/^\d+(\.\d{1,2})?$/.test(input)) fail('收款金额必须为正数，最多两位小数。');
  const [whole, fraction = ''] = input.split('.');
  const parsed = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (parsed <= 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) fail('收款金额无效。');
  const amount = Number(parsed);
  if (amount > row.total - intervalPaidFor(bill, personId)) fail('收款不能超过该住户区间剩余应收。');
  if (!validDate(date) || date > today()) fail('请选择有效的实际收款日期，不能晚于今天。');
  if (!METHODS.has(method)) fail('请选择收款方式。');
  bill.payments.push({id: crypto.randomUUID(), personId, cents: amount, date, method, note: String(note || '').slice(0, 300)});
  return validateIntervalState(next);
}
