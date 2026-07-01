import multer from 'multer';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';

// ─── StorageProvider 接口 ───

export interface StorageProvider {
  /** 从临时文件路径读取并压缩保存，返回相对 URL 路径（如 /uploads/2026/abc.webp） */
  save(tempFilePath: string, originalName: string): Promise<string>;
  /** 按相对路径删除文件 */
  delete(relativeUrl: string): Promise<void>;
  /** 获取存储目录总大小（字节），用于管理后台监控 */
  getTotalSize(): Promise<number>;
}

// ─── LocalStorageProvider 实现 ───

const UPLOAD_ROOT = path.resolve(__dirname, '..', 'public', 'uploads');

export class LocalStorageProvider implements StorageProvider {
  async save(tempFilePath: string, _originalName: string): Promise<string> {
    const year = String(new Date().getFullYear());
    const dir = path.join(UPLOAD_ROOT, year);
    await fs.mkdir(dir, { recursive: true });

    const filename = `${crypto.randomBytes(16).toString('hex')}.webp`;
    const outputPath = path.join(dir, filename);

    // 从磁盘流式读取 → 流式转码 → 写入目标（内存 O(1)，不受原图大小影响）
    let transform = sharp(tempFilePath).rotate(); // 修正 EXIF 方向

    const metadata = await transform.metadata();
    if (metadata.width && metadata.width > 1200) {
      transform = transform.resize(1200);
    }

    await transform.webp({ quality: 80 }).toFile(outputPath);
    return `/uploads/${year}/${filename}`;
  }

  async delete(relativeUrl: string): Promise<void> {
    // 安全校验：路径必须以 /uploads/ 开头，防目录穿越
    if (!relativeUrl.startsWith('/uploads/')) {
      console.warn('[storage] 非法删除路径:', relativeUrl);
      return;
    }
    // 去掉 /uploads/ 前缀，防止 path.join 被绝对路径重置
    // （path.join 遇到绝对路径段会丢弃前面的路径，导致解析到系统根目录）
    const relative = relativeUrl.replace(/^\/uploads\//, '');
    // 二次校验：防止路径穿越字符
    if (!relative || relative.includes('..') || relative.includes('\0')) {
      console.warn('[storage] 路径穿越检测:', relativeUrl);
      return;
    }
    const filePath = path.join(UPLOAD_ROOT, relative);
    // 最终安全校验：解析后路径必须在 UPLOAD_ROOT 内
    if (!filePath.startsWith(UPLOAD_ROOT + path.sep) && filePath !== UPLOAD_ROOT) {
      console.warn('[storage] 路径越界:', relativeUrl, '→', filePath);
      return;
    }
    try {
      await fs.unlink(filePath);
    } catch (e: any) {
      if (e.code !== 'ENOENT') {
        console.error('[storage] 删除文件失败:', e.message);
      }
    }
  }

  async getTotalSize(): Promise<number> {
    return getDirSize(UPLOAD_ROOT);
  }
}

async function getDirSize(dir: string): Promise<number> {
  let total = 0;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        total += await getDirSize(full);
      } else if (entry.isFile()) {
        const stat = await fs.stat(full);
        total += stat.size;
      }
    }
  } catch {
    // 目录不存在则返回 0
  }
  return total;
}

// ─── 单例 ───

let _provider: StorageProvider;
export function getStorageProvider(): StorageProvider {
  if (!_provider) {
    _provider = new LocalStorageProvider();
  }
  return _provider;
}

// ─── Multer 中间件 ───

const TEMP_DIR = path.resolve(__dirname, '..', 'tmp', 'support-uploads');

// 确保临时目录存在
fs.mkdir(TEMP_DIR, { recursive: true }).catch((e) => {
  console.error('[storage] 无法创建临时目录:', TEMP_DIR, e.message);
});

const ALLOWED_MIMETYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
];

export const imageUpload = multer({
  storage: multer.diskStorage({
    destination: TEMP_DIR,
    filename: (_req, file, cb) => {
      // 随机文件名防冲突
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `${crypto.randomBytes(16).toString('hex')}${ext}`);
    },
  }),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB（售后照片足够，同时防内存压力）
    files: 3,                   // 每次最多 3 张
  },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIMETYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}. Only JPEG, PNG and WEBP are allowed.`));
    }
  },
});

/** 管理员发消息时使用的 multer 中间件（字段名 "images"，最多 3 张） */
export const uploadAttachments = imageUpload.array('images', 3);

/** 顾客发消息时使用的 multer 中间件（字段名 "images"，最多 1 张） */
export const uploadSingleAttachment = imageUpload.array('images', 1);

/** 处理 multer 文件数组，返回相对 URL 数组。处理完自动清理临时文件 */
export async function processAttachments(
  files: Express.Multer.File[],
): Promise<string[]> {
  const provider = getStorageProvider();
  const urls: string[] = [];
  for (const file of files) {
    try {
      // 传入临时文件路径，由 Sharp 从磁盘流式读取
      const url = await provider.save(file.path, file.originalname);
      urls.push(url);
    } catch (e: any) {
      console.error('[storage] 图片处理失败:', e.message);
      // 单张失败不阻塞其他图片
    } finally {
      // 无论成功与否，清理 Multer 写入的临时文件
      fs.unlink(file.path).catch(() => {});
    }
  }
  return urls;
}
