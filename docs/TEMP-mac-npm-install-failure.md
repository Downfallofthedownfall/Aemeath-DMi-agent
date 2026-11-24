# 临时排查交接：mac 上双击启动在 `npm install` 失败

> 临时文件，查完就删。写给 **mac 本地的 Claude**：云端（Linux）复现不了，需要你在真机上查。

## 现象

双击 `exercise-launch.command` 和 `lecture-launch.command` 都失败，终端最后几行：

```
[exercise-mac] ✗ npm install 失败。请检查网络或代理后重试。
  旧依赖下插件会被 dsh 判为不兼容而停用，打开的会是标准版 dsh。
环境装配失败。请把上面终端里的报错发给开发者
```

这条消息来自 `scripts/profile-mac.sh` 第 136–140 行的分支：`node_modules/@deepseek-ai/dsh` 已存在，
但 `scripts/check-deps.mjs` 判定已装依赖与 `package-lock.json` 不一致（`git pull` 带来了 dsh 0.2.1 → 0.2.2-rc.5 的升级，
提交 `8690a98`），于是在仓库根重跑 `npm install`，**npm 本身报错退出**。
真正的原因在这几行**上面**的 npm 输出里，用户没有贴出来。

网络：用户**不在国内**，用的是 **Starlink**（不是镜像源问题，不用查 npmmirror）。

## 云端已排除的（Linux x64，Node 24.22.3 / npm 11.19.1）

- 全新 clone 在 HEAD `npm install`：成功。
- 模拟升级：先在 `8690a98~1`（dsh 0.2.1）装好依赖、跑旧版 `profile-mac.sh` 建好 profile 链接，再切到 HEAD 跑
  `bash scripts/profile-mac.sh exercise --setup-only`：check-deps 报 301 个不一致 + 47 个缺失 → `npm install` 成功 → 构建成功。
- 同样的升级加 `--os=darwin --cpu=arm64`（让 npm 下载 mac 专属包）：成功。
  这次升级里 mac 专属的变化只有两项：
  - `@deepseek-ai/libreoffice-kit-darwin-arm64`（及 x64）0.1.5 → 0.2.3，tarball 约 **70 MB**（解压 161 MB）
  - 新增 `@deepseek-ai/dsh-experimental-cua-macos@0.2.2-rc.5`（可选，约 4 MB）
- 所以 lockfile 与 package.json 是一致的，所有 tarball 在 registry.npmjs.org 上都存在。问题出在 mac 这台机器的环境。

## 请按顺序查

### 1. 先拿到真正的报错（最重要）

```bash
cd <仓库根>
node -v; npm -v; which -a node npm
npm install 2>&1 | tee /tmp/aemeath-npm-install.log
```

然后看 npm 自己的调试日志（最新一个）：

```bash
ls -t ~/.npm/_logs/ | head -3
grep -nE 'npm (error|ERR!)|verbose stack|code E' ~/.npm/_logs/$(ls -t ~/.npm/_logs/ | head -1) | head -60
```

把 `npm error code …` 那几行和 node / npm 版本报给用户。下面 2–7 是按报错码对照的嫌疑。

### 2. npm 版本 / 安装脚本审批（未验证，优先怀疑）

npm 11.19 起有 allowScripts：没被批准的安装脚本会打 `npm warn install-scripts … not yet covered by allowScripts`。
在 11.19.1 上只是警告（`strict-allow-scripts=false`），脚本照常运行。已有 **npm 12.2.3**，
云端还没来得及验证 npm 12 是否默认严格（会不会直接报错或跳过脚本）。

```bash
npm -v
npm config get strict-allow-scripts
npm config get allow-scripts
```

本仓库依赖里带安装脚本的包：`@deepseek-ai/dsh-subprocess-local`、`@google/genai`、`esbuild`、`koffi`、`node-pty`、`protobufjs`。
如果报错和 allow-scripts 有关，先告诉用户，别自己全局改 npm 配置。

### 3. `package-lock.json` 是否被本地改过 / 有冲突标记

npm 11 跑 `npm install` 会**改写** `package-lock.json`（`"dev": true` → `"devOptional": true`、加 `libc` 字段等），
之后 `git pull` 会因"本地修改会被覆盖"而拒绝。如果当时用了 `git stash` / `stash pop` 之类绕过，可能留下冲突。

```bash
git status --short package-lock.json
grep -c '^<<<<<<<\|^>>>>>>>' package-lock.json
git diff --stat package-lock.json
```

有冲突标记或大段差异 → `git checkout -- package-lock.json` 恢复成仓库版本再装（先跟用户确认）。

### 4. 网络（Starlink 断流）

报错码是 `ECONNRESET` / `ETIMEDOUT` / `EINTEGRITY` / `ERR_SOCKET_TIMEOUT` 之类，多半是下载 70 MB 的
libreoffice-kit 时断了。可以加重试和超时：

```bash
npm install --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000 --fetch-timeout=600000
npm config get proxy; npm config get https-proxy; npm config get registry
```

### 5. 缓存权限

报 `EACCES` 或 "Your cache folder contains root-owned files"：

```bash
ls -la ~/.npm | head
find ~/.npm -maxdepth 2 ! -user "$(id -un)" | head
```

修复要 `sudo chown -R "$(id -u)":"$(id -g)" ~/.npm` —— 先问用户。

### 6. 原地升级的 npm bug

报 `ENOTEMPTY: directory not empty, rename …` → 清掉重装：

```bash
rm -rf node_modules && npm install
```

注意：`esbuild` 在 lockfile 里只有 `@esbuild/win32-x64`（lockfile 是 Windows 上生成的），
全新安装时 esbuild 的 postinstall 会自己去 registry.npmjs.org 下载 darwin 二进制，这一步也需要网络通。

### 7. 磁盘

```bash
df -h .
```

## 规则（别踩）

- **只在仓库根**跑 `npm install`。**永远不要**在 `profiles/*` 里跑：那里的 `node_modules/@deepseek-ai` 是指向仓库根的符号链接，
  npm 会顺着链接把仓库根的依赖删空。
- 装好后验证：

  ```bash
  node scripts/check-deps.mjs
  bash scripts/profile-mac.sh exercise --setup-only
  bash scripts/profile-mac.sh lecture --setup-only
  ```

  两个都打印"装配完成"才算好，然后再双击启动器试一次。

## 要报回来的

1. `node -v`、`npm -v`、`which -a node npm`
2. `npm error code …` 及其后几行
3. 第 2–7 项里命中了哪一项、做了什么、结果如何

## 云端顺带发现、待改的（不影响本次排查）

`profile-mac.sh` 里的 `npm install` 会改写被跟踪的 `package-lock.json`，导致下次 `git pull` 被拒。
可考虑改成 `npm install --no-save`（npm 文档：`save=false` 时不写 package-lock.json）或 `npm ci`；两者都还没验证。
