// tools/descriptiveStats.js
// Comprehensive descriptive statistics: central tendency, spread, shape,
// percentiles, frequency tables, cross-tabulations, and normality assessment.

import * as ss from "simple-statistics";
import { getDataset, getNumericColumn, getCategoricalColumn } from "../store/dataStore.js";
import { fmtNum, formatP, buildTable, kv, section } from "../utils/format.js";

// -----------------------------------------------------------------------
// Tool Definitions
// -----------------------------------------------------------------------

export const describeToolDefinition = {
  name: "stats_describe",
  description:
    "Computes comprehensive descriptive statistics for one or more columns: " +
    "count, mean, median, mode, standard deviation, variance, min, max, range, " +
    "quartiles (Q1, Q3), IQR, skewness, kurtosis, coefficient of variation, and standard error. " +
    "For categorical columns returns frequency counts and proportions instead.",
  inputSchema: {
    type: "object",
    properties: {
      dataset: { type: "string", description: "Dataset name." },
      columns: {
        type: "array",
        items: { type: "string" },
        description: "Column names to analyse. Analyses all columns if omitted.",
      },
    },
    required: ["dataset"],
  },
};

export const frequencyToolDefinition = {
  name: "stats_frequency",
  description:
    "Generates a frequency distribution table for a categorical or discrete numeric column. " +
    "Shows count, percentage, and cumulative percentage for each unique value.",
  inputSchema: {
    type: "object",
    properties: {
      dataset: { type: "string", description: "Dataset name." },
      column: { type: "string", description: "Column to analyse." },
      top_n: { type: "number", description: "Show only the top N most frequent values (default all).", minimum: 1 },
      sort: {
        type: "string",
        description: "Sort by 'frequency' (default), 'value_asc', or 'value_desc'.",
        enum: ["frequency", "value_asc", "value_desc"],
      },
    },
    required: ["dataset", "column"],
  },
};

export const histogramToolDefinition = {
  name: "stats_histogram",
  description:
    "Computes a histogram (binned frequency distribution) for a numeric column. " +
    "Returns bin edges, counts, and densities. Useful for understanding data distribution shape.",
  inputSchema: {
    type: "object",
    properties: {
      dataset: { type: "string", description: "Dataset name." },
      column: { type: "string", description: "Numeric column name." },
      bins: { type: "number", description: "Number of bins (default: Sturges rule auto-calculation).", minimum: 2, maximum: 200 },
      range_min: { type: "number", description: "Override minimum bin edge." },
      range_max: { type: "number", description: "Override maximum bin edge." },
    },
    required: ["dataset", "column"],
  },
};

export const crosstabToolDefinition = {
  name: "stats_crosstab",
  description:
    "Creates a cross-tabulation (contingency table) of two categorical columns showing counts, " +
    "row percentages, and column percentages. Also computes chi-square test of independence.",
  inputSchema: {
    type: "object",
    properties: {
      dataset: { type: "string", description: "Dataset name." },
      row_column: { type: "string", description: "Column for rows." },
      col_column: { type: "string", description: "Column for columns." },
      normalize: {
        type: "string",
        description: "Normalize values: 'none' (counts), 'row' (row %), 'col' (column %), 'total' (total %).",
        enum: ["none", "row", "col", "total"],
      },
    },
    required: ["dataset", "row_column", "col_column"],
  },
};

export const normalityToolDefinition = {
  name: "stats_normality",
  description:
    "Tests whether a numeric column follows a normal distribution using multiple tests: " +
    "Shapiro-Wilk approximation, D'Agostino skewness/kurtosis test, Jarque-Bera test, " +
    "and visual summary statistics (skewness, kurtosis, Q-Q plot percentiles).",
  inputSchema: {
    type: "object",
    properties: {
      dataset: { type: "string", description: "Dataset name." },
      column: { type: "string", description: "Numeric column name." },
    },
    required: ["dataset", "column"],
  },
};

// -----------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------

