import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, totalmem, platform, release } from 'node:os';
import { fileURLToPath } from 'node:url';

export function integerOption(name, fallback, min, max) {
  const text = process.env[name];
  if (text !== undefined && !/^\d+$/.test(text)) throw new TypeError('Invalid ' + name);
  const value = text === undefined ? fallback : Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError('Invalid ' + name);
  return value;
}
export function machine() {
  return { node: process.version, platform: platform(), release: release(), cpuModel: cpus()[0]?.model,
    logicalCpus: cpus().length, memoryBytes: totalmem() };
}
export function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b), p = fraction => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
  return { count: sorted.length, p50Ms: p(0.5), p95Ms: p(0.95), p99Ms: p(0.99), minMs: sorted[0] ?? null, maxMs: sorted.at(-1) ?? null };
}
export async function writeEvidence(kind, report) {
  if (!['queries', 'load', 'failures'].includes(kind)) throw new TypeError('Invalid report kind');
  const directory = new URL('../../test-results/evidence/', import.meta.url); await mkdir(directory, { recursive: true });
  const file = new URL(kind + '-' + new Date().toISOString().replaceAll(':', '-') + '.json', directory);
  await writeFile(file, JSON.stringify(report, null, 2) + '\n');
  console.log('Evidence saved: ' + fileURLToPath(file));
}
