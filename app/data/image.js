/* foodie · pictures: taking a frame from the camera, shrinking a photo before it is sent anywhere, and the tiny thumbnail that
   is stored with a meal. A photo is never stored by foodie: only the 160 px thumbnail (a few KB) can end up in a meal.
   Everything that touches a canvas is injectable, so the maths and the fallbacks are tested without a browser. */

export const MAX_SIDE = 1280;
export const MAX_BYTES = 400 * 1024;
export const THUMB_SIDE = 160;
export const THUMB_MAX_CHARS = 12 * 1024;            // the data URL, not the bytes: what a meal is allowed to carry

/** Size that fits `width` x `height` inside a square of `maxSide`, never enlarged, whole pixels. */
export function fitSize(width, height, maxSide = MAX_SIDE) {
  const w = Number(width);
  const h = Number(height);
  if (!(w > 0) || !(h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) return { width: 0, height: 0 };
  const scale = Math.min(1, maxSide / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

const toBlob = (canvas, type, quality) => new Promise((resolve) => {
  try { canvas.toBlob((b) => resolve(b || null), type, quality); } catch (e) { resolve(null); }
});

/**
 * Encodes a canvas as WebP when the browser really produces WebP (many silently give PNG instead), otherwise JPEG,
 * lowering the quality until it fits `maxBytes`.
 * @returns {Promise<Blob|null>}
 */
export async function encodeCanvas(canvas, { maxBytes = MAX_BYTES, qualities = [0.82, 0.72, 0.62, 0.5, 0.4], types = ['image/webp', 'image/jpeg'] } = {}) {
  let best = null;
  for (const type of types) {
    for (const quality of qualities) {
      const blob = await toBlob(canvas, type, quality);
      if (!blob || blob.type !== type) break;                  // the browser cannot encode this type: try the next one
      if (!best || blob.size < best.size) best = blob;
      if (blob.size <= maxBytes) return blob;
    }
    if (best && best.size <= maxBytes) return best;
  }
  return best;
}

/**
 * Draws `source` (a video, an ImageBitmap or an <img>) scaled down to fit `maxSide`, and encodes it.
 * @param {{width?:number, height?:number, videoWidth?:number, videoHeight?:number}} source
 * @param {{maxSide?:number, maxBytes?:number, createCanvas?:(w:number,h:number)=>any}} [o]
 * @returns {Promise<{blob:Blob, width:number, height:number}|null>}
 */
export async function drawToBlob(source, { maxSide = MAX_SIDE, maxBytes = MAX_BYTES, createCanvas = defaultCanvas } = {}) {
  const sw = source.videoWidth || source.naturalWidth || source.width;
  const sh = source.videoHeight || source.naturalHeight || source.height;
  const { width, height } = fitSize(sw, sh, maxSide);
  if (!width) return null;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, width, height);
  const blob = await encodeCanvas(canvas, { maxBytes });
  return blob ? { blob, width, height } : null;
}

function defaultCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** A frame of a playing <video>, as a picture ready to be sent (or shown). */
export const frameToBlob = (video, o) => drawToBlob(video, o);

/**
 * A photo from the gallery or the camera roll, shrunk and with its orientation applied.
 * @param {Blob} file
 * @param {{decode?:(f:Blob)=>Promise<any>}} [o]
 */
export async function compressFile(file, o = {}) {
  const decode = o.decode || ((f) => createImageBitmap(f, { imageOrientation: 'from-image' }));
  let bitmap = null;
  try {
    bitmap = await decode(file);
    return await drawToBlob(bitmap, o);
  } catch (e) {
    return null;                                              // not an image, or one this browser cannot decode
  } finally {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
  }
}

/**
 * The 160 px JPEG thumbnail kept with a meal, as a data URL of at most THUMB_MAX_CHARS characters, or null if it cannot be made that small.
 * @param {any} source  video, ImageBitmap or <img>
 */
export async function thumbnailDataUrl(source, { createCanvas = defaultCanvas, readBlob = blobToDataUrl } = {}) {
  const sw = source.videoWidth || source.naturalWidth || source.width;
  const sh = source.videoHeight || source.naturalHeight || source.height;
  const { width, height } = fitSize(sw, sh, THUMB_SIDE);
  if (!width) return null;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, width, height);
  for (const quality of [0.7, 0.55, 0.4, 0.3]) {
    const blob = await toBlob(canvas, 'image/jpeg', quality);
    if (!blob || blob.type !== 'image/jpeg') return null;
    const url = await readBlob(blob);
    if (typeof url === 'string' && url.length <= THUMB_MAX_CHARS) return url;
  }
  return null;
}

export function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === 'string' ? r.result : null);
    r.onerror = () => resolve(null);
    r.readAsDataURL(blob);
  });
}
