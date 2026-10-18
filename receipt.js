// Transfer-notification images: validated by their real bytes, stored outside /public, shown only to the admin.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const DIR = process.env.RECEIPTS_DIR || path.join(__dirname, 'data', 'receipts');
fs.mkdirSync(DIR, { recursive: true });
const MAX = 1.5 * 1024 * 1024;

function parse(dataUrl) {
  const m = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(dataUrl || ''));
  if (!m) throw new Error('Attach a JPG, PNG or WebP image of the transfer notification.');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 500 || buf.length > MAX) throw new Error('The image must be a real screenshot under 1.5 MB.');
  const ext = buf.subarray(0, 3).equals(Buffer.from([0xFF, 0xD8, 0xFF])) ? 'jpg'
    : buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47])) ? 'png'
    : buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP' ? 'webp' : null;
  if (!ext) throw new Error('That file is not a valid image.');
  return { buf, ext, hash: crypto.createHash('sha256').update(buf).digest('hex') };
}
function save({ buf, ext }) { const name = crypto.randomBytes(16).toString('hex') + '.' + ext; fs.writeFileSync(path.join(DIR, name), buf, { flag: 'wx' }); return name; }
const pathOf = name => path.join(DIR, path.basename(name));
const remove = name => fs.rm(pathOf(name), () => {});
module.exports = { parse, save, pathOf, remove };
