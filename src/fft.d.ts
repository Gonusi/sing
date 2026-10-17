// fft.js 4.0.4 ships no types. Radix-4 FFT; size must be a power of two.
declare module 'fft.js' {
  export default class FFT {
    constructor(size: number);
    readonly size: number;
    createComplexArray(): number[];
    toComplexArray(input: ArrayLike<number>, storage?: number[]): number[];
    fromComplexArray(complex: ArrayLike<number>, storage?: number[]): number[];
    completeSpectrum(spectrum: number[]): void;
    /** out: interleaved [re, im, ...] of length 2*size; fills the left half for real input */
    realTransform(out: number[], data: ArrayLike<number>): void;
    transform(out: number[], data: ArrayLike<number>): void;
    inverseTransform(out: number[], data: ArrayLike<number>): void;
  }
}