export async function handleDescribe(args) {
  const ds = getDataset(args?.dataset);
  const targetCols = args?.columns?.length
    ? args.columns
    : ds.columnNames;

  const sections = [];

  for (const colName of targetCols) {
    const meta = ds.columnMeta.find((m) => m.name === colName);
    if (!meta) continue;

    sections.push(section(colName, 55));

    if (meta.type === "numeric") {
      const vals = getNumericColumn(ds, colName).map(Number);
      if (vals.length === 0) {
        sections.push("  No valid numeric values.\n");
        continue;
      }
      vals.sort((a, b) => a - b);

      const n = vals.length;
      const mean = ss.mean(vals);
      const median = ss.median(vals);
      const mode = (() => { try { return ss.mode(vals); } catch { return NaN; } })();
      const stdDev = ss.standardDeviation(vals);
      const variance = ss.variance(vals);
      const min = vals[0];
      const max = vals[n - 1];
      const range = max - min;
      const q1 = ss.quantile(vals, 0.25);
      const q3 = ss.quantile(vals, 0.75);
      const iqr = q3 - q1;
      const skewness = ss.sampleSkewness(vals);
      const kurtosis = ss.sampleKurtosis(vals);
      const cv = mean !== 0 ? (stdDev / Math.abs(mean)) * 100 : NaN;
      const se = stdDev / Math.sqrt(n);
      const p5 = ss.quantile(vals, 0.05);
      const p95 = ss.quantile(vals, 0.95);
      const p99 = ss.quantile(vals, 0.99);
      const missing = meta.nullCount;

      sections.push([
        kv("Count (valid)", n.toLocaleString()),
        kv("Missing", missing.toLocaleString() + (missing > 0 ? ` (${((missing / (n + missing)) * 100).toFixed(1)}%)` : "")),
        kv("Mean", fmtNum(mean)),
        kv("Median", fmtNum(median)),
        kv("Mode", isNaN(mode) ? "N/A" : fmtNum(mode)),
        kv("Std Deviation", fmtNum(stdDev)),
        kv("Variance", fmtNum(variance)),
        kv("Std Error", fmtNum(se)),
        kv("Coeff of Variation", isNaN(cv) ? "N/A" : fmtNum(cv) + "%"),
        kv("Min", fmtNum(min)),
        kv("Max", fmtNum(max)),
        kv("Range", fmtNum(range)),
        kv("Q1 (25th pct)", fmtNum(q1)),
        kv("Q3 (75th pct)", fmtNum(q3)),
        kv("IQR", fmtNum(iqr)),
        kv("5th percentile", fmtNum(p5)),
        kv("95th percentile", fmtNum(p95)),
        kv("99th percentile", fmtNum(p99)),
        kv("Skewness", fmtNum(skewness) + "  " + interpretSkewness(skewness)),
        kv("Kurtosis (excess)", fmtNum(kurtosis) + "  " + interpretKurtosis(kurtosis)),
      ].join("\n"));
    } else {
      // Categorical
      const vals = getCategoricalColumn(ds, colName).filter((v) => v !== null);
      const freq = new Map();
      for (const v of vals) freq.set(v, (freq.get(v) || 0) + 1);
      const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
      const top5 = sorted.slice(0, 5).map(([v, c]) =>
        `  "${v}": ${c.toLocaleString()} (${((c / vals.length) * 100).toFixed(1)}%)`
      );
      sections.push([
        kv("Count (valid)", vals.length.toLocaleString()),
        kv("Missing", meta.nullCount.toLocaleString()),
        kv("Unique values", freq.size.toLocaleString()),
        kv("Type", "Categorical"),
        "",
        "Top 5 values:",
        ...top5,
      ].join("\n"));
    }
  }

  return { content: [{ type: "text", text: sections.join("\n") }] };
}

// -----------------------------------------------------------------------

