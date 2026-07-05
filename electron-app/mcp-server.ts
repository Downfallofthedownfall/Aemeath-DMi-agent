import { FastMCP } from "fastmcp";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import os from "os";

// 创建 FastMCP 服务器
const server = new FastMCP({
  name: "Filesystem Server (TypeScript)",
  version: "1.0.0",
});

// ---------- 辅助函数 ----------
function getDefaultPath(): string {
  // Windows 桌面路径
  return path.join(os.homedir(), "Desktop");
}

// 安全获取文件大小，避免权限错误
async function safeGetSize(filePath: string): Promise<number | null> {
  try {
    const stat = await fs.stat(filePath);
    return stat.size;
  } catch {
    return null;
  }
}

// ---------- 工具1: list_files ----------
server.addTool({
  name: "list_files",
  description: "列出指定目录中的文件和文件夹",
  parameters: z.object({
    path: z.string().optional().describe("目录路径，默认为桌面"),
  }),
  execute: async (args) => {
    const targetPath = args.path || getDefaultPath();
    try {
      const items = await fs.readdir(targetPath);
      const dirs: string[] = [];
      const files: string[] = [];

      for (const item of items) {
        const fullPath = path.join(targetPath, item);
        try {
          const stat = await fs.stat(fullPath);
          if (stat.isDirectory()) {
            dirs.push(item);
          } else {
            const size = await safeGetSize(fullPath);
            files.push(`${item} (${size !== null ? size + " 字节" : "大小未知"})`);
          }
        } catch (err) {
          // 权限问题：标记为无法访问
          dirs.push(`${item} (系统保护，无法读取详情)`);
        }
      }

      const result = [
        `目录：${targetPath}`,
        "",
        "文件夹：",
        ...dirs.map(d => "  " + d),
        "",
        "文件：",
        ...files.map(f => "  " + f),
      ].join("\n");
      return result;
    } catch (err: any) {
      return `错误：${err.message || err}`;
    }
  },
});

// ---------- 工具2: read_file ----------
server.addTool({
  name: "read_file",
  description: "读取文件内容",
  parameters: z.object({
    path: z.string().describe("文件完整路径"),
  }),
  execute: async (args) => {
    try {
      const content = await fs.readFile(args.path, "utf-8");
      return `文件：${args.path}\n\n${content}`;
    } catch (err: any) {
      return `错误：${err.message || err}`;
    }
  },
});

// ---------- 工具3: write_file ----------
server.addTool({
  name: "write_file",
  description: "写入文件内容",
  parameters: z.object({
    path: z.string().describe("文件完整路径"),
    content: z.string().describe("要写入的内容"),
  }),
  execute: async (args) => {
    try {
      // 确保目录存在
      const dir = path.dirname(args.path);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(args.path, args.content, "utf-8");
      return `已写入文件：${args.path}（${args.content.length} 字符）`;
    } catch (err: any) {
      return `错误：${err.message || err}`;
    }
  },
});

// ---------- 工具4: search_files ----------
server.addTool({
  name: "search_files",
  description: "按文件名搜索文件",
  parameters: z.object({
    keyword: z.string().describe("搜索关键词"),
    path: z.string().optional().describe("搜索起始目录，默认为桌面"),
  }),
  execute: async (args) => {
    const targetPath = args.path || getDefaultPath();
    const keyword = args.keyword;
    if (!keyword) return "错误：缺少搜索关键词";

    const results: string[] = [];
    const maxDepth = 5;

    async function walk(dir: string, depth: number) {
      if (depth > maxDepth) return;
      try {
        const items = await fs.readdir(dir);
        for (const item of items) {
          const fullPath = path.join(dir, item);
          try {
            const stat = await fs.stat(fullPath);
            if (stat.isDirectory()) {
              await walk(fullPath, depth + 1);
            } else {
              if (item.toLowerCase().includes(keyword.toLowerCase())) {
                const size = await safeGetSize(fullPath);
                results.push(`${fullPath} (${size !== null ? size + " 字节" : "大小未知"})`);
              }
            }
          } catch {
            // 忽略权限错误继续
          }
        }
      } catch {
        // 忽略无法读取的目录
      }
    }

    await walk(targetPath, 0);

    if (results.length > 0) {
      return `搜索「${keyword}」找到 ${results.length} 个结果：\n\n${results.join("\n")}`;
    } else {
      return `未找到包含「${keyword}」的文件`;
    }
  },
});

// ---------- 启动 HTTP 服务 ----------
async function main() {
  // 使用 HTTP 传输，监听所有地址，端口 18889
  await server.start({
    transportType: "httpStream",
    httpStream: {
      port: 18889,
      host: "0.0.0.0",
    },
  });
  console.log(`✅ MCP 服务器已启动: http://0.0.0.0:18889`);
  console.log(`   在 Dify 中配置: http://host.docker.internal:18889`);
}

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});