// QR encoding for the invite link: a pure string -> module matrix step.
// The component only draws what this returns.
import { encode } from 'uqr';

/** Light border around the symbol, in modules (the QR spec asks for 4). */
export const QR_QUIET_ZONE = 4;

/** The module matrix for `text` at error-correction level M. True is dark. */
export function qrMatrix(text: string): boolean[][] {
  return encode(text, { ecc: 'M', border: 0 }).data;
}

/** SVG path data: one unit square per dark module, no quiet zone. */
export function qrPath(matrix: boolean[][]): string {
  let d = '';
  for (let y = 0; y < matrix.length; y++) {
    const row = matrix[y]!;
    for (let x = 0; x < row.length; x++) {
      if (row[x]) d += `M${x} ${y}h1v1h-1z`;
    }
  }
  return d;
}
