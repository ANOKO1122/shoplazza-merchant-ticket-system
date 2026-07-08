import sharp from 'sharp';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { getEffectivePublicBaseUrl } from './email-service';

const THUMB_DIR = path.resolve(__dirname, '..', 'public', 'thumbnails');

// 确保目录存在
fs.mkdir(THUMB_DIR, { recursive: true }).catch(() => {});

/**
 * 下载远程商品图 → 转 JPEG → 压缩到 ~100KB → 存本地 → 返回绝对 URL
 * 已缓存的图片直接返回，不会重复下载
 */
export async function createThumbnail(imageUrl: string): Promise<string | null> {
  if (!imageUrl || !imageUrl.startsWith('http')) return null;

  try {
    // MD5 去重：相同 URL 生成相同文件名
    const hash = crypto.createHash('md5').update(imageUrl).digest('hex');
    const filename = `${hash}.jpg`;
    const filePath = path.join(THUMB_DIR, filename);

    // 已缓存 → 直接返回
    try {
      await fs.access(filePath);
      const baseUrl = await getEffectivePublicBaseUrl();
      return `${baseUrl}/thumbnails/${filename}`;
    } catch {
      // 未缓存，继续下载
    }

    // 下载原图
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch(imageUrl, { signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) return null;

    const buffer = Buffer.from(await resp.arrayBuffer());

    // sharp 压缩：max 400px 宽高, JPEG progressive, 质量递减直到 <100KB
    let quality = 85;
    let output: Buffer;
    do {
      output = await sharp(buffer)
        .rotate()           // 修正 EXIF 方向
        .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality, progressive: true, mozjpeg: true })
        .toBuffer();
      quality -= 10;
    } while (output.length > 100 * 1024 && quality >= 30);

    await fs.writeFile(filePath, output);
    const baseUrl = await getEffectivePublicBaseUrl();
    return `${baseUrl}/thumbnails/${filename}`;
  } catch (e: any) {
    console.error('[thumbnail] 处理失败:', imageUrl.slice(0, 80), e.message);
    return null;
  }
}

/**
 * 获取缩略图绝对 URL（已有缓存则直接返回，无缓存返回原图 URL 作为兜底）
 */
export async function getThumbnailUrl(originalUrl: string): Promise<string> {
  if (!originalUrl || !originalUrl.startsWith('http')) return originalUrl;
  const thumb = await createThumbnail(originalUrl);
  return thumb || originalUrl;
}

/**
 * 仅计算缩略图的本地绝对 URL（不触发下载），用于 API 响应中预填 URL
 */
export function resolveThumbnailUrl(originalUrl: string): string {
  if (!originalUrl || !originalUrl.startsWith('http')) return originalUrl;
  const hash = crypto.createHash('md5').update(originalUrl).digest('hex');
  // 注意：这里无法 await getEffectivePublicBaseUrl()，调用方若需绝对 URL 请自行拼接
  return `/thumbnails/${hash}.jpg`;
}
