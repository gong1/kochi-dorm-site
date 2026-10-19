const kinds=['electric','gas'];
export function validateMeterProfiles(profiles){
 if(profiles===undefined)return;
 if(!profiles||typeof profiles!=='object'||Array.isArray(profiles)||Object.keys(profiles).sort().join(',')!=='electric,gas')throw new Error('请分别设置电表和气表资料。');
 for(const kind of kinds){const p=profiles[kind];if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).sort().join(',')!=='hint,location,number'||typeof p.number!=='string'||p.number.length>80||typeof p.location!=='string'||p.location.length>300||typeof p.hint!=='string'||p.hint.length>300)throw new Error('表号最多80字，位置与拍摄提示最多300字。');}
}
export function normalizeMeterNumber(number){
 if(typeof number!=='string')return '';
 const value=number.replace(/[\t\n\v\f\r ]/g,'').toUpperCase();
 return /^[A-Z0-9-]+$/.test(value)?value:'';
}
export function verifyMeterNumber(expected,observed){
 const target=normalizeMeterNumber(expected),actual=normalizeMeterNumber(observed);
 if(!target)return 'unconfigured';
 if(!actual)return 'unreadable';
 return target===actual?'matched':'mismatch';
}
export const meterMatchLabel=value=>({matched:'表号匹配',mismatch:'表号不一致，请重拍',unreadable:'表号未读清，需人工核对',unconfigured:'目标表号待设置，尚不能自动验表'}[value]||'表号待核对');
