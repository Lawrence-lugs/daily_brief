#!/usr/bin/env node
// Usage: node server/stop.js [--port 4873]
// Kills the daily-brief server listening on the given port.

import { execSync } from 'node:child_process';
import process from 'node:process';

const i = process.argv.indexOf('--port');
const port = Number(i > -1 ? process.argv[i + 1] : process.env.BRIEF_PORT ?? 4873);
const host = '127.0.0.1';

try {
  // Check if server is running
  const check = await fetch(`http://${host}:${port}/api/health`, { 
    signal: AbortSignal.timeout(800) 
  });
  const json = await check.json();
  if (json.name !== 'daily-brief') {
    console.log('No daily-brief server found on port', port);
    process.exit(0);
  }
} catch {
  console.log('No daily-brief server found on port', port);
  process.exit(0);
}

try {
  // Try graceful shutdown via API first
  const res = await fetch(`http://${host}:${port}/api/shutdown`, {
    method: 'POST',
    headers: { 'X-Brief-Client': '1' },
    signal: AbortSignal.timeout(2000),
  });
  if (res.ok) {
    console.log('Shutdown request sent, waiting for process to exit...');
    // Wait a bit for graceful exit
    await new Promise(r => setTimeout(r, 1000));
    process.exit(0);
  }
} catch {
  // API not available or failed, fall through to force kill
}

try {
  // Force kill by port (cross-platform)
  if (process.platform === 'win32') {
    const out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8', stdio: 'pipe' });
    const pids = [...out.matchAll(/\s+(\d+)\s*$/gm)].map(m => m[1]);
    for (const pid of new Set(pids)) {
      execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
      console.log(`Killed PID ${pid}`);
    }
  } else {
    execSync(`lsof -ti:${port} | xargs kill -9`, { stdio: 'ignore' });
    console.log(`Killed process(es) on port ${port}`);
  }
} catch {
  console.log('No process found to kill on port', port);
}