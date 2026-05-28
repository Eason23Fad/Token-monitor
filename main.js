const { app, BrowserWindow, ipcMain } = require('electron');
const https = require('https');
const http = require('http');
const path = require('path');

// 禁用 GPU 缓存（避免 C 盘权限弹窗）
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.setPath('userData', path.join(__dirname, '.electron-cache'));

let win;
let proxyServer = null;
const PROXY_PORT = 3456;
const proxyStats = {
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  totalRequests: 0,
  startTime: null,
  lastRequestTime: null,
};

// ─── 窗口 ──────────────────────────────────────
function createWindow() {
  const { screen } = require('electron');
  const disp = screen.getPrimaryDisplay();
  const cx = disp.workArea.x + Math.round((disp.workArea.width - 380) / 2);
  const cy = disp.workArea.y + Math.round((disp.workArea.height - 340) / 2);

  win = new BrowserWindow({
    width: 380,
    height: 340,
    x: cx,
    y: cy,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    backgroundColor: '#0d0d1a',
    show: false,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  win.loadFile('index.html');
  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });
  win.setVisibleOnAllWorkspaces(true);
}

// ─── 安全的 HTTPS GET ────────────────────────────
function safeGet(url, apiKey) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const cleanKey = apiKey.replace(/[^\x21-\x7E]/g, '').trim();
    if (!cleanKey) return reject(new Error('API Key 为空'));

    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          Authorization: 'Bearer ' + cleanKey,
          'User-Agent': 'DS-Monitor/1.0',
          Accept: 'application/json',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(body)); }
            catch { reject(new Error('数据解析失败')); }
          } else if (res.statusCode === 401) {
            reject(new Error('API Key 无效'));
          } else if (res.statusCode === 402) {
            reject(new Error('余额不足'));
          } else if (res.statusCode === 429) {
            reject(new Error('请求过于频繁'));
          } else {
            reject(new Error('HTTP ' + res.statusCode));
          }
        });
      }
    );

    req.on('error', (e) => reject(new Error('网络错误: ' + e.message)));
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('请求超时')); });
    req.end();
  });
}

// ─── API ────────────────────────────────────────
async function fetchBalance(key) {
  return safeGet('https://api.deepseek.com/user/balance', key);
}

// ─── 本地代理服务器 ──────────────────────────────
function startProxy(port) {
  if (proxyServer) return true;

  proxyServer = http.createServer((clientReq, clientRes) => {
    // 内置监控接口
    if (clientReq.url === '/_monitor/stats' && clientReq.method === 'GET') {
      clientRes.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      return clientRes.end(JSON.stringify(proxyStats));
    }

    // 构造转发请求
    const options = {
      hostname: 'api.deepseek.com',
      port: 443,
      path: clientReq.url,
      method: clientReq.method,
      headers: { ...clientReq.headers },
    };
    // 修正 Host 头
    options.headers.host = 'api.deepseek.com';
    // 移除代理相关的头
    delete options.headers['proxy-connection'];

    const proxyReq = https.request(options, (proxyRes) => {
      // 先写响应头
      const { statusCode, headers: resHeaders } = proxyRes;
      // 去除不允许转发的头
      delete resHeaders['transfer-encoding'];
      clientRes.writeHead(statusCode, resHeaders);

      // 收集响应体用于解析 usage
      const chunks = [];

      proxyRes.on('data', (chunk) => {
        chunks.push(chunk);
        clientRes.write(chunk);
      });

      proxyRes.on('end', () => {
        clientRes.end();
        // 尝试从响应中提取 usage 数据
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          const isStreaming = (clientReq.url || '').includes('stream=true');

          if (isStreaming) {
            // 流式响应：usage 在最后一个 data 块中
            const lines = body.split('\n');
            for (let i = lines.length - 1; i >= 0; i--) {
              const line = lines[i].trim();
              if (line.startsWith('data:') && !line.includes('[DONE]')) {
                try {
                  const json = JSON.parse(line.slice(5).trim());
                  if (json.usage) {
                    proxyStats.totalPromptTokens += json.usage.prompt_tokens || 0;
                    proxyStats.totalCompletionTokens += json.usage.completion_tokens || 0;
                    proxyStats.totalRequests++;
                    proxyStats.lastRequestTime = Date.now();
                  }
                } catch {}
                break;
              }
            }
          } else {
            // 非流式：直接解析 JSON
            const data = JSON.parse(body);
            if (data.usage) {
              proxyStats.totalPromptTokens += data.usage.prompt_tokens || 0;
              proxyStats.totalCompletionTokens += data.usage.completion_tokens || 0;
              proxyStats.totalRequests++;
              proxyStats.lastRequestTime = Date.now();
            }
          }
        } catch {}
      });
    });

    proxyReq.on('error', () => {
      clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
      clientRes.end('Proxy error: 无法连接到 DeepSeek API');
    });

    // 超时
    proxyReq.setTimeout(30000, () => { proxyReq.destroy(); });

    // 转发请求体
    clientReq.pipe(proxyReq);
  });

  return new Promise((resolve) => {
    proxyServer.listen(port, () => {
      proxyStats.startTime = Date.now();
      console.log('[ds-monitor] 代理已启动，端口: ' + port);
      resolve(true);
    });
    proxyServer.on('error', (err) => {
      proxyServer = null;
      resolve(false);
    });
  });
}

