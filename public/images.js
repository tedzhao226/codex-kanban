export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export function validateImages(images = []) {
  if (!Array.isArray(images) || images.length > MAX_IMAGES) throw new Error(`Attach up to ${MAX_IMAGES} images.`);
  let total = 0;
  for (const image of images) {
    if (typeof image?.name !== 'string' || image.name.length > 255 || typeof image.dataUrl !== 'string') throw new Error('Invalid image attachment.');
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.dataUrl);
    if (!match || match[2].length % 4 !== 0) throw new Error('Choose a PNG, JPEG, WebP, or GIF image.');
    total += match[2].length / 4 * 3 - (match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0);
    if (total > MAX_IMAGE_BYTES) throw new Error('Images must total 3 MB or less.');
    const header = atob(match[2].slice(0, 24));
    const valid = { 'image/png': header.startsWith('\x89PNG\r\n\x1a\n'), 'image/jpeg': header.startsWith('\xff\xd8\xff'),
      'image/webp': header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP', 'image/gif': /^GIF8[79]a/.test(header) };
    if (!valid[match[1]]) throw new Error('The image contents do not match its file type.');
  }
  return images;
}
