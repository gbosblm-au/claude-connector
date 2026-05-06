// utils/format.js
// Formatting helpers for clean statistical output.

/**
 * Round a number to N significant figures.
 */
export function sigFig(n, digits = 6) {
  if (n === null || n === undefined || isNaN(n) || !isFinite(n)) return n;
  if (n === 0) return 0;
  const d = Math.ceil(Math.log10(Math.abs(n)));
  const power = digits - d;
  const magnitude = Math.pow(10, power);
  return Math.round(n * magnitude) / magnitude;
}

/**
 * Format a p-value with appropriate precision and significance stars.
 */
export function formatP(p) {
  if (p === null || p === undefined) return "N/A";
  if (p < 0.001) return `${p.toExponential(3)} ***`;
  if (p < 0.01)  return `${p.toFixed(4)} **`;
  if (p < 0.05)  return `${p.toFixed(4)} *`;
  if (p < 0.1)   return `${p.toFixed(4)} .`;
  return p.toFixed(4);
}

/**
 * Format a number with commas for thousands.
 */
export function fmtNum(n, decimals = 4) {
  if (n === null || n === undefined || isNaN(n)) return "N/A";
  if (!isFinite(n)) return n > 0 ? "Inf" : "-Inf";
  return Number(n.toFixed(decimals)).toLocaleString("en-AU", {
    maximumFractionDigits: decimals,
  });
}

/**
 * Build a fixed-width table string from headers and rows.
 */
export function buildTable(headers, rows, separator = "  ") {
  const allRows = [headers, ...rows];
  const widths = headers.map((_, i) =>
    Math.max(...allRows.map((r) => String(r[i] ?? "").length))
  );

  const formatRow = (row) =>
    row.map((cell, i) => String(cell ?? "").padEnd(widths[i])).join(separator);

  const headerLine = formatRow(headers);
  const divider = widths.map((w) => "-".repeat(w)).join(separator);

  return [headerLine, divider, ...rows.map(formatRow)].join("\n");
}

/**
 * Format a confidence interval.
 */
export function formatCI(lower, upper, confidence = 95) {
  return `${confidence}% CI: [${fmtNum(lower)}, ${fmtNum(upper)}]`;
}

/**
 * Interpret an r-squared value.
 */
export function interpretR2(r2) {
  if (r2 >= 0.9) return "excellent fit";
  if (r2 >= 0.7) return "good fit";
  if (r2 >= 0.5) return "moderate fit";
  if (r2 >= 0.3) return "weak fit";
  return "poor fit";
}

/**
 * Interpret a correlation coefficient.
 */
export function interpretCorrelation(r) {
  const abs = Math.abs(r);
  const dir = r >= 0 ? "positive" : "negative";
  if (abs >= 0.9) return `very strong ${dir}`;
  if (abs >= 0.7) return `strong ${dir}`;
  if (abs >= 0.5) return `moderate ${dir}`;
  if (abs >= 0.3) return `weak ${dir}`;
  return "negligible";
}

/**
 * Interpret effect size (Cohen's d).
 */
export function interpretCohenD(d) {
  const abs = Math.abs(d);
  if (abs >= 0.8) return "large";
  if (abs >= 0.5) return "medium";
  if (abs >= 0.2) return "small";
  return "negligible";
}

/**
 * Section divider for multi-part output.
 */
export function section(title, width = 60) {
  const pad = Math.max(0, Math.floor((width - title.length - 2) / 2));
  return `\n${"=".repeat(pad)} ${title} ${"=".repeat(pad)}\n`;
}

/**
 * Compact summary line.
 */
export function kv(key, value, keyWidth = 22) {
  return `${String(key).padEnd(keyWidth)} ${value}`;
}
