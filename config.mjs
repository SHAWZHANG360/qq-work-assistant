export function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置文件无效。');
  const keys = ['appId', 'qqAppSecret', 'deepseekApiKey', 'name', 'organization', 'department', 'sharingEnabled'];
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('配置包含未知字段。');
  if (typeof value.appId !== 'string' || !/^[0-9]{5,20}$/.test(value.appId)) throw new Error('AppID 必须是5到20位数字字符串。');
  for (const key of ['qqAppSecret','deepseekApiKey']) {
    if (typeof value[key] !== 'string' || value[key].length < 16 || value[key].length > 512 || /\s|[\u0000-\u001f\u007f]/u.test(value[key])) throw new Error('密钥格式无效，请运行配置向导。');
  }
  const result = { appId: value.appId, qqAppSecret: value.qqAppSecret, deepseekApiKey: value.deepseekApiKey };
  if(value.sharingEnabled!==undefined&&typeof value.sharingEnabled!=='boolean')throw new Error('共享开关必须为布尔值。');
  result.sharingEnabled=value.sharingEnabled??false;
  for (const key of ['name','organization','department']) {
    const text = value[key] ?? '';
    if (typeof text !== 'string' || text.length > 100 || /[\u0000-\u001f\u007f]/u.test(text)) throw new Error('个人关键词格式无效。');
    result[key] = text.trim();
  }
  return result;
}

export function preferencesFor(config) {
  return {
    version: 1,
    ownerProfile: { name: config.name, college: config.organization, department: config.department },
    relevanceKeywords: [config.name, config.organization, config.department].filter(Boolean),
    timeZone: 'Asia/Shanghai',
    analysisRules: ['个人关键词只判断相关性，不能作为身份凭据。', '仅分析本条材料，未知日期和责任人不猜测。'],
  };
}
