#!/usr/bin/env node
/**
 * 法飞飞 AI 管理台 · SSH 本地端口转发入口。
 *
 * 线上管理台只监听服务器 127.0.0.1:8791，本脚本通过 SSH 在本地建一条
 * 127.0.0.1:18791 -> 服务器 127.0.0.1:8791 的隧道，并打开浏览器。
 *
 * 所有连接参数来自环境变量（默认值见下），SSH 主机默认使用 ~/.ssh/config
 * 中的 Host 别名，不在仓库里保存服务器地址或任何凭据：
 *   ADMIN_SSH_HOST     默认 flylegal-admin
 *   ADMIN_LOCAL_PORT   默认 18791
 *   ADMIN_REMOTE_PORT  默认 8791
 *   ADMIN_HEALTH_PATH  默认 /admin/api/health
 *
 * 用法：node scripts/ops/admin-open.mjs
 * 关闭本终端窗口（或 Ctrl+C）即断开隧道。
 */

import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import { URL } from 'node:url';

const DEFAULTS = Object.freeze({
  sshHost: 'flylegal-admin',
  localPort: 18791,
  remotePort: 8791,
  healthPath: '/admin/api/health',
});

const PORT_WAIT_TIMEOUT_MS = 15_000;
const PORT_PROBE_TIMEOUT_MS = 600;
const PORT_POLL_INTERVAL_MS = 300;
const HEALTH_TIMEOUT_MS = 10_000;

let activeSsh = null;

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
if (!Number.isInteger(nodeMajor) || nodeMajor < 18) {
  console.error(`需要 Node.js 18 或更高版本，当前版本为 ${process.versions.node}。`);
  process.exit(1);
}

