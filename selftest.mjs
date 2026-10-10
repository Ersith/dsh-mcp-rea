// selftest.mjs —— @local/mcp-rea 自检：握手 / 工具面体积 / 真跑一次 REA / 逃生舱校验
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
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

try {
  const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'selftest', version: '0' } }, 15000);
  log('initialize', init.result?.serverInfo?.name === 'rea-shim', JSON.stringify(init.result?.serverInfo));

  const tools = await call('tools/list', {}, 15000);
  const list = tools.result?.tools ?? [];
  const bytes = Buffer.byteLength(JSON.stringify(list), 'utf8');
  log('工具面精简', list.length >= 21 && list.length <= 24 && bytes < 24576, list.length + ' 个工具 / ' + (bytes / 1024).toFixed(1) + ' KB schema');
  log('工具命名规范', list.every((t) => /^[a-z][a-z0-9_]*$/.test(t.name)), list.map((t) => t.name).join(','));

  const cap = await call('tools/call', { name: 'rea_capabilities', arguments: {} });
  const capText = cap.result?.content?.[0]?.text ?? '';
  log('真跑 REA（capabilities）', capText.length > 20 && /exit=0/.test(capText), capText.slice(0, 80).replace(/\n/g, ' '));

  const bad = await call('tools/call', { name: 'rea_cli', arguments: { command: 'bad name!' } });
  log('逃生舱校验（拒非法命令）', bad.result?.isError === true, String(bad.result?.content?.[0]?.text).slice(0, 60));

  // 逃生舱必须「全量可达」：① 参数原样透传（--token-limit 生效 → 输出变短）；② 显式 --format 覆盖默认 json。
  const full = await call('tools/call', { name: 'rea_capabilities', arguments: {} });
  const capped = await call('tools/call', { name: 'rea_cli', arguments: { command: 'capabilities', args: ['--token-limit', '300'] } });
  const fullText = full.result?.content?.[0]?.text ?? '';
  const capText2 = capped.result?.content?.[0]?.text ?? '';
  log('逃生舱透传参数（--token-limit 生效）', capText2.length > 0 && capText2.length < fullText.length, `full=${fullText.length}B vs capped=${capText2.length}B`);
  const mdRun = await call('tools/call', { name: 'rea_cli', arguments: { command: 'capabilities', args: ['--format', 'md', '--token-limit', '200'] } });
  const mdText = mdRun.result?.content?.[0]?.text ?? '';
  log('逃生舱可覆盖 --format', mdText.length > 0 && !mdText.trimStart().startsWith('{'), mdText.slice(0, 60).replace(/\n/g, ' '));

  const unknown = await call('nosuch/method', {});
  log('未实现方法报错', unknown.error?.code === -32601, JSON.stringify(unknown.error));
} catch (e) {
  log('异常', false, String(e?.message ?? e));
} finally {
  try { child.kill(); } catch { /* ignore */ }
}
const pass = results.every((r) => r.ok);
console.log('\n=== ' + (pass ? 'PASS' : 'FAIL') + ' === ' + results.filter((r) => r.ok).length + '/' + results.length);
process.exit(pass ? 0 : 1);
