// services/storageService.js
const { PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');
const sharp = require('sharp');
const { r2, bucket, publicUrl } = require('../config/r2');
const { AppError } = require('../utils/appError');
const { logger } = require('../config/logger');

// Event posters are displayed at up to ~1200 px wide (hero on the event
// landing page) and ~600 px in cards. Resizing down to 1200 caps storage
// and bandwidth without visible quality loss on retina displays.
const MAX_WIDTH     = 1200;
const JPEG_QUALITY  = 82;

const EXT = { jpeg: 'jpg', png: 'png', webp: 'webp', gif: 'gif' };

/**
 * Resize + optimise an in-memory upload, then PUT it to R2.
 * Returns { url, key } — url is the public CDN URL to store in Mongo.
 *
 * Throws AppError(400) if the buffer isn't a decodable image —
 * Sharp validates the actual bytes, so a mislabelled file (image/png
 * that's actually a zip) is rejected here regardless of what the client
 * declared.
 */
async function uploadImage(buffer, { folder = 'events', originalName = 'image' } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new AppError('No image data received', 400);
  }

  // ── Resize + normalise to JPEG ──
  // .rotate() with no args applies EXIF orientation — phone photos otherwise
  // land sideways. mozjpeg + progressive give ~30% smaller files at the same
  // perceived quality, which directly cuts R2 egress (free tier is generous
  // but not infinite).
  let optimized;
  try {
    optimized = await sharp(buffer)
      .rotate()
      .resize({ width: MAX_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true, progressive: true })
      .toBuffer();
  } catch (err) {
    logger.warn('Image rejected by sharp', { err: err.message, bytes: buffer.length });
    throw new AppError('The file is not a valid image', 400);
  }

  // ── Deterministic, collision-resistant key ──
  // Date prefix keeps the bucket browsable by day; random suffix prevents
  // two users uploading `poster.jpg` from overwriting each other.
  const day  = new Date().toISOString().slice(0, 10);                  // 2026-11-15
  const rand = crypto.randomBytes(8).toString('hex');
  const safe = String(originalName).replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'image';
  const key  = `${folder}/${day}/${safe}-${rand}.jpg`;

  // ── Upload ──
  try {
    await r2.send(new PutObjectCommand({
      Bucket:      bucket,
      Key:         key,
      Body:        optimized,
      ContentType: 'image/jpeg',
      // 1 year, immutable — the key contains a random suffix so it can never
      // be reused for a different image. Cloudflare's CDN honours this and
      // stops re-fetching from origin after the first request per PoP.
      CacheControl: 'public, max-age=31536000, immutable',
    }));
  } catch (err) {
    logger.error('R2 upload failed', { err: err.message, key });
    throw new AppError('Could not upload the image. Please try again.', 502);
  }

  if (!publicUrl) {
    logger.error('R2_PUBLIC_URL not set — returning relative key', { key });
    return { url: `/${key}`, key };
  }

  return { url: `${publicUrl}/${key}`, key };
}

/**
 * Best-effort delete — used when an event is updated and the old poster is
 * replaced, or when an event is deleted. Never throws: a missing object on
 * R2 is not a reason to fail a request that otherwise succeeded.
 */
async function deleteImage(key) {
  if (!key) return;
  try {
    await r2.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch (err) {
    logger.warn('R2 delete failed (non-fatal)', { err: err.message, key });
  }
}

/**
 * Recover the R2 key from a public URL — needed when we only have the
 * stored `image` field on an event and want to delete the old file.
 * Returns null if the URL doesn't belong to our bucket.
 */
function keyFromUrl(url) {
  if (!url || !publicUrl || !url.startsWith(publicUrl)) return null;
  return url.slice(publicUrl.length + 1);   // strip "https://domain/"
}

module.exports = { uploadImage, deleteImage, keyFromUrl };
