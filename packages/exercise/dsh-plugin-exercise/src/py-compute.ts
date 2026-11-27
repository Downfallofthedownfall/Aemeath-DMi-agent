// ============================================================
// py-compute.ts — 用**现有的** py-compute（packages/py-services/sympy_mcp/server.py）复算
//
// 不另写 Python：直接 import server.py，调它的 do_symbolic（= 工具 compute_symbolic）——
// 同一套防护：表达式在子进程里走 safe_parse（token 黑名单、空内建、≤500 字符、超时）。
// 送进去的表达式是 compute-expr.ts 从**解析树**生成的（只有数字、运算符和它符号表里的函数名），
// 不含模型原文。
//
// 为什么不用 do_numeric（compute_numeric）：它每次先预载 numpy + scipy（多一秒），而且要求装了
// scipy（mac 上常常只装了 sympy）；复算一个数，只要 sympy 的 do_symbolic 就够。
//
// 习题模式承诺"零 Python"（mac 上本来就只有课堂/习题两个 app）：没有 Python / 没装 sympy 时
// 这里返回 ok:false，计算照常（双精度），界面标"未经 SymPy 复算"。
// macOS 上**不碰** `/usr/bin/python3` 占位程序（没装命令行工具时它会弹"安装开发者工具"的窗口），
// 见 pythonCandidates。
// ============================================================

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import type { PyVerify } from './compute.js';

export interface PyComputeOptions {
  /** 显式 Python（空 = 自动找，见 pythonCandidates） */
  python?: string;
  /** 显式 server.py 路径（空 = 仓库里的 packages/py-services/sympy_mcp/server.py） */
  serverPath?: string;
  /** 找 server.py 的起点（进程 cwd、插件所在目录） */
  searchRoots: readonly string[];
  log?: (msg: string) => void;
}

const RUN_TIMEOUT_MS = 60_000;
/** 失败（没 Python / 没 sympy）缓存多久再重试：用户可能刚装好。 */
const FAIL_TTL_MS = 2 * 60_000;

/**
 * 读 stdin 的 {exprs:[…]}，并发跑 do_symbolic（每个各起一个沙箱子进程），回写 JSON 数组。
 * 先查 sympy 在不在（find_spec，不真导入）：没装 sympy 的解释器在这里就失败，换下一个候选
 * （而不是"能跑就选中"，结果选中一个没有 sympy 的 python3，旁边装了 sympy 的那个永远轮不到）。
 */
const LOADER = [
  'import sys, json, importlib.util',
  "if importlib.util.find_spec('sympy') is None:",
  "    sys.exit(\"ModuleNotFoundError: No module named 'sympy'\")",
  'from concurrent.futures import ThreadPoolExecutor',
  'sys.path.insert(0, sys.argv[1])',
  'import server',
  'req = json.loads(sys.stdin.read())',
  'def run(e):',
  '    try:',
  "        return server.do_symbolic(e, {}, req.get('timeout', 15))",
  '    except Exception as exc:',
  "        return {'success': False, 'error': str(exc)}",
  'with ThreadPoolExecutor(max_workers=4) as pool:',
  "    out = list(pool.map(run, req['exprs']))",
  'sys.stdout.write(json.dumps(out, ensure_ascii=False))',
].join('\n');

export function findPyComputeServer(opts: Pick<PyComputeOptions, 'serverPath' | 'searchRoots'>): string | null {
  const candidates = [
    opts.serverPath,
    ...opts.searchRoots.flatMap((r) => [
      join(r, 'packages/py-services/sympy_mcp/server.py'),
      join(r, '../../../py-services/sympy_mcp/server.py'), // 插件 lib/ → packages/py-services
      join(r, '../../py-services/sympy_mcp/server.py'),
    ]),
  ].filter((p): p is string => !!p);
  for (const p of candidates) {
    const abs = resolve(p);
    if (existsSync(abs)) return abs;
  }
  return null;
}

