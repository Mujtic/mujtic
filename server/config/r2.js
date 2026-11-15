// config/r2.js
const { S3Client } = require('@aws-sdk/client-s3');

const required = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  throw new Error(
    `R2 configuration missing: ${missing.join(', ')}. ` +
    `Set these in the Render dashboard → Environment.`
  );
}

const r2 = new S3Client({
  region: 'auto',                                                    // required by R2
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

module.exports = {
  r2,
  bucket:    process.env.R2_BUCKET_NAME,
  publicUrl: (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, ''),
};
