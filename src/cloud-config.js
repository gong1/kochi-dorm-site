// Public browser configuration only. Independent dorm project; Auth, membership and RLS protect all business data.
export const CLOUD_CONFIG = Object.freeze({supabaseUrl: 'https://sysoqtygjmzohwrivipi.supabase.co', supabasePublishableKey: 'sb_publishable_eAmWYq7gDStVo1h0msErag_7DVAi_xY'});

export function validateCloudConfig(config = CLOUD_CONFIG) {
  if (!config || typeof config !== 'object') throw new TypeError('云端配置无效。');
  if (Object.keys(config).some(k => /secret|service.?role|password|access.?token/i.test(k))) {
    throw new TypeError('云端浏览器配置不能包含服务端密钥。');
  }
  const url = config.supabaseUrl, key = config.supabasePublishableKey;
  if (!url && !key) return null;
  if (typeof url !== 'string' || !/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.supabase\.co\/?$/.test(url)) {
    throw new TypeError('请配置新独立项目的 HTTPS Supabase 地址。');
  }
  if (typeof key !== 'string' || !/^sb_publishable_[A-Za-z0-9_-]{16,}$/.test(key)) {
    throw new TypeError('浏览器只能使用新项目的公开 publishable key。');
  }
  return Object.freeze({supabaseUrl: url.replace(/\/$/, ''), supabasePublishableKey: key});
}