main().catch((error) => {
  console.error(`[错误] 管理台隧道启动失败：${error instanceof Error ? error.message : String(error)}`);
  if (activeSsh) {
    try {
      activeSsh.kill('SIGTERM');
    } catch {
      // 子进程可能已退出，忽略。
    }
  }
  process.exit(1);
});

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(`[配置错误] ${error.message}`);
    process.exitCode = 2;
    return;
  }

  const { sshHost, localPort, remotePort, healthUrl, adminUrl } = config;

  console.log('法飞飞 AI 管理台 · SSH 隧道');

  // 已有隧道：直接复用，不重复建立。
  if (await isPortListening(localPort, PORT_PROBE_TIMEOUT_MS)) {
    console.log(`本地端口 ${localPort} 已在监听，复用现有隧道（不重复建立）。`);
    console.log(`访问地址：${adminUrl}`);
    console.log('正在打开浏览器；若未自动打开，请手动访问上面的地址。');
    await openBrowser(adminUrl);
    return;
  }

  console.log(`正在建立 SSH 隧道（Host：${sshHost}）...`);

  let ssh;
  try {
    ssh = spawn(
      'ssh',
      buildSshArgs({ localPort, remotePort, sshHost }),
      { stdio: 'inherit' },
    );
  } catch (error) {
    printSpawnError(error, sshHost);
    process.exitCode = 1;
    return;
  }
  activeSsh = ssh;

  let sshExit = null;
  let spawnError = null;
  let tunnelReady = false;
  let signalReceived = false;
  let aborting = false;

  ssh.on('error', (error) => {
    spawnError = error;
  });

  ssh.on('exit', (code, signal) => {
    sshExit = { code, signal };
    if (aborting) return;

    process.exitCode = normalizeExitCode(code, signal);
    if (!tunnelReady) return;

    console.log('');
    if (signalReceived) {
      console.log('SSH 隧道已关闭。');
    } else {
      console.log(`SSH 隧道已断开（${describeExit(code, signal)}），管理台不再可访问。`);
    }
  });

  const handleSignal = (signal) => {
    if (signalReceived) return;
    signalReceived = true;
    console.log('');
    console.log(`收到 ${signal}，正在关闭 SSH 隧道...`);

    if (ssh.exitCode !== null) {
      process.exitCode = normalizeExitCode(ssh.exitCode, ssh.signalCode);
      return;
    }

    try {
      ssh.kill(signal);
    } catch {
      try {
        ssh.kill();
      } catch {
        // 子进程已经退出。
      }
    }

    // 正常情况下 ssh 会立即退出；兜底避免窗口关不掉。
    const forceTimer = setTimeout(() => {
      try {
        ssh.kill('SIGKILL');
      } catch {
        // 忽略。
      }
      process.exitCode = signal === 'SIGINT' ? 130 : 143;
    }, 5_000);
    forceTimer.unref();
  };
  process.once('SIGINT', () => handleSignal('SIGINT'));
  process.once('SIGTERM', () => handleSignal('SIGTERM'));

  const portReady = await waitForPort(
    localPort,
    PORT_WAIT_TIMEOUT_MS,
    () => Boolean(sshExit || spawnError),
  );

  if (spawnError) {
    aborting = true;
    stopSsh(ssh);
    printSpawnError(spawnError, sshHost);
    process.exitCode = 1;
    return;
  }

  if (sshExit) {
    aborting = true;
    const exitCode = normalizeExitCode(sshExit.code, sshExit.signal) || 1;
    if (!signalReceived) {
      console.error(`[错误] SSH 隧道进程已退出（${describeExit(sshExit.code, sshExit.signal)}），本地端口 ${localPort} 未能建立。`);
      console.error(`请确认 ADMIN_SSH_HOST=${sshHost} 已在 ~/.ssh/config 中配置，且密钥与网络可用。`);
    }
    process.exitCode = exitCode;
    return;
  }

  if (!portReady) {
    aborting = true;
    if (!signalReceived) {
      console.error(`本地端口 ${localPort} 等待超时（15 秒）。`);
      console.error(`SSH 隧道未就绪，请确认 ADMIN_SSH_HOST=${sshHost} 已在 ~/.ssh/config 中配置，且密钥与网络可用。`);
    }
    stopSsh(ssh);
    process.exitCode = signalReceived ? 130 : 1;
    return;
  }

  console.log('隧道已建立，正在检查管理台...');
  const health = await checkHealth(healthUrl);

  if (signalReceived) {
    aborting = true;
    stopSsh(ssh);
    process.exitCode = 130;
    return;
  }

  if (!health.ok) {
    aborting = true;
    console.error('隧道已建立，但管理服务未响应：请检查服务器 .env.local 的 ADMIN_* 是否配置、进程是否已 reload');
    console.error(`  健康检查：GET ${healthUrl}（${health.detail}）`);
    stopSsh(ssh);
    process.exitCode = 1;
    return;
  }

  // 健康检查期间 ssh 可能刚好退出，避免误报“已就绪”。
  if (sshExit) {
    aborting = true;
    console.error(`[错误] SSH 隧道在健康检查后断开（${describeExit(sshExit.code, sshExit.signal)}）。`);
    process.exitCode = 1;
    return;
  }

  tunnelReady = true;
  console.log('管理台健康检查通过。');
  console.log(`访问地址：${adminUrl}`);
  console.log('关闭本终端窗口即断开隧道（Ctrl+C 也可退出）。');
  await openBrowser(adminUrl);

  // ssh 子进程保持前台运行；它退出时由上面的 exit 处理器同步退出码。
}

function loadConfig() {
  const sshHost = (process.env.ADMIN_SSH_HOST || '').trim() || DEFAULTS.sshHost;
  if (sshHost.startsWith('-') || /\s/.test(sshHost)) {
    throw new Error('ADMIN_SSH_HOST 必须是 ~/.ssh/config 中的 Host 别名，不能为空、包含空白或以 - 开头。');
  }

  const localPort = parsePort('ADMIN_LOCAL_PORT', process.env.ADMIN_LOCAL_PORT, DEFAULTS.localPort);
  const remotePort = parsePort('ADMIN_REMOTE_PORT', process.env.ADMIN_REMOTE_PORT, DEFAULTS.remotePort);

  let healthPath = (process.env.ADMIN_HEALTH_PATH || '').trim() || DEFAULTS.healthPath;
  if (!healthPath.startsWith('/')) healthPath = `/${healthPath}`;

  const adminUrl = `http://127.0.0.1:${localPort}`;
  const healthUrl = `${adminUrl}${healthPath}`;

  return { sshHost, localPort, remotePort, healthPath, adminUrl, healthUrl };
}

