/**
 * Preprocessing services for NIR spectra
 */

export const applySNV = (x: number[]): number[] => {
  if (x.length === 0) return x;
  const mean = x.reduce((a, b) => a + b, 0) / x.length;
  // SNV standard uses population standard deviation (divisor N)
  const std = Math.sqrt(x.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / x.length);
  return x.map(v => (v - mean) / (std || 1));
};

export const applyMSC = (x: number[], ref: number[]): number[] => {
  if (!ref || ref.length !== x.length || x.length === 0) return x;
  const n = x.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += ref[i];
    sumY += x[i];
    sumXY += ref[i] * x[i];
    sumXX += ref[i] * ref[i];
  }
  const a = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  const b = (sumY - a * sumX) / n;
  return x.map(v => (v - b) / (a || 1));
};

export const applySavGol = (x: number[], window: number, poly: number, deriv: number): number[] => {
  // Only deriv=1 and window=11 for now as per current implementation
  if (window !== 11 || deriv !== 1) return x;

  // Correct coefficients for Window=11, Poly=2, Deriv=1
  // Ordered from left to right (j=-5 to j=5)
  const coeffs = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5];
  const norm = 110; // Sum of j^2 for h=1

  const out = new Array(x.length).fill(0);
  const half = 5;
  for (let i = half; i < x.length - half; i++) {
    let sum = 0;
    for (let j = -half; j <= half; j++) {
      sum += x[i + j] * coeffs[j + half];
    }
    out[i] = sum / norm;
  }
  // Fill edges with closest calculated value
  for (let i = 0; i < half; i++) out[i] = out[half];
  for (let i = x.length - half; i < x.length; i++) out[i] = out[x.length - half - 1];

  return out;
};
