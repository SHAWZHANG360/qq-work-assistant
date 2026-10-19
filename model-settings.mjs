const failure = message => Object.assign(new Error(message), { code: 'MODEL_SETTINGS_INVALID' });
export function validateModelSettings(value, models) {
  const keys = ['textModel', 'imageModel', 'reasoningEffort'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key) || typeof value[key] !== 'string')) {
    throw failure('请完整选择文字模型、图片模型和推理强度。');
  }
  const selected = keys.slice(0, 2).map(key => models.find(model => model.id === value[key]));
  if (selected.some(model => !model)) throw failure('模型不在本机可选目录中，请重新选择。');
  if (!selected[1].supportsImages) throw failure('图片识别必须选择支持图片输入的模型。');
  if (selected.some(model => !model.reasoningEfforts.includes(value.reasoningEffort))) {
    throw failure('所选推理强度不同时适用于这两个模型；请选择默认或双方支持的强度。');
  }
  return { textModel: value.textModel, imageModel: value.imageModel, reasoningEffort: value.reasoningEffort };
}