function parsePort(name, raw, fallback) {
  const text = String(raw || '').trim();
  if (!text) return fallback;
  if (!/^\d{1,5}$/.test(text)) {
    throw new Error(`${name} 必须是 1-65535 的整数（当前值：${text}）。`);
  }
  const port = Number(text);
  if (port < 1 || port > 65535) {
    throw new Error(`${name} 必须是 1-65535 的整数（当前值：${text}）。`);
  }
  return port;
}

function buildSshArgs({ localPort, remotePort, sshHost }) {
  return [
    '-N',
    '-L',
    `${localPort}:127.0.0.1:${remotePort}`,
    '-o',
    'BatchMode=yes',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=3',
    sshHost,
  ];
}

function isPortListening(port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
  });
}

async function waitForPort(port, timeoutMs, shouldStop) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    if (shouldStop()) return false;

    const probeTimeout = Math.min(PORT_PROBE_TIMEOUT_MS, remaining);
    if (await isPortListening(port, probeTimeout)) {
      return !shouldStop();
    }
    if (shouldStop()) return false;

    const nextRemaining = deadline - Date.now();
    if (nextRemaining <= 0) return false;
    await sleep(Math.min(PORT_POLL_INTERVAL_MS, nextRemaining));
  }
}

function checkHealth(url) {
  return new Promise((resolve) => {
    let settled = false;
    let request = null;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (request) {
        try {
          request.destroy();
        } catch {
          // 请求可能已经结束。
        }
      }
      resolve(result);
    };

    try {
      request = http.get(new URL(url), (response) => {
        const statusCode = response.statusCode || 0;
        response.resume();

        if (statusCode < 200 || statusCode >= 300) {
          finish({ ok: false, detail: `HTTP ${statusCode}` });
          return;
        }

        response.on('error', (error) => {
          finish({ ok: false, detail: `读取响应失败：${error.message}` });
        });
        response.on('end', () => finish({ ok: true, statusCode }));
      });
    } catch (error) {
      finish({ ok: false, detail: error.message });
      return;
    }

    timer = setTimeout(() => {
      request.destroy(new Error(`请求超时（${HEALTH_TIMEOUT_MS / 1_000} 秒）`));
    }, HEALTH_TIMEOUT_MS);

    request.on('error', (error) => {
      finish({ ok: false, detail: error.message });
    });
  });
}

function stopSsh(ssh) {
  if (!ssh || ssh.exitCode !== null) return;
  try {
    ssh.kill('SIGTERM');
  } catch {
    try {
      ssh.kill();
    } catch {
      return;
    }
  }

  const forceTimer = setTimeout(() => {
    try {
      ssh.kill('SIGKILL');
    } catch {
      // 已退出。
    }
  }, 3_000);
  forceTimer.unref();
}

function openBrowser(url) {
  let command;
  let args;
  if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (process.platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    try {
      const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
      child.once('spawn', () => {
        child.unref();
        done();
      });
      child.once('error', (error) => {
        console.error(`无法自动打开浏览器（${error.code || error.message}），请手动访问：${url}`);
        done();
      });
    } catch (error) {
      console.error(`无法自动打开浏览器（${error.message}），请手动访问：${url}`);
      done();
    }
  });
}

function printSpawnError(error, sshHost) {
  let reason;
  if (error && error.code === 'ENOENT') {
    reason = '找不到 ssh 命令，请先安装 OpenSSH 客户端，并确认 ssh 已加入 PATH。';
  } else if (error && error.code === 'EACCES') {
    reason = 'ssh 命令没有执行权限。';
  } else {
    reason = error instanceof Error ? error.message : String(error);
  }

  console.error(`[错误] 无法启动 SSH 隧道：${reason}`);
  console.error(`请确认 ADMIN_SSH_HOST=${sshHost} 已在 ~/.ssh/config 中配置，且密钥与网络可用。`);
}

function normalizeExitCode(code, signal) {
  if (Number.isInteger(code) && code >= 0) return code;
  switch (signal) {
    case 'SIGHUP':
      return 129;
    case 'SIGINT':
      return 130;
    case 'SIGTERM':
      return 143;
    case 'SIGKILL':
      return 137;
    default:
      return 1;
  }
}

function describeExit(code, signal) {
  const parts = [];
  if (Number.isInteger(code)) parts.push(`退出码 ${code}`);
  if (signal) parts.push(`信号 ${signal}`);
  return parts.length > 0 ? parts.join('，') : '原因未知';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
