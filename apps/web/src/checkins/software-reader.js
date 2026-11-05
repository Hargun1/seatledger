import jsQR from 'jsqr';

// A transient, bounded canvas; no image export, URL, storage, or upload.
export function softwareReader(canvas) {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Camera canvas unavailable');
  return {
    detect(video) {
      if (!video.videoWidth || !video.videoHeight) return [];
      const scale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
      const width = Math.max(1, Math.round(video.videoWidth * scale)), height = Math.max(1, Math.round(video.videoHeight * scale));
      canvas.width = width; canvas.height = height;
      context.drawImage(video, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height);
      const result = jsQR(pixels.data, width, height, { inversionAttempts: 'dontInvert' });
      return result ? [{ rawValue: result.data }] : [];
    },
    clear() { canvas.width = 0; canvas.height = 0; }
  };
}