/** do_symbolic 的一条结果 → 数。`5.42494239600754` / `6.02e+23`；复数、符号残留都算失败。 */
export function readSymbolicResult(r: { success?: boolean; result_str?: string; type?: string; error?: string } | undefined):
  | { re: number; im: number }
  | { error: string } {
  if (!r) return { error: 'no output' };
  if (!r.success) return { error: lastLine(String(r.error || 'SymPy error')) };
  const v = Number(String(r.result_str ?? '').trim());
  if (r.type !== 'float' || !Number.isFinite(v)) return { error: `SymPy: ${String(r.result_str ?? '').slice(0, 80)}` };
  return { re: v, im: 0 };
}

/** 报错只留最后一行（traceback 的结论那一行），给界面看。 */
function lastLine(s: string): string {
  const lines = s.trim().split(/\r?\n/).filter((l) => l.trim());
  return (lines[lines.length - 1] ?? '').trim().slice(0, 300);
}

/** macOS 的 `/usr/bin/python3` 是占位程序：只有装了命令行工具 / Xcode 时才是真的 Python。 */
const MAC_STUB_DIRS = new Set(['/usr/bin', '/bin']);
const MAC_DEVELOPER_PYTHONS = [
  '/Library/Developer/CommandLineTools/usr/bin/python3',
  '/Applications/Xcode.app/Contents/Developer/usr/bin/python3',
];

/**
 * 依次要试的 Python。
 *   · 显式配置（`pythonCommand` / `EXERCISE_PYTHON`）→ 只用它
 *   · Windows → python、python3、py -3（`python` 可能是应用商店占位程序，会自然失败换下一个）
 *   · macOS → 绝对路径：PATH 里的、Homebrew（/opt/homebrew、/usr/local）、python.org 安装包、
 *     MacPorts、pyenv；`/usr/bin/python3` 排最后，且**只在装了命令行工具时**才试 ——
 *     从 Finder 启动的进程 PATH 很短，不这样做就找不到 Homebrew 的 python，或者弹出安装窗口
 *   · 其它（Linux）→ python3、python
 */
export function pythonCandidates(input: {
  explicit?: string;
  platform: string;
  pathEnv?: string;
  home?: string;
  exists: (p: string) => boolean;
}): Array<{ cmd: string; args: string[] }> {
  if (input.explicit?.trim()) {
    const [cmd, ...args] = input.explicit.trim().split(/\s+/);
    return [{ cmd: cmd!, args }];
  }
  if (input.platform === 'win32') {
    return [
      { cmd: 'python', args: [] },
      { cmd: 'python3', args: [] },
      { cmd: 'py', args: ['-3'] },
    ];
  }
  if (input.platform !== 'darwin') {
    return [
      { cmd: 'python3', args: [] },
      { cmd: 'python', args: [] },
    ];
  }
  const fromPath = (input.pathEnv ?? '').split(':').filter((d) => d && !MAC_STUB_DIRS.has(d));
  const dirs = [
    ...fromPath,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/Library/Frameworks/Python.framework/Versions/Current/bin',
    '/opt/local/bin',
    ...(input.home ? [posix.join(input.home, '.pyenv/shims')] : []),
  ];
  const out: Array<{ cmd: string; args: string[] }> = [];
  const seen = new Set<string>();
  const add = (p: string): void => {
    if (!seen.has(p) && input.exists(p)) {
      seen.add(p);
      out.push({ cmd: p, args: [] });
    }
  };
  for (const d of dirs) for (const name of ['python3', 'python']) add(posix.join(d, name));
  if (MAC_DEVELOPER_PYTHONS.some((p) => input.exists(p))) add('/usr/bin/python3');
  return out;
}

