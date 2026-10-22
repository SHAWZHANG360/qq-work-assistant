import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFamilyApplication } from './family-application.mjs';
import { createLocalServer } from './server.mjs';
import { QQClient } from './qq-client.mjs';
import { formatAnalysis } from './analyzer.mjs';
import { createDeepSeek } from './deepseek.mjs';
import { createDeepSeekSettings } from './deepseek-settings.mjs';
import { createDocumentStore } from './documents.mjs';
import { validateConfig, preferencesFor } from './config.mjs';

export async function startAssistant({ config, dataDir, pythonExecutable, port = 18080,
  Client = QQClient, provider, documentStore, onStop = () => {} }) {
  config = validateConfig(config);
  if (!path.isAbsolute(dataDir) || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('运行路径或端口无效。');
  if (!pythonExecutable || !path.isAbsolute(pythonExecutable) || !fs.existsSync(pythonExecutable)) throw new Error('缺少 Python 解释器，请运行安装脚本。');
  let application;
  const server = createLocalServer({ port, application: {
    state: () => application.state(),
    uploadDocuments: body => application.uploadDocuments(body),
    configure: async () => { throw new Error('请运行服务器配置向导。'); },
    saveModelSettings: body => application.saveModelSettings(body),
    testAnalysis: () => application.testAnalysis(), setPaused: body => application.setPaused(body),
    retry: () => application.retry(), stop: () => application.stop(),
  }, onStop: () => { server.close(); onStop(); } });
  await new Promise((resolve,reject) => {
    server.once('error',reject);
    server.listen(port,'127.0.0.1',resolve);
  });
  try {
    fs.mkdirSync(dataDir,{ recursive:true,mode:0o700 });
    provider ??= createDeepSeek({ apiKey: config.deepseekApiKey });
    application = createFamilyApplication({ appId: config.appId, sharingEnabled:config.sharingEnabled, dataDir, preferences: preferencesFor(config), Client,
      ...provider, analyze: provider.analyzeMessage, formatAnalysis,
      secrets: { exists: () => true, load: async () => config.qqAppSecret },
      pythonExecutable,
      settingsFactory:dir=>createDeepSeekSettings({dataDir:dir}),
      documentFactory:dir=>dir===dataDir&&documentStore?documentStore:createDocumentStore({dataDir:dir,pythonExecutable}),
    });
    await application.restore();
  } catch (error) { application?.stop(); server.close(); throw error; }
  const close = async () => {
    application.stop();
    await new Promise(resolve => server.close(resolve));
  };
  return { server, application, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.umask(0o077);
  try {
    const credentials = process.env.CREDENTIALS_DIRECTORY;
    if (!credentials) throw new Error('需要 systemd LoadCredential。');
    const file = path.join(credentials,'assistant-config');
    if (fs.statSync(file).size > 8192) throw new Error('配置过大。');
    const runtime = await startAssistant({ config: JSON.parse(fs.readFileSync(file,'utf8')),
      dataDir: '/var/lib/qq-work-assistant',
      pythonExecutable: '/opt/qq-work-assistant/.venv/bin/python',
      onStop: () => setTimeout(() => process.exit(0),100).unref(),
    });
    console.log('助手已启动；通过 SSH 隧道打开管理页，首次使用请完成本人绑定。');
    for (const signal of ['SIGTERM','SIGINT']) process.once(signal,async () => { await runtime.close(); process.exit(0); });
  } catch {
    console.error('启动失败：检查配置、数据目录、Python 或端口；详细凭据不会写入日志。');
    process.exitCode=1;
  }
}
