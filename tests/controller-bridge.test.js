const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');

// Windows CI exercises the real P/Invoke bridge, even with no physical controller.
test('Windows controller bridge emits native samples and exits when the parent pipe closes', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
    const script = path.join(__dirname, '..', 'scripts', 'controller-input.ps1');
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
        windowsHide: true, env: { ...process.env, TRACKHUNTER_OWNER_PID: String(process.pid) },
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let buffer = '';
    let stderr = '';
    let ready = false;
    let sample = null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exit = new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', code => resolve(code));
    });
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Controller bridge produced no state: ${stderr}`)), 20000);
        child.on('error', error => { clearTimeout(timeout); reject(error); });
        child.on('exit', code => {
            if (!sample) { clearTimeout(timeout); reject(new Error(`Bridge exited early (${code}): ${stderr}`)); }
        });
        child.stdout.on('data', chunk => {
            buffer += chunk;
            let newline;
            while ((newline = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, newline).trim();
                buffer = buffer.slice(newline + 1);
                try {
                    const data = JSON.parse(line);
                    if (data.type === 'ready') ready = true;
                    if (data.type === 'state' && !sample) {
                        sample = data;
                        clearTimeout(timeout);
                        resolve();
                    }
                } catch (error) { clearTimeout(timeout); reject(new Error(`Invalid bridge output: ${line}`)); }
            }
        });
    });
    assert.equal(ready, true);
    assert.equal(typeof sample.connected, 'boolean');
    assert.equal(typeof sample.gameForeground, 'boolean');
    assert.ok(Number.isInteger(sample.buttons));
    assert.ok(Number.isInteger(sample.bounds.width));
    child.stdin.end();
    assert.equal(await exit, 0, stderr);
    assert.equal(stderr, '');
});
