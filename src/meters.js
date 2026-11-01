const kinds=['electric','gas'];
export function validateMeterProfiles(profiles){
 if(profiles===undefined)return;
 if(!profiles||typeof profiles!=='object'||Array.isArray(profiles)||Object.keys(profiles).sort().join(',')!=='electric,gas')throw new Error('请分别设置电表和气表资料。');
 for(const kind of kinds){const p=profiles[kind];if(!p||typeof p!=='object'||Array.isArray(p)||!['hint,location,number','aliases,hint,location,number','hint,location,number,photos','aliases,hint,location,number,photos'].includes(Object.keys(p).sort().join(','))||typeof p.number!=='string'||p.number.length>80||typeof p.location!=='string'||p.location.length>300||typeof p.hint!=='string'||p.hint.length>300)throw new Error('表号最多80字，位置与拍摄提示最多300字。');validateMeterExtras(p);}
}
export function normalizeMeterNumber(number){
 if(typeof number!=='string')return '';
 const value=number.replace(/[\t\n\v\f\r ]/g,'').toUpperCase();
 return /^[A-Z0-9-]+$/.test(value)?value:'';
}
export function verifyMeterNumber(expected,observed,aliases=[]){
 const target=normalizeMeterNumber(expected),actual=normalizeMeterNumber(observed);
 if(!target)return 'unconfigured';
 if(!actual)return 'unreadable';
 return [target,...aliases.map(normalizeMeterNumber)].includes(actual)?'matched':'mismatch';
}
export const meterMatchLabel=value=>({matched:'表号匹配',mismatch:'表号不一致，请重拍',unreadable:'表号未读清，需人工核对',unconfigured:'目标表号待设置，尚不能自动验表'}[value]||'表号待核对');

export function validateMeterExtras(p){
 if(p.aliases!==undefined&&(!Array.isArray(p.aliases)||p.aliases.length>3||p.aliases.some(n=>typeof n!=='string'||!n.trim()||n.length>80||!normalizeMeterNumber(n))||new Set(p.aliases.map(normalizeMeterNumber)).size!==p.aliases.length))throw new Error('请填写最多3个已人工确认的完整表号写法。');
 if(p.photos===undefined)return;
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 const stamp=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
 if(!Array.isArray(p.photos)||p.photos.length>4||new Set(p.photos.map(x=>x?.id)).size!==p.photos.length)throw new Error('每只表最多4张不同的位置示意图。');
 for(const photo of p.photos)if(!photo||Object.keys(photo).sort().join(',')!=='addedAt,fileDate,id,name,type'||!uuid.test(photo.id)||!['image/jpeg','image/png','image/webp','image/gif'].includes(photo.type)||typeof photo.name!=='string'||!photo.name.trim()||photo.name.length>255||!stamp(photo.addedAt)||!(photo.fileDate===null||stamp(photo.fileDate)))throw new Error('位置示意图资料无效；不能使用公开网址或任意存储路径。');
}
export function meterGuideGallery(profile){
 return (profile?.photos||[]).map((p,i)=>'<figure class="guide-step"><figcaption>找表步骤 '+(i+1)+'</figcaption><a class="guide-photo-link" href="#" data-action="guide-enlarge" data-id="'+p.id+'"><img loading="lazy" class="guide-photo" data-photo="'+p.id+'" alt="找表位置示意图，步骤 '+(i+1)+'"></a></figure>').join('');
}