function runPython(
  python: { cmd: string; args: string[] },
  serverDir: string,
  input: string,
): Promise<{ code: number | null; stdout: string; stderr: string; spawnError?: string }> {
  return new Promise((resolvePromise) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const done = (r: { code: number | null; stdout: string; stderr: string; spawnError?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(r);
    };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(python.cmd, [...python.args, '-c', LOADER, serverDir], {
        cwd: serverDir,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        windowsHide: true,
      });
    } catch (e) {
      // 同步抛错：例如 Windows 上把 pythonCommand 配成 .cmd/.bat（Node 不经 shell 不肯启动，EINVAL）
      resolvePromise({ code: null, stdout: '', stderr: '', spawnError: (e as NodeJS.ErrnoException).code ?? String(e) });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      done({ code: null, stdout, stderr, spawnError: 'timeout' });
    }, RUN_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      if (stdout.length < 1_000_000) stdout += d;
    });
    child.stderr.on('data', (d: string) => {
      if (stderr.length < 64_000) stderr += d;
    });
    child.on('error', (e: NodeJS.ErrnoException) => done({ code: null, stdout, stderr, spawnError: e.code ?? e.message }));
    child.on('close', (code) => done({ code, stdout, stderr }));
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

/**
 * 造一个复算器。Python 命令找到一次就记住；失败（没 Python / 依赖不全）记 2 分钟再试。
 */
export function createPyVerify(opts: PyComputeOptions): PyVerify {
  let chosen: { cmd: string; args: string[] } | null = null;
  let failure: { at: number; error: string } | null = null;

  const candidates = (): Array<{ cmd: string; args: string[] }> =>
    pythonCandidates({
      explicit: opts.python,
      platform: process.platform,
      pathEnv: process.env.PATH,
      home: homedir(),
      exists: existsSync,
    });

  return async (jobs) => {
    if (!jobs.length) return { ok: true, results: new Map() };
    if (failure && Date.now() - failure.at < FAIL_TTL_MS) return { ok: false, error: failure.error };
    const server = findPyComputeServer(opts);
    if (!server) {
      failure = { at: Date.now(), error: 'py-compute (packages/py-services/sympy_mcp/server.py) not found' };
      return { ok: false, error: failure.error };
    }
    const serverDir = dirname(server);
    const input = JSON.stringify({ exprs: jobs.map((j) => j.code), timeout: 15 });

    // 一个个试：Windows 上 `python` 可能是应用商店的占位程序（能启动、但不是 Python）；
    // 任何一个解释器没装 sympy（LOADER 第一行就失败）也换下一个
    type SymbolicOut = { success?: boolean; result_str?: string; type?: string; error?: string };
    let parsed: SymbolicOut[] | null = null;
    let firstError = '';
    for (const py of chosen ? [chosen] : candidates()) {
      const r = await runPython(py, serverDir, input);
      if (r.spawnError === 'ENOENT') continue;
      if (r.spawnError) {
        firstError ||= `python ${r.spawnError}`;
        continue;
      }
      try {
        const out = JSON.parse(r.stdout) as unknown;
        if (!Array.isArray(out)) throw new Error('not an array');
        parsed = out as SymbolicOut[];
      } catch {
        firstError ||= lastLine(r.stderr || r.stdout) || `python exited ${r.code}`;
        continue;
      }
      if (!chosen) opts.log?.(`py-compute：${[py.cmd, ...py.args].join(' ')} · ${server}`);
      chosen = py;
      break;
    }
    if (!parsed) {
      failure = { at: Date.now(), error: firstError || 'Python not found' };
      return { ok: false, error: failure.error };
    }

    const results = new Map<string, { re: number; im: number } | { error: string }>();
    jobs.forEach((job, i) => results.set(job.id, readSymbolicResult(parsed![i])));
    // 子进程里连 sympy 都起不来：当成"复算不可用"，别把每一处都标成不一致
    const broken = [...results.values()].find(
      (r): r is { error: string } => 'error' in r && /No module named|ModuleNotFoundError|ImportError/.test(r.error),
    );
    if (broken) {
      failure = { at: Date.now(), error: broken.error };
      return { ok: false, error: broken.error };
    }
    failure = null;
    return { ok: true, results };
  };
}