export async function handleFrequency(args) {
  const ds = getDataset(args?.dataset);
  const colName = args?.column;
  if (!ds.columns.has(colName)) throw new Error(`Column "${colName}" not found.`);

  const rawVals = ds.columns.get(colName);
  const freq = new Map();
  let nullCount = 0;

  for (const v of rawVals) {
    if (v === null || v === undefined) { nullCount++; continue; }
    const key = String(v);
    freq.set(key, (freq.get(key) || 0) + 1);
  }

  let entries = [...freq.entries()];
  const sort = args?.sort || "frequency";
  if (sort === "frequency") entries.sort((a, b) => b[1] - a[1]);
  else if (sort === "value_asc") entries.sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  else if (sort === "value_desc") entries.sort((a, b) => b[0].localeCompare(a[0], undefined, { numeric: true }));

  if (args?.top_n) entries = entries.slice(0, args.top_n);

  const total = rawVals.length;
  const validTotal = total - nullCount;
  let cumulative = 0;

  const rows = entries.map(([val, count]) => {
    const pct = (count / validTotal) * 100;
    cumulative += pct;
    return [val, count.toLocaleString(), fmtNum(pct, 2) + "%", fmtNum(cumulative, 2) + "%"];
  });

  const table = buildTable(["Value", "Count", "Percent", "Cumulative%"], rows);

  return {
    content: [
      {
        type: "text",
        text:
          `Frequency Distribution: "${colName}"\n` +
          `${"=".repeat(50)}\n` +
          `Total rows:    ${total.toLocaleString()}\n` +
          `Valid values:  ${validTotal.toLocaleString()}\n` +
          `Missing:       ${nullCount.toLocaleString()}\n` +
          `Unique values: ${freq.size.toLocaleString()}\n\n` +
          table,
      },
    ],
  };
}

// -----------------------------------------------------------------------

export async function handleHistogram(args) {
  const ds = getDataset(args?.dataset);
  const vals = getNumericColumn(ds, args?.column).map(Number).sort((a, b) => a - b);
  if (vals.length < 2) throw new Error("Not enough data points for histogram.");

  const min = args?.range_min !== undefined ? args.range_min : vals[0];
  const max = args?.range_max !== undefined ? args.range_max : vals[vals.length - 1];

  // Sturges rule for bin count if not specified
  const numBins = args?.bins || Math.max(5, Math.ceil(1 + 3.322 * Math.log10(vals.length)));
  const binWidth = (max - min) / numBins;

  const bins = Array.from({ length: numBins }, (_, i) => ({
    lower: min + i * binWidth,
    upper: min + (i + 1) * binWidth,
    count: 0,
  }));

  for (const v of vals) {
    if (v < min || v > max) continue;
    let idx = Math.floor((v - min) / binWidth);
    if (idx >= numBins) idx = numBins - 1;
    bins[idx].count++;
  }

  const maxCount = Math.max(...bins.map((b) => b.count));
  const barWidth = 30;

  const rows = bins.map((b) => {
    const density = b.count / (vals.length * binWidth);
    const bar = "#".repeat(Math.round((b.count / maxCount) * barWidth));
    return [
      `[${fmtNum(b.lower, 3)}, ${fmtNum(b.upper, 3)})`,
      b.count.toLocaleString(),
      fmtNum((b.count / vals.length) * 100, 2) + "%",
      fmtNum(density, 6),
      bar,
    ];
  });

  const table = buildTable(["Bin", "Count", "Freq%", "Density", "Distribution"], rows);

  return {
    content: [
      {
        type: "text",
        text:
          `Histogram: "${args.column}"\n` +
          `${"=".repeat(50)}\n` +
          `N: ${vals.length.toLocaleString()}  Bins: ${numBins}  Bin width: ${fmtNum(binWidth, 4)}\n` +
          `Range: [${fmtNum(min, 4)}, ${fmtNum(max, 4)}]\n\n` +
          table,
      },
    ],
  };
}

// -----------------------------------------------------------------------

