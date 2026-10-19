export const METER_KINDS=Object.freeze(['electric','gas']);
const MIME_TYPES=new Set(['image/jpeg','image/png','image/webp','image/gif']);
const validValue=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1000000000;
export function usableMeterResult(kind,result){return result?.status==='ok'&&result.meterType===kind&&result.unit===(kind==='electric'?'kWh':'m3')&&validValue(result.value);}

// File references and tickets, rather than names, keep late results away from retaken photos.
export function createMeterOcrSession(){
  let serial=0,pending=false,response=null;
  const files={electric:null,gas:null},recognized={electric:null,gas:null},applied=new Set();
  const invalidate=()=>{serial++;pending=false;response=null;};
  return {
    select(kind,file){if(!METER_KINDS.includes(kind))throw new Error('表类型无效。');if(files[kind]!==file){invalidate();files[kind]=file||null;recognized[kind]=null;applied.delete(kind);}},
    edit(kind){invalidate();if(METER_KINDS.includes(kind))applied.delete(kind);},
    begin(){if(!files.electric||!files.gas)throw new Error('请分别拍摄或选择一张电表和一张气表照片。');invalidate();pending=true;return {serial,files:{...files}};},
    current(ticket){return ticket?.serial===serial&&METER_KINDS.every(kind=>files[kind]===ticket.files[kind]);},
    finish(ticket,value){if(!this.current(ticket))return false;pending=false;response=value;for(const kind of METER_KINDS)recognized[kind]={file:files[kind],metadata:{version:1,provider:'OpenAI',model:value.model,recognizedAt:value.recognizedAt,requestId:value.requestId,result:structuredClone(value.readings[kind])}};return true;},
    fail(ticket){if(!this.current(ticket))return false;pending=false;return true;},
    adopt(){if(!response)throw new Error('请先识别当前两张照片。');const values={};for(const kind of METER_KINDS)if(usableMeterResult(kind,response.readings[kind])){values[kind]=response.readings[kind].value;applied.add(kind);}if(!Object.keys(values).length)throw new Error('两张照片都需要手工核对，暂不能采用识别读数。');return values;},
    metadata(kind,file){const item=recognized[kind];return item?.file===file?structuredClone(item.metadata):null;},
    clear(){invalidate();for(const kind of METER_KINDS)recognized[kind]=null;applied.clear();},
    info(){return {pending,response,applied:[...applied],hasPhotos:METER_KINDS.every(kind=>Boolean(files[kind]))};}
  };
}

// Only the recognition copy is resized; callers retain the untouched original File for private storage.
export async function prepareMeterPhoto(file,kind){
  if(!METER_KINDS.includes(kind)||!file?.size||file.size>8*1024*1024||!MIME_TYPES.has(file.type))throw new Error('识别照片限8 MB以内的 JPG / PNG / WebP / GIF；HEIC请先转成JPG。');
  const url=URL.createObjectURL(file),image=new Image();
  try{
    image.src=url;await image.decode();
    const width=image.naturalWidth,height=image.naturalHeight;
    if(!width||!height||width*height>64*1024*1024)throw new Error('照片尺寸过大或无法读取，请重新拍摄表盘近照。');
    const ratio=Math.min(1,2048/Math.max(width,height)),canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(width*ratio));canvas.height=Math.max(1,Math.round(height*ratio));
    const context=canvas.getContext('2d');if(!context)throw new Error('当前浏览器无法准备识别照片，请换用最新版浏览器或手工输入。');
    context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);
    for(const quality of [.9,.8,.7,.65]){
      const encoded=canvas.toDataURL('image/jpeg',quality),match=/^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(encoded);
      if(!match)throw new Error('浏览器无法生成识别照片，请改用JPG或手工输入。');
      const data=match[1],bytes=data.length*3/4-(data.endsWith('==')?2:data.endsWith('=')?1:0);
      if(bytes<=1.5*1024*1024)return {kind,mimeType:'image/jpeg',data};
    }
    throw new Error('识别副本仍超过1.5 MB，请裁切到表盘近照后重试；原读数可手工输入。');
  }catch(error){if(error?.name==='EncodingError')throw new Error('照片无法打开，请重新拍摄JPG照片；HEIC请先转换。');throw error;}
  finally{URL.revokeObjectURL(url);}
}
