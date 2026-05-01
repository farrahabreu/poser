'use strict';

const multer = require('multer');
const path   = require('path');
const fs     = require('fs');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const UPLOAD_DIR   = path.resolve(__dirname, '../', process.env.UPLOAD_DIR || './uploads');
const MAX_AUDIO_MB = parseInt(process.env.MAX_AUDIO_MB || '20', 10);

fs.mkdirSync(path.join(UPLOAD_DIR, 'audio'),   { recursive: true });
fs.mkdirSync(path.join(UPLOAD_DIR, 'avatars'), { recursive: true });

const ALLOWED_AUDIO   = new Set(['audio/mpeg', 'audio/mp4', 'audio/webm', 'audio/ogg', 'audio/wav', 'audio/x-m4a']);
const ALLOWED_IMAGES  = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function makeStorage(subdir) {
  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(UPLOAD_DIR, subdir)),
    filename:    (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.bin';
      cb(null, uuidv4() + ext);
    },
  });
}

function fileFilter(allowed) {
  return (req, file, cb) => {
    if (allowed.has(file.mimetype)) cb(null, true);
    else cb(new Error(`Unsupported file type: ${file.mimetype}`), false);
  };
}

const audioUpload = multer({
  storage:    makeStorage('audio'),
  limits:     { fileSize: MAX_AUDIO_MB * 1024 * 1024 },
  fileFilter: fileFilter(ALLOWED_AUDIO),
});

const avatarUpload = multer({
  storage:    makeStorage('avatars'),
  limits:     { fileSize: 5 * 1024 * 1024 },
  fileFilter: fileFilter(ALLOWED_IMAGES),
});

function fileUrl(subdir, filename) {
  return `/uploads/${subdir}/${filename}`;
}

module.exports = { audioUpload, avatarUpload, fileUrl };
