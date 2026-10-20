// ============================================================
// pdf-render.ts — 提交 PDF 的宿主机侧：找浏览器 → 打印 → 合并原卷
//
// 设计依据：docs/exercise-mode-plan.md D6
//   · 提交物 = 原卷 + 解答合成的**一个** PDF（助教只收一个文件）
//   · 零 Python：渲染走**本机已装的 Chromium 家族浏览器**的 `--print-to-pdf`
//     （Edge 在 Windows 上默认就有，用户不用额外装任何东西）
//
// 为什么用 CLI 而不是 puppeteer/playwright：
//   · 那两个都会拖一个几百 MB 的浏览器内核进仓库，且和"用户自己的浏览器"版本脱节
//   · `--headless=new --print-to-pdf` 足够打印一张 A4 页面，且没有 CDP 依赖
//
// 两条平台纪律（真机踩过）：
//   1) **永远用 args 数组 + windowsHide，绝不 shell:true**：本仓库路径含中文
//      （`桌面\Aemeath-DMi-agent`），拼 shell 字符串在 Windows 上会因引号/空格/编码
//      撕裂成两个参数，表现为"浏览器启动了但没生成 PDF"。
//   2) **超时必杀**：headless Chromium 偶发卡在等网络（本机 HTTP 端点没起来、
//      MathLive/字体请求挂住）。不杀就会永久挂住整个导出流程。
//
// 失败一律返回 `{ ok:false, error }`，不抛异常 —— 导出是用户点按钮触发的，
// 抛异常会把整条命令链打断，用户看不到"为什么没出 PDF"。
// ============================================================

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { PDFDocument } from 'pdf-lib';

// ============================================================
// 常量
// ============================================================

const DEFAULT_TIMEOUT_MS = 90_000;

/** 小于这个字节数的一定不是有效 PDF（空白页也有 400+ B，1 KB 是安全下限）。 */
const MIN_PDF_BYTES = 1024;

// ============================================================
// 类型
// ============================================================

export interface ChromiumInfo {
  /** 可执行文件绝对路径 */
  path: string;
  /** 人类可读的名字（写进 RenderResult.renderer，便于用户确认用的是哪个浏览器） */
  name: string;
}

export interface RenderOptions {
  /** 要打印的 URL（我们的本机 HTTP 端点；也可以是 file://） */
  url: string;
  /** 输出 PDF 绝对路径 */
  outPdf: string;
  /** 原卷 PDF 绝对路径（可选；存在则合并） */
  sheetPdf?: string;
  /** 合并顺序，默认 'sheet-first' */
  order?: 'sheet-first' | 'solutions-first';
  chromePath?: string;
  timeoutMs?: number;
  /** 额外传给浏览器的参数（测试用） */
  extraArgs?: string[];
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export interface RenderResult {
  ok: boolean;
  pdfPath?: string;
  bytes?: number;
  pages?: number;
  renderer?: string;
  merged: boolean;
  error?: string;
  /** 生成命令（便于用户自查/手动重跑） */
  command?: string;
}

interface Candidate {
  path: string;
  name: string;
}

// ============================================================
// 小工具
// ============================================================

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 只有"存在 + 是文件 +（非 Windows）可执行"才算候选。 */
function isExecutableFile(p: string): boolean {
  if (!p) return false;
  try {
    const st = statSync(p);
    if (!st.isFile()) return false;
    // Windows 没有 Unix 执行位概念，存在即视为可执行。
    if (process.platform !== 'win32') return (st.mode & 0o111) !== 0;
    return true;
  } catch {
    return false;
  }
}

/** PATH 里逐个目录拼候选（Windows 上顺便找 chrome.exe / msedge.exe）。 */
function pathCandidates(names: readonly { file: string; name: string }[]): Candidate[] {
  const out: Candidate[] = [];
  const dirs = (process.env.PATH ?? '').split(delimiter).filter((d) => d.length > 0);
  for (const dir of dirs) {
    for (const n of names) out.push({ path: join(dir, n.file), name: n.name });
  }
  return out;
}

// ============================================================
// 平台候选表
//
// 顺序有讲究：Edge 排在 Chrome 前面（Windows 自带 Edge，命中率最高，
// "零安装"是硬指标），其余按常见程度排。
// ============================================================

function windowsCandidates(): Candidate[] {
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] ?? pf;
  const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');