function stopProxy() {
  if (proxyServer) {
    proxyServer.close();
    proxyServer = null;
  }
}

// ─── IPC ────────────────────────────────────────
ipcMain.handle('api:fetch', async (_e, rawKey) => {
  const key = typeof rawKey === 'string' ? rawKey.replace(/[^\x21-\x7E]/g, '').trim() : '';
  const result = { balance: null, balanceError: null, usage: null, usageError: null, proxy: null };

  if (!key) {
    result.balanceError = 'API Key 为空';
    return result;
  }

  // 余额
  try {
    const b = await fetchBalance(key);
    const info = b.balance_infos?.[0] || {};
    result.balance = {
      total: parseFloat(info.total_balance) || 0,
      granted: parseFloat(info.granted_balance) || 0,
      toppedUp: parseFloat(info.topped_up_balance) || 0,
    };
  } catch (e) {
    result.balanceError = e.message;
  }

  // 注：DeepSeek 未提供公开的用量查询 API
  // 使用内置代理追踪实际使用量
  result.usageError = '用量数据通过本地代理 (端口 ' + PROXY_PORT + ') 实时追踪';

  // 代理状态
  result.proxy = {
    running: proxyServer !== null,
    port: PROXY_PORT,
    stats: { ...proxyStats },
  };

  return result;
});

ipcMain.handle('api:getProxyStats', async () => {
  return { ...proxyStats, running: proxyServer !== null, port: PROXY_PORT };
});

ipcMain.handle('api:startProxy', async () => {
  const BASE_PORT = 3456;
  for (let attempt = 0; attempt < 5; attempt++) {
    const tryPort = BASE_PORT + attempt;
    if (await startProxy(tryPort)) {
      return { ok: true, port: tryPort };
    }
  }
  return { ok: false, port: BASE_PORT };
});

ipcMain.handle('api:stopProxy', async () => {
  stopProxy();
  return true;
});

ipcMain.handle('api:resetProxyStats', async () => {
  proxyStats.totalPromptTokens = 0;
  proxyStats.totalCompletionTokens = 0;
  proxyStats.totalRequests = 0;
  proxyStats.lastRequestTime = null;
  return true;
});

ipcMain.on('minimize', () => win?.minimize());
ipcMain.on('close', () => win?.close());

// ─── 启动 ───────────────────────────────────────
app.whenReady().then(async () => {
  console.log('[ds-monitor] 应用启动中...');
  console.log('[ds-monitor] __dirname:', __dirname);
  console.log('[ds-monitor] preload:', path.join(__dirname, 'preload.js'));

  createWindow();
  console.log('[ds-monitor] 窗口已创建');

  // 自动启动代理（端口被占则尝试 +1 +2 …）
  let proxyStarted = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const tryPort = PROXY_PORT + attempt;
    if (await startProxy(tryPort)) {
      proxyStarted = true;
      break;
    }
  }
  if (!proxyStarted) {
    console.warn('[ds-monitor] 代理启动失败（所有端口被占），用量追踪不可用');
  }
});
app.on('window-all-closed', () => {
  stopProxy();
  app.quit();
});
