import QRCode from 'qrcode';
import { credentialId } from '../checkins/client.js';

// Pure SVG geometry, never HTML, a URL, or an external image request.
export function ticketQr(credential) {
  if (!credentialId(credential)) throw new Error('Invalid admission credential');
  const { modules } = QRCode.create([{ data: credential, mode: 'byte' }], { errorCorrectionLevel: 'M' });
  const margin = 4, size = modules.size + margin * 2, paths = [];
  for (let row = 0; row < modules.size; row++) {
    for (let col = 0; col < modules.size; col++) {
      if (!modules.get(row, col)) continue;
      const start = col;
      while (col + 1 < modules.size && modules.get(row, col + 1)) col++;
      const width = col - start + 1;
      paths.push(`M${start + margin} ${row + margin}h${width}v1h-${width}z`);
    }
  }
  return { size, path: paths.join('') };
}