  return [
    { path: join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), name: 'Microsoft Edge' },
    { path: join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), name: 'Microsoft Edge' },
    { path: join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), name: 'Google Chrome' },
    { path: join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'), name: 'Google Chrome' },
    { path: join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'), name: 'Google Chrome' },
    { path: join(local, 'Chromium', 'Application', 'chrome.exe'), name: 'Chromium' },
    { path: join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), name: 'Microsoft Edge' },
    { path: join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), name: 'Brave' },
  ];
}

function macCandidates(): Candidate[] {
  const roots = ['/Applications', join(homedir(), 'Applications')];
  const bundles: readonly Candidate[] = [
    { path: 'Google Chrome.app/Contents/MacOS/Google Chrome', name: 'Google Chrome' },
    { path: 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge', name: 'Microsoft Edge' },
    { path: 'Chromium.app/Contents/MacOS/Chromium', name: 'Chromium' },
    { path: 'Brave Browser.app/Contents/MacOS/Brave Browser', name: 'Brave' },
  ];
  const out: Candidate[] = [];
  for (const root of roots) {
    for (const b of bundles) out.push({ path: join(root, b.path), name: b.name });
  }
  return out;
}

function unixNames(): { file: string; name: string }[] {
  return [
    { file: 'google-chrome', name: 'Google Chrome' },
    { file: 'google-chrome-stable', name: 'Google Chrome' },
    { file: 'chromium', name: 'Chromium' },
    { file: 'chromium-browser', name: 'Chromium' },
    { file: 'microsoft-edge', name: 'Microsoft Edge' },
    { file: 'microsoft-edge-stable', name: 'Microsoft Edge' },
  ];
}

/**
 * 找本机的 Chromium 家族浏览器。
 *
 * 优先级：
 *   1. `AEMEATH_CHROME` 环境变量（换机器 / 绿色版 / 自定义安装路径的唯一出口）
 *   2. `extraPaths`（调用方显式指定；测试也走这里）
 *   3. 平台默认安装路径
 *   4. PATH 兜底（Linux 主战场；Windows/mac 顺带也能命中）
 *
 * 找不到返回 null（**不抛**）：调用方据此给出"请装 Edge/Chrome"的提示。
 */
export function findChromium(extraPaths?: string[]): ChromiumInfo | null {
  const candidates: Candidate[] = [];

  const envPath = (process.env.AEMEATH_CHROME ?? '').trim();
  if (envPath) candidates.push({ path: envPath, name: 'AEMEATH_CHROME' });

  for (const p of extraPaths ?? []) {
    if (typeof p === 'string' && p.trim()) candidates.push({ path: p.trim(), name: 'extraPath' });
  }

  if (process.platform === 'win32') {
    candidates.push(...windowsCandidates());
    candidates.push(
      ...pathCandidates([
        { file: 'chrome.exe', name: 'Google Chrome' },
        { file: 'msedge.exe', name: 'Microsoft Edge' },
      ]),
    );
  } else if (process.platform === 'darwin') {
    candidates.push(...macCandidates());
    candidates.push(...pathCandidates(unixNames()));
  } else {
    candidates.push(...pathCandidates(unixNames()));
  }

  for (const c of candidates) {
    if (isExecutableFile(c.path)) return { path: c.path, name: c.name };
  }
  return null;
}

// ============================================================
// PDF 基础操作（pdf-lib：纯 JS，零 Python）
// ============================================================

/** 能被人肉复制的命令行形式（仅用于展示/自查，不参与实际执行）。 */
function quoteArg(a: string): string {
  return /[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

function displayCommand(bin: string, args: readonly string[]): string {
  return [bin, ...args].map(quoteArg).join(' ');
}

/** 确保目录存在（导出路径常常是"还不存在的 sheet 目录"）。 */
function ensureDir(dir: string): void {
  if (!dir) return;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** 合并若干个 PDF，**保持每页原始尺寸**（原卷常是 A4，解答也是 A4，但不假设）。 */
export async function mergePdfs(parts: string[], outPdf: string): Promise<{ pages: number; bytes: number }> {
  if (!Array.isArray(parts) || parts.length === 0) {
    // 这是调用方的编程错误（没有任何输入却要合并）→ 明确抛，不静默产出空 PDF
    throw new Error('mergePdfs：至少需要一个 PDF 文件');
  }

  const out = await PDFDocument.create();
  for (const part of parts) {
    const bytes = await readFile(part);
    // ignoreEncryption：大学教务/扫描件常带"禁止编辑"的加密标记。
    // pdf-lib 能读出页面并复制（我们只读不写原文件），比直接失败有用得多。
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    // copyPages 会把页面的 MediaBox / Resources / 旋转一并带过来，
    // 因此不需要手动 setSize —— 手动设尺寸反而会在原卷非 A4 时裁掉内容。
    const copied = await out.copyPages(src, src.getPageIndices());
    for (const page of copied) out.addPage(page);
  }

  const data = await out.save({ useObjectStreams: false }); // 最大兼容性（老阅读器/教务系统）
  const absOut = resolve(outPdf);
  ensureDir(dirname(absOut));
  await writeFile(absOut, data);
  return { pages: out.getPageCount(), bytes: data.byteLength };
}

/** 数页数（也用来验证"打出来的是不是有效 PDF"）。 */
export async function countPdfPages(file: string): Promise<number> {
  const bytes = await readFile(file);
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  return doc.getPageCount();
}

// ============================================================
// 渲染主流程
// ============================================================

function chromiumArgs(printTarget: string, url: string, extraArgs?: string[]): string[] {
  return [
    '--headless=new',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    // 我们自己排页眉页脚（且页眉带 URL/日期会污染提交件）
    '--no-pdf-header-footer',
    `--print-to-pdf=${printTarget}`,
    // 旧版 flag：有的 Edge/Chrome 只认这个拼写，两个都给最稳
    '--print-to-pdf-no-header',
    // 给本机页面留足时间：KaTeX 字体是内联的，但截图/排版仍需时间
    '--virtual-time-budget=15000',
    ...(extraArgs ?? []),
    url,
  ];
}

export async function renderSubmissionPdf(opts: RenderOptions): Promise<RenderResult> {
  const log = opts.log ?? ((): void => {});
  const warn = opts.warn ?? ((m: string): void => console.warn(m));
  const timeoutMs =
    typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const order = opts.order === 'solutions-first' ? 'solutions-first' : 'sheet-first';

  const outAbs = resolve(opts.outPdf);
  const sheetAbs = opts.sheetPdf ? resolve(opts.sheetPdf) : '';
  const hasSheet = sheetAbs.length > 0 && existsSync(sheetAbs);
  if (sheetAbs && !hasSheet) {
    warn(`[aemeath-exercise] 原卷 PDF 不存在，改为只输出解答：${sheetAbs}`);
  }

  // 需要合并时先打到中间文件：直接打到 outAbs 再读回来合并，会在 save 时
  // 覆盖掉正要读的输入（而且是同一个路径 → 读到空文件）。
  const printTarget = hasSheet ? `${outAbs}.solutions.pdf` : outAbs;

  try {
    ensureDir(dirname(outAbs));

    // === 1) 定位浏览器 ===
    let chrome: ChromiumInfo | null = null;
    if (opts.chromePath) {
      if (isExecutableFile(opts.chromePath)) chrome = { path: opts.chromePath, name: 'chromePath' };
      else {
        return {
          ok: false,
          merged: false,
          error: `chromePath 不是可执行文件：${opts.chromePath}`,
        };
      }
    } else {
      chrome = findChromium();
    }
    if (!chrome) {
      return {
        ok: false,
        merged: false,
        error: '未找到 Chromium 内核浏览器（Chrome / Edge / Chromium）。请安装其一，或用 AEMEATH_CHROME 指定可执行文件路径。',
      };
    }

    const args = chromiumArgs(printTarget, opts.url, opts.extraArgs);
    const command = displayCommand(chrome.path, args);

    // 清掉上一轮的中间产物：Chromium 写失败时会**保留旧文件**，
    // 不清掉就会把上次的 PDF 当成这次的结果提交上去（静默错文件，最坏的一种 bug）。
    if (printTarget !== outAbs) {
      try {
        unlinkSync(printTarget);
      } catch {
        /* 不存在就算了 */
      }
    }

    log(`[aemeath-exercise] 渲染提交 PDF：${command}`);

    // === 2) 打印 ===
    let timedOut = false;
    let spawnError: Error | null = null;
    let stderr = '';

    // stdio：stdout 忽略（headless 模式下是空的），stderr 收着用于失败诊断。
    // 不用 shell:true —— 路径含空格/中文时 shell 会把参数撕裂。
    const child = spawn(chrome.path, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env },
    });

    const exitCode = await new Promise<number | null>((done) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let hardStop: ReturnType<typeof setTimeout> | null = null;

      // settle 保证只结算一次并清掉两级定时器：
      // 某些 Windows 场景下 kill() 之后 'close' 仍可能不来（进程卡在驱动层），
      // 没有第二级兜底就会永久挂住整个导出。
      const settle = (code: number | null): void => {
        if (timer) clearTimeout(timer);
        if (hardStop) clearTimeout(hardStop);
        done(code);
      };

      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill();
        } catch {
          /* 进程可能已经退了 */
        }
        hardStop = setTimeout(() => settle(null), 2000);
      }, timeoutMs);

      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < 8000) stderr += chunk.toString();
      });
      child.once('error', (err) => {
        spawnError = err;
        settle(null);
      });
      // 'close' 而不是 'exit'：等 stdio 也关掉，否则可能读到写了一半的文件
      child.once('close', (code) => settle(code));
    });

    if (spawnError) {
      const e = spawnError as Error;
      return { ok: false, merged: false, renderer: chrome.name, command, error: `浏览器启动失败：${e.message}` };
    }
    if (timedOut) {
      return {
        ok: false,
        merged: false,
        renderer: chrome.name,
        command,
        error: `浏览器渲染超时（${timeoutMs}ms），已终止。可检查页面 URL 是否可达，或调大 timeoutMs。`,
      };
    }
    if (exitCode !== 0) {
      return {
        ok: false,
        merged: false,
        renderer: chrome.name,
        command,
        error: `浏览器退出码 ${exitCode}${stderr.trim() ? `：${stderr.trim()}` : ''}`,
      };
    }

    // === 3) 验证产物（"退出码 0 但没文件"在 Windows 上真实存在） ===
    if (!existsSync(printTarget)) {
      return {
        ok: false,
        merged: false,
        renderer: chrome.name,
        command,
        error: `浏览器退出码 0，但没有生成 PDF：${printTarget}${stderr.trim() ? `（stderr：${stderr.trim()}）` : ''}`,
      };
    }

    const rawSize = statSync(printTarget).size;
    if (rawSize < MIN_PDF_BYTES) {
      try {
        unlinkSync(printTarget); // 半成品留着只会让下一次误判为成功
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        merged: false,
        renderer: chrome.name,
        command,
        error: `输出文件过小（${rawSize} B < ${MIN_PDF_BYTES} B），不是有效 PDF。${stderr.trim() ? `（stderr：${stderr.trim()}）` : ''}`,
      };
    }

    let pages: number;
    try {
      pages = await countPdfPages(printTarget);
    } catch (err) {
      return {
        ok: false,
        merged: false,
        pdfPath: printTarget,
        bytes: rawSize,
        renderer: chrome.name,
        command,
        error: `输出不是可解析的 PDF：${errText(err)}`,
      };
    }

    // === 4) 合并原卷（原卷在前：助教先看题目） ===
    let merged = false;
    let finalPages = pages;
    let finalBytes = rawSize;

    if (hasSheet) {
      const parts = order === 'sheet-first' ? [sheetAbs, printTarget] : [printTarget, sheetAbs];
      try {
        const res = await mergePdfs(parts, outAbs);
        merged = true;
        finalPages = res.pages;
        finalBytes = res.bytes;
      } catch (err) {
        // 合并失败时**保留**解答 PDF：用户手上有可用产物，比只剩一句报错有用。
        return {
          ok: false,
          merged: false,
          pdfPath: printTarget,
          bytes: rawSize,
          pages,
          renderer: chrome.name,
          command,
          error: `合并原卷失败：${errText(err)}（解答 PDF 已保留在 ${printTarget}）`,
        };
      }

      try {
        unlinkSync(printTarget);
      } catch (err) {
        warn(`[aemeath-exercise] 中间文件删除失败（不影响结果）：${printTarget}：${errText(err)}`);
      }
    }

    log(`[aemeath-exercise] 提交 PDF 完成：${outAbs}（${finalPages} 页 / ${finalBytes} B，${merged ? '已合并原卷' : '仅解答'}）`);

    return {
      ok: true,
      pdfPath: outAbs,
      bytes: finalBytes,
      pages: finalPages,
      renderer: chrome.name,
      merged,
      command,
    };
  } catch (err) {
    // 预期外异常（权限、磁盘满、pdf-lib 内部错）也转成结果对象：
    // 导出按钮必须能显示"为什么失败"，而不是让调用栈冒到 UI。
    return { ok: false, merged: false, error: errText(err) };
  }
}
