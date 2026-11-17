import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const repoWorkspaceRoot = path.resolve(rootDir, '../..');

/**
 * 计算指定文件的 SHA256 哈希值
 * @param {string} filePath 目标文件绝对路径
 * @returns {string|null} 十六进制哈希字符串，文件不存在返回 null
 */
function getFileSha256(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * 自动刷新并同步 integrity.json
 */
function updateIntegrity() {
  const pkgPath = path.join(rootDir, 'package.json');
  const integrityPath = path.join(rootDir, 'integrity.json');

  if (!fs.existsSync(pkgPath)) {
    console.error(`[错误] 未找到 package.json: ${pkgPath}`);
    process.exit(1);
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const version = pkg.version;

  let integrity = {
    version,
    engineVersion: version,
    engine: '',
    platforms: {}
  };

  if (fs.existsSync(integrityPath)) {
    try {
      integrity = JSON.parse(fs.readFileSync(integrityPath, 'utf8'));
    } catch {}
  }

  integrity.version = version;
  integrity.engineVersion = version;
  if (!integrity.platforms) integrity.platforms = {};

  // 1. 如果工作区 target-build 有刚构建出的新二进制，先自动复制更新到 bin 目录
  const releaseExeCandidate = path.join(repoWorkspaceRoot, 'target-build', 'release', 'cursor-magpie-bridge.exe');
  const targetWin32Exe = path.join(rootDir, 'bin', 'win32-x64', 'cursor-magpie-bridge.exe');
  if (fs.existsSync(releaseExeCandidate)) {
    fs.mkdirSync(path.dirname(targetWin32Exe), { recursive: true });
    fs.copyFileSync(releaseExeCandidate, targetWin32Exe);
    console.log(`[同步] 已从 target-build 复制最新二进制 -> ${path.relative(rootDir, targetWin32Exe)}`);
  }

  // 2. 计算 Windows x64 哈希
  if (fs.existsSync(targetWin32Exe)) {
    const hash = getFileSha256(targetWin32Exe);
    integrity.platforms['win32-x64'] = hash;
    if (process.platform === 'win32') {
      integrity.engine = hash;
    }
    console.log(`[SHA256] win32-x64 : ${hash}`);
  }

  // 3. 计算 macOS arm64 哈希（若存在）
  const targetDarwinBin = path.join(rootDir, 'bin', 'darwin-arm64', 'cursor-magpie-bridge');
  if (fs.existsSync(targetDarwinBin)) {
    const hash = getFileSha256(targetDarwinBin);
    integrity.platforms['darwin-arm64'] = hash;
    if (process.platform === 'darwin') {
      integrity.engine = hash;
    }
    console.log(`[SHA256] darwin-arm64: ${hash}`);
  }

  // 4. 写回 integrity.json
  fs.writeFileSync(integrityPath, JSON.stringify(integrity, null, 2) + '\n', 'utf8');
  console.log(`[成功] 已自动更新 integrity.json (版本: ${version})`);

  // 5. 自动同步到当前机器上的 Magpie 插件安装目录
  const activePluginDir = path.join(
    process.env.USERPROFILE || process.env.HOME || '',
    '.config',
    'magpie',
    'plugins',
    'node_modules',
    'magpie-agent-cursor-bridge'
  );

  if (fs.existsSync(activePluginDir)) {
    try {
      fs.copyFileSync(integrityPath, path.join(activePluginDir, 'integrity.json'));
      fs.copyFileSync(pkgPath, path.join(activePluginDir, 'package.json'));
      if (fs.existsSync(targetWin32Exe)) {
        const destWin32 = path.join(activePluginDir, 'bin', 'win32-x64', 'cursor-magpie-bridge.exe');
        fs.mkdirSync(path.dirname(destWin32), { recursive: true });
        fs.copyFileSync(targetWin32Exe, destWin32);
      }
      console.log(`[同步] 已同步至本地 Magpie 插件运行目录 -> ${activePluginDir}`);
    } catch (e) {
      console.warn(`[提示] 同步到本地运行目录时提示: ${e.message}`);
    }
  }
}

updateIntegrity();
