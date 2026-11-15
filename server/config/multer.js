// config/multer.js
const multer = require('multer');
const { AppError } = require('../utils/appError');

// ── Why memoryStorage ──
// Render's filesystem is ephemeral — anything written to disk is lost on
// every deploy or restart. Uploads go straight to R2 via
// services/storageService, so multer's only job is to parse the multipart
// body and hand us a Buffer. Nothing touches disk.

const EXT = {
  'image/jpeg': '.jpg',
  'image/png':  '.png',
  'image/gif':  '.gif',
  'image/webp': '.webp',
};

const fileFilter = (req, file, cb) => {
  if (EXT[file.mimetype]) return cb(null, true);
  // SVG intentionally excluded — inline <script> in SVG served as image/svg+xml
  // is a stored-XSS vector. Sharp wouldn't decode it to raster anyway.
  cb(new AppError('Only JPEG, PNG, GIF or WebP images are allowed', 400), false);
};

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  // 8 MB per file is generous for a phone photo, tight enough to stop
  // someone pushing a 200 MB file through the parser. Sharp's resize
  // happens after, so the buffer is freed as soon as the request completes.
  limits: { fileSize: 8 * 1024 * 1024, files: 5 },
});

const uploadSingle   = (field = 'file') => upload.single(field);
const uploadMultiple = (field, max = 5) => upload.array(field, max);
const uploadFields   = (fields) => upload.fields(fields);

module.exports = {
  upload,
  uploadSingle,
  uploadMultiple,
  uploadFields,
};
