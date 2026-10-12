/** Any image URL (data: or http) → a PNG blob; clipboards only reliably take image/png. */
export async function toPngBlob(src: string): Promise<Blob | null> {
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('image did not load'));
      img.src = src;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || 1;
    canvas.height = img.naturalHeight || 1;
    canvas.getContext('2d')?.drawImage(img, 0, 0);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  } catch {
    return null; // tainted canvas, unreadable URL
  }
}

/**
 * Puts an image on the clipboard. The blob is passed as a promise so the write starts inside the
 * click (Safari/WebKit refuses it otherwise). False when the host's webview does not allow it.
 */
export async function copyImage(blob: Promise<Blob | null>): Promise<boolean> {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return false;
    await navigator.clipboard.write([
      new ClipboardItem({
        'image/png': blob.then((b) => {
          if (!b) throw new Error('no image');
          return b;
        }),
      }),
    ]);
    return true;
  } catch {
    return false;
  }
}