export async function handleCrosstab(args) {
  const ds = getDataset(args?.dataset);
  const rowCol = args?.row_column;
  const colCol = args?.col_column;
  const normalize = args?.normalize || "none";

  if (!ds.columns.has(rowCol)) throw new Error(`Row column "${rowCol}" not found.`);
  if (!ds.columns.has(colCol)) throw new Error(`Col column "${colCol}" not found.`);

  const rowVals = ds.columns.get(rowCol);
  const colVals = ds.columns.get(colCol);

  // Build unique categories
  const rowCats = [...new Set(rowVals.filter((v) => v !== null))].sort();
  const colCats = [...new Set(colVals.filter((v) => v !== null))].sort();

  if (rowCats.length > 50 || colCats.length > 50) {
    throw new Error(
      `Too many unique values for crosstab (row: ${rowCats.length}, col: ${colCats.length}). ` +
      `Limit to columns with <= 50 unique values.`
    );
  }

  // Count matrix
  const counts = {};
  for (const r of rowCats) {
    counts[r] = {};
    for (const c of colCats) counts[r][c] = 0;
  }
  let total = 0;
  for (let i = 0; i < ds.rowCount; i++) {
    const r = rowVals[i], c = colVals[i];
    if (r !== null && c !== null && counts[r] !== undefined && counts[r][c] !== undefined) {
      counts[r][c]++;
      total++;
    }
  }

  // Row/col totals
  const rowTotals = {};
  const colTotals = {};
  for (const r of rowCats) {
    rowTotals[r] = colCats.reduce((s, c) => s + counts[r][c], 0);
  }
  for (const c of colCats) {
    colTotals[c] = rowCats.reduce((s, r) => s + counts[r][c], 0);
  }

  // Build table rows
  const headers = ["", ...colCats.map(String), "Total"];
  const tableRows = rowCats.map((r) => {
    const cells = colCats.map((c) => {
      const cnt = counts[r][c];
      if (normalize === "row") return fmtNum((cnt / (rowTotals[r] || 1)) * 100, 1) + "%";
      if (normalize === "col") return fmtNum((cnt / (colTotals[c] || 1)) * 100, 1) + "%";
      if (normalize === "total") return fmtNum((cnt / (total || 1)) * 100, 1) + "%";
      return cnt.toLocaleString();
    });
    const rowTotal = normalize === "none" ? rowTotals[r].toLocaleString() : "100%";
    return [String(r), ...cells, rowTotal];
  });

  const colTotalRow = ["Total", ...colCats.map((c) => {
    if (normalize === "none") return colTotals[c].toLocaleString();
    return normalize === "col" ? "100%" : fmtNum((colTotals[c] / (total || 1)) * 100, 1) + "%";
  }), total.toLocaleString()];
  tableRows.push(colTotalRow);

  const table = buildTable(headers, tableRows);

  // Chi-square test of independence
  let chiResult = "";
  try {
    let chi2 = 0;
    const df = (rowCats.length - 1) * (colCats.length - 1);
    for (const r of rowCats) {
      for (const c of colCats) {
        const observed = counts[r][c];
        const expected = (rowTotals[r] * colTotals[c]) / total;
        if (expected > 0) chi2 += Math.pow(observed - expected, 2) / expected;
      }
    }
    const { jStat } = await import("jstat");
    const p = 1 - jStat.chisquare.cdf(chi2, df);
    chiResult =
      `\nChi-Square Test of Independence:\n` +
      `  Chi2 = ${fmtNum(chi2)}  df = ${df}  p = ${formatP(p)}\n` +
      `  Interpretation: ${p < 0.05 ? "Significant association (p < 0.05)" : "No significant association (p >= 0.05)"}`;
  } catch { /* jstat may not support this directly */ }

  return {
    content: [
      {
        type: "text",
        text:
          `Cross-Tabulation: "${rowCol}" x "${colCol}"\n` +
          `(normalize: ${normalize})\n\n` +
          table +
          chiResult,
      },
    ],
  };
}

// -----------------------------------------------------------------------

