'use strict';

const { spawn } = require('node:child_process');
const readline = require('node:readline');

function defaultLaunch() {
  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'codex app-server --stdio'],
    };
  }
  return { command: 'codex', args: ['app-server', '--stdio'] };
}

function spawnCodexAppServer(options = {}) {
  const launch = options.command
    ? { command: options.command, args: options.args || [] }
    : defaultLaunch();
  const onDiagnostic = options.onDiagnostic || (() => {});
  const child = spawn(launch.command, launch.args, {
    cwd: options.cwd,
    env: options.env || process.env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let lineHandler = () => {};
  let exitHandler = () => {};
  let closed = false;
  const stdout = readline.createInterface({ input: child.stdout });
  const stderr = readline.createInterface({ input: child.stderr });

  stdout.on('line', (line) => {
    try {
      lineHandler(JSON.parse(line));
    } catch (error) {
      onDiagnostic(`app-server stdout 不是 JSON：${error.message}`);
    }
  });
  stderr.on('line', onDiagnostic);
  child.on('error', (error) => exitHandler(error));
  child.on('exit', (code, signal) => {
    if (closed) return;
    exitHandler(new Error(`Codex app-server 已結束（code=${code}, signal=${signal || 'none'}）`));
  });

  return {
    onLine(handler) {
      lineHandler = handler;
    },
    onExit(handler) {
      exitHandler = handler;
    },
    send(message) {
      if (closed || child.stdin.destroyed) throw new Error('Codex app-server transport 已關閉');
      child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8');
    },
    close() {
      if (closed) return;
      closed = true;
      stdout.close();
      stderr.close();
      child.stdin.end();
      child.kill();
    },
  };
}

module.exports = { spawnCodexAppServer };
