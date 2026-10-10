// selftest.mjs —— @local/mcp-rea 自检：握手 / 工具面体积 / 真跑一次 REA / 逃生舱校验
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url));
const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const rl = createInterface({ input: child.stdout });
const pending = new Map();
rl.on('line', (l) => { let m; try { m = JSON.parse(l); } catch { return; } if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
child.stderr.on('data', (d) => process.stderr.write('[srv] ' + String(d).slice(0, 200)));

let seq = 0;
const call = (method, params, timeoutMs = 180000) => new Promise((resolve, reject) => {
  const id = ++seq;
  const t = setTimeout(() => reject(new Error(method + ' 超时')), timeoutMs);
  pending.set(id, (m) => { clearTimeout(t); resolve(m); });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});

const results = [];
const log = (name, ok, detail) => { results.push({ name, ok }); console.log((ok ? '  ✓ ' : '  ✗ ') + name + '  ' + detail); };
const skip = (name, detail) => { results.push({ name, ok: true, skipped: true }); console.log('  — SKIP ' + name + '  ' + detail); };

try {
  const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'selftest', version: '0' } }, 15000);
  log('initialize', init.result?.serverInfo?.name === 'rea-shim', JSON.stringify(init.result?.serverInfo));

  const tools = await call('tools/list', {}, 15000);
  const list = tools.result?.tools ?? [];
  const bytes = Buffer.byteLength(JSON.stringify(list), 'utf8');
  log('工具面精简', list.length >= 21 && list.length <= 24 && bytes < 24576, list.length + ' 个工具 / ' + (bytes / 1024).toFixed(1) + ' KB schema');
  log('工具命名规范', list.every((t) => /^[a-z][a-z0-9_]*$/.test(t.name)), list.map((t) => t.name).join(','));

  // REA 后端可用性：REA_ENTRY 指向 rea.mjs，或 PATH 上有 rea CLI；都没有时"真跑"用例 SKIP（不伪装成通过）
  const reaAvailable = Boolean(process.env.REA_ENTRY) || (() => { try { return execFileSync(process.platform === 'win32' ? 'where' : 'which', ['rea'], { stdio: 'pipe' }).length > 0; } catch { return false; } })();

  if (reaAvailable) {
    const cap = await call('tools/call', { name: 'rea_capabilities', arguments: {} });
    const capText = cap.result?.content?.[0]?.text ?? '';
    log('真跑 REA（capabilities）', capText.length > 20 && /exit=0/.test(capText), capText.slice(0, 80).replace(/\n/g, ' '));
  } else {
    skip('真跑 REA（capabilities）', '未配置 REA_ENTRY 且 PATH 无 rea——环境不含后端');
  }

  const bad = await call('tools/call', { name: 'rea_cli', arguments: { command: 'bad name!' } });
  log('逃生舱校验（拒非法命令）', bad.result?.isError === true, String(bad.result?.content?.[0]?.text).slice(0, 60));

  // 逃生舱必须「全量可达」：① 参数原样透传（--token-limit 生效 → 输出变短）；② 显式 --format 覆盖默认 json。
  if (reaAvailable) {
    const full = await call('tools/call', { name: 'rea_capabilities', arguments: {} });
    const capped = await call('tools/call', { name: 'rea_cli', arguments: { command: 'capabilities', args: ['--token-limit', '300'] } });
    const fullText = full.result?.content?.[0]?.text ?? '';
    const capText2 = capped.result?.content?.[0]?.text ?? '';
    log('逃生舱透传参数（--token-limit 生效）', capText2.length > 0 && capText2.length < fullText.length, `full=${fullText.length}B vs capped=${capText2.length}B`);
    const mdRun = await call('tools/call', { name: 'rea_cli', arguments: { command: 'capabilities', args: ['--format', 'md', '--token-limit', '200'] } });
    const mdText = mdRun.result?.content?.[0]?.text ?? '';
    log('逃生舱可覆盖 --format', mdText.length > 0 && !mdText.trimStart().startsWith('{'), mdText.slice(0, 60).replace(/\n/g, ' '));
  } else {
    skip('逃生舱透传参数（--token-limit 生效）', '环境不含 REA 后端');
    skip('逃生舱可覆盖 --format', '环境不含 REA 后端');
  }

  const unknown = await call('nosuch/method', {});
  log('未实现方法报错', unknown.error?.code === -32601, JSON.stringify(unknown.error));

  // —— 加固回归（2026-10-10，与 akasha core/mcp.mjs 同族）：畸形但"合法 JSON"的各种形状 ——
  // 必须回 JSON-RPC 错误（-32600 / -32700）且**不得**让桥死（修前会在解构处抛错 → 未处理拒绝 → 进程终结）。
  {
    const seen = [];
    const rawLine = (s) => { child.stdin.write(s + '\n'); };
    const collector = (m) => { if (m?.error) seen.push(m.error.code); };
    // 临时挂一个收集器：用独立 id 通道不易，直接监听 rl 已有分发之外的原始行
    const onLine = (l) => { try { const m = JSON.parse(l); if (m?.error) seen.push(m.error.code); } catch { /* ignore */ } };
    rl.on('line', onLine);
    rawLine('null'); rawLine('123'); rawLine('"str"'); rawLine('[]'); rawLine('{}'); rawLine('{ bad json }');
    await new Promise((r) => setTimeout(r, 900));
    rl.off('line', onLine);
    log('畸形形状回错误（6 种）', seen.filter((c) => c === -32600 || c === -32700).length >= 6, '错误码=' + seen.join(','));
    const alive = await call('tools/list', {}, 15000);
    log('畸形输入后仍存活', (alive.result?.tools?.length ?? 0) >= 21, (alive.result?.tools?.length ?? 0) + ' 个工具');
  }
} catch (e) {
  log('异常', false, String(e?.message ?? e));
} finally {
  try { child.kill(); } catch { /* ignore */ }
}
const pass = results.every((r) => r.ok);
console.log('\n=== ' + (pass ? 'PASS' : 'FAIL') + ' === ' + results.filter((r) => r.ok).length + '/' + results.length);
process.exit(pass ? 0 : 1);