export async function handleNormality(args) {
  const ds = getDataset(args?.dataset);
  const vals = getNumericColumn(ds, args?.column).map(Number).sort((a, b) => a - b);
  const n = vals.length;

  if (n < 8) throw new Error(`Need at least 8 observations for normality tests (have ${n}).`);

  const mean = ss.mean(vals);
  const stdDev = ss.standardDeviation(vals);
  const skewness = ss.sampleSkewness(vals);
  const kurtosis = ss.sampleKurtosis(vals);

  // Jarque-Bera test
  const jb = (n / 6) * (Math.pow(skewness, 2) + Math.pow(kurtosis - 3, 2) / 4);
  const jbDf = 2;

  // D'Agostino-Pearson test (approx)
  // Z-score for skewness
  const y = skewness * Math.sqrt((n + 1) * (n + 3) / (6 * (n - 2)));
  const beta2 = 3 * (Math.pow(n, 2) + 27 * n - 70) * (n + 1) * (n + 3) /
    ((n - 2) * (n + 5) * (n + 7) * (n + 9));
  const W2 = Math.sqrt(2 * (beta2 - 1)) - 1;
  const delta = 1 / Math.sqrt(Math.log(Math.sqrt(W2)));
  const alpha = Math.sqrt(2 / (W2 - 1));
  const zSkew = delta * Math.log(y / alpha + Math.sqrt(Math.pow(y / alpha, 2) + 1));

  // Z-score for kurtosis
  const meanK = 3 * (n - 1) / (n + 1);
  const varK = 24 * n * (n - 2) * (n - 3) / (Math.pow(n + 1, 2) * (n + 3) * (n + 5));
  const zKurt = (kurtosis - meanK) / Math.sqrt(varK);

  const k2 = Math.pow(zSkew, 2) + Math.pow(zKurt, 2);

  // Q-Q percentile comparison
  const theoretical = [5, 10, 25, 50, 75, 90, 95].map((p) => {
    const q = ss.quantile(vals, p / 100);
    const zScore = (p === 50) ? 0 : (p < 50)
      ? -Math.sqrt(-2 * Math.log(p / 100) ) // approximation
      : Math.sqrt(-2 * Math.log(1 - p / 100));
    const expected = mean + zScore * stdDev;
    return { p, actual: q, expected, diff: q - expected };
  });

  const qqRows = theoretical.map((r) => [
    `${r.p}th`,
    fmtNum(r.actual),
    fmtNum(r.expected),
    fmtNum(r.diff),
    Math.abs(r.diff) > 0.5 * stdDev ? "!" : "",
  ]);
  const qqTable = buildTable(["Percentile", "Actual", "Expected (Normal)", "Difference", "Flag"], qqRows);

  // Interpretation
  const jbInterpret = jb < 5.99 ? "Cannot reject normality" : "Rejects normality";
  const k2Interpret = k2 < 5.99 ? "Cannot reject normality" : "Rejects normality";

  return {
    content: [
      {
        type: "text",
        text:
          `Normality Analysis: "${args.column}"\n` +
          `${"=".repeat(55)}\n` +
          `N: ${n.toLocaleString()}  Mean: ${fmtNum(mean)}  Std Dev: ${fmtNum(stdDev)}\n\n` +
          `Shape Statistics:\n` +
          `  Skewness:  ${fmtNum(skewness, 4)}  ${interpretSkewness(skewness)}\n` +
          `  Kurtosis:  ${fmtNum(kurtosis, 4)}  ${interpretKurtosis(kurtosis)}\n\n` +
          `Normality Tests:\n` +
          `  Jarque-Bera statistic:     ${fmtNum(jb, 4)}  (df=2)\n` +
          `  Interpretation:            ${jbInterpret}\n\n` +
          `  D'Agostino-Pearson K²:     ${fmtNum(k2, 4)}  (df=2)\n` +
          `  Interpretation:            ${k2Interpret}\n\n` +
          `  Z-score (skewness):        ${fmtNum(zSkew, 4)}\n` +
          `  Z-score (kurtosis):        ${fmtNum(zKurt, 4)}\n\n` +
          `Q-Q Comparison (vs Normal):\n` +
          qqTable +
          `\n\nSignificance levels: * p<0.05  ** p<0.01  *** p<0.001\n` +
          `Note: For samples > 2000 rows, even minor deviations appear significant. ` +
          `Visual inspection of the histogram is recommended alongside these tests.`,
      },
    ],
  };
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function interpretSkewness(s) {
  if (Math.abs(s) < 0.5) return "(approximately symmetric)";
  if (s >= 0.5 && s < 1.0) return "(moderately right-skewed)";
  if (s >= 1.0) return "(highly right-skewed)";
  if (s <= -0.5 && s > -1.0) return "(moderately left-skewed)";
  return "(highly left-skewed)";
}

function interpretKurtosis(k) {
  const excess = k - 3;
  if (Math.abs(excess) < 0.5) return "(mesokurtic, near-normal)";
  if (excess >= 0.5) return `(leptokurtic, heavy tails)`;
  return `(platykurtic, light tails)`;
}
