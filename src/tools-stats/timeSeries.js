// tools/timeSeries.js
// Time series analysis: trend detection, seasonality, decomposition,
// moving averages, autocorrelation, stationarity, and forecasting.

import * as ss from "simple-statistics";
import { getDataset, getNumericColumn } from "../store/dataStore.js";
import { fmtNum, formatP, buildTable, kv, section } from "../utils/format.js";

// -----------------------------------------------------------------------
// Tool Definitions
// -----------------------------------------------------------------------

export const timeSeriesAnalyzeToolDefinition = {
  name: "ts_analyze",
  description:
    "Comprehensive time series analysis of a numeric column: " +
    "trend detection (linear, Mann-Kendall), stationarity (ADF approximation), " +
    "autocorrelation function (ACF), partial autocorrelation (PACF), " +
    "seasonality detection, and basic STL-style decomposition into trend/seasonal/residual components.",
  inputSchema: {
    type: "object",
    properties: {
      dataset: { type: "string", description: "Dataset name." },
      column: { type: "string", description: "Numeric column (time-ordered values)." },
      period: {
        type: "number",
        description: "Seasonal period (e.g. 12 for monthly, 4 for quarterly, 7 for daily with weekly seasonality). Auto-detected if omitted.",
        minimum: 2,
      },
      max_lags: {
        type: "number",
        description: "Maximum lags for ACF/PACF (default min(40, n/4)).",
        minimum: 1, maximum: 200,
      },
    },
    required: ["dataset", "column"],
  },
};

export const movingAverageToolDefinition = {
  name: "ts_moving_average",
  description:
    "Computes moving averages of a time series: simple moving average (SMA), " +
    "exponential moving average (EMA), and weighted moving average (WMA). " +
    "Stores the smoothed series as new columns in the dataset.",
  inputSchema: {
    type: "object",
    properties: {
      dataset: { type: "string", description: "Dataset name." },
      column: { type: "string", description: "Numeric column to smooth." },
      window: { type: "number", description: "Window size for SMA/WMA.", minimum: 2 },
      type: {
        type: "string",
        description: "MA type: 'sma' (simple), 'ema' (exponential), 'wma' (weighted). Default 'sma'.",
        enum: ["sma", "ema", "wma"],
      },
      alpha: {
        type: "number",
        description: "Smoothing factor for EMA (0-1, default 2/(window+1)).",
        minimum: 0.01, maximum: 0.99,
      },
    },
    required: ["dataset", "column", "window"],
  },
};

export const forecastToolDefinition = {
  name: "ts_forecast",
  description:
    "Forecasts future values of a time series using: " +
    "Holt-Winters exponential smoothing (handles trend + seasonality), " +
    "simple exponential smoothing (level only), or linear trend extrapolation. " +
    "Returns point forecasts and approximate prediction intervals.",
  inputSchema: {
    type: "object",
    properties: {
      dataset: { type: "string", description: "Dataset name." },
      column: { type: "string", description: "Numeric column to forecast." },
      periods: { type: "number", description: "Number of future periods to forecast.", minimum: 1, maximum: 100 },
      method: {
        type: "string",
        description: "'holt_winters' (trend+seasonal), 'ses' (simple exponential smoothing), 'linear_trend'. Default 'holt_winters'.",
        enum: ["holt_winters", "ses", "linear_trend"],
      },
      period: { type: "number", description: "Seasonal period for Holt-Winters (e.g. 12, 4, 7). Required for holt_winters.", minimum: 2 },
      alpha: { type: "number", description: "Level smoothing (0-1, auto-tuned if omitted).", minimum: 0.01, maximum: 0.99 },
      beta: { type: "number", description: "Trend smoothing (0-1).", minimum: 0.01, maximum: 0.99 },
      gamma: { type: "number", description: "Seasonal smoothing (0-1).", minimum: 0.01, maximum: 0.99 },
    },
    required: ["dataset", "column", "periods"],
  },
};

// -----------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------

export async function handleTimeSeriesAnalyze(args) {
  const ds = getDataset(args?.dataset);
  const vals = getNumericColumn(ds, args?.column).map(Number);
  const n = vals.length;
  if (n < 10) throw new Error(`Need at least 10 observations for time series analysis (have ${n}).`);

  const maxLags = args?.max_lags || Math.min(40, Math.floor(n / 4));

  // --- Trend Analysis ---
  const x = Array.from({ length: n }, (_, i) => i);
  const reg = simpleLinReg(x, vals);
  const trendPerPeriod = reg.slope;
  const totalChange = reg.slope * (n - 1);
  const trendR2 = reg.r2;

  // Mann-Kendall trend test
  const mk = mannKendall(vals);

  // --- Stationarity (ADF approximation) ---
  const diffs = vals.slice(1).map((v, i) => v - vals[i]);
  const adf = adfTest(vals);

  // --- ACF and PACF ---
  const acf = computeACF(vals, maxLags);
  const pacf = computePACF(vals, Math.min(maxLags, 20));
  const confBound = 1.96 / Math.sqrt(n);

  const acfRows = acf.slice(1, Math.min(21, acf.length)).map((r, i) => {
    const lag = i + 1;
    const bar = buildBar(r, 0.4, 20);
    const sig = Math.abs(r) > confBound ? "*" : "";
    return [lag, fmtNum(r, 4), sig, bar];
  });
  const acfTable = buildTable(["Lag", "ACF", "Sig", "Visual"], acfRows);

  const pacfRows = pacf.slice(1, Math.min(21, pacf.length)).map((r, i) => {
    const lag = i + 1;
    const bar = buildBar(r, 0.4, 20);
    const sig = Math.abs(r) > confBound ? "*" : "";
    return [lag, fmtNum(r, 4), sig, bar];
  });
  const pacfTable = buildTable(["Lag", "PACF", "Sig", "Visual"], pacfRows);

  // --- Seasonality detection ---
  const period = args?.period || detectPeriod(vals, acf);
  let seasonalInfo = `Auto-detected period: ${period}`;
  if (args?.period) seasonalInfo = `Specified period: ${period}`;

  // --- Basic stats ---
  const mean = ss.mean(vals);
  const stdDev = ss.standardDeviation(vals);
  const cv = (stdDev / Math.abs(mean)) * 100;

  // Ljung-Box test (portmanteau test for autocorrelation)
  const lbLag = Math.min(20, maxLags);
  const lb = ljungBox(acf.slice(1, lbLag + 1), n, lbLag);

  return {
    content: [
      {
        type: "text",
        text:
          `Time Series Analysis: "${args.column}"\n` +
          `${"=".repeat(60)}\n` +
          `N observations: ${n.toLocaleString()}\n\n` +

          section("Basic Statistics", 55) +
          kv("Mean", fmtNum(mean)) + "\n" +
          kv("Std Deviation", fmtNum(stdDev)) + "\n" +
          kv("Coeff of Variation", fmtNum(cv, 2) + "%") + "\n" +
          kv("Min / Max", `${fmtNum(Math.min(...vals))} / ${fmtNum(Math.max(...vals))}`) + "\n" +

          section("Trend Analysis", 55) +
          kv("Trend direction", trendPerPeriod > 0 ? "Upward" : trendPerPeriod < 0 ? "Downward" : "None") + "\n" +
          kv("Slope per period", fmtNum(trendPerPeriod)) + "\n" +
          kv("Total change", fmtNum(totalChange)) + "\n" +
          kv("Linear R²", fmtNum(trendR2)) + "\n\n" +
          `Mann-Kendall Trend Test:\n` +
          kv("  Tau", fmtNum(mk.tau)) + "\n" +
          kv("  p-value", formatP(mk.p)) + "\n" +
          kv("  Conclusion", mk.p < 0.05 ? (mk.tau > 0 ? "Significant upward trend" : "Significant downward trend") : "No significant trend") + "\n" +

          section("Stationarity", 55) +
          kv("ADF test statistic", fmtNum(adf.stat)) + "\n" +
          kv("Conclusion", adf.stat < -2.86 ? "Likely stationary" : "Likely non-stationary (consider differencing)") + "\n" +

          section("Seasonality", 55) +
          seasonalInfo + "\n" +

          section("Autocorrelation (ACF)", 55) +
          `Significance bounds: ±${fmtNum(confBound, 3)}  (* = significant)\n\n` +
          acfTable + "\n" +

          section("Partial Autocorrelation (PACF)", 55) +
          pacfTable + "\n" +

          section("Ljung-Box Test (Autocorrelation)", 55) +
          kv("Q statistic", fmtNum(lb.q)) + "\n" +
          kv("df", lbLag) + "\n" +
          kv("p-value", formatP(lb.p)) + "\n" +
          kv("Conclusion", lb.p < 0.05 ? "Significant autocorrelation present" : "No significant autocorrelation"),
      },
    ],
  };
}

// -----------------------------------------------------------------------

export async function handleMovingAverage(args) {
  const ds = getDataset(args?.dataset);
  const vals = getNumericColumn(ds, args?.column).map(Number);
  const n = vals.length;
  const window = Number(args.window);
  const type = args?.type || "sma";
  if (window >= n) throw new Error(`Window (${window}) must be less than series length (${n}).`);

  let smoothed;
  if (type === "ema") {
    const alpha = args?.alpha || (2 / (window + 1));
    smoothed = computeEMA(vals, alpha);
  } else if (type === "wma") {
    smoothed = computeWMA(vals, window);
  } else {
    smoothed = computeSMA(vals, window);
  }

  // Add to dataset
  const newColName = `${args.column}_${type}${window}`;
  ds.columns.set(newColName, smoothed);
  if (!ds.columnNames.includes(newColName)) ds.columnNames.push(newColName);
  ds.columnMeta.push({ name: newColName, type: "numeric", nullCount: smoothed.filter(v => v === null).length, uniqueCount: new Set(smoothed.filter(v => v !== null)).size });

  // Preview last 10 values
  const previewRows = [];
  const start = Math.max(0, n - 10);
  for (let i = start; i < n; i++) {
    previewRows.push([i + 1, fmtNum(vals[i]), smoothed[i] !== null ? fmtNum(smoothed[i]) : "N/A"]);
  }
  const previewTable = buildTable(["Index", "Original", `${type.toUpperCase()}(${window})`], previewRows);

  return {
    content: [
      {
        type: "text",
        text:
          `Moving Average: ${type.toUpperCase()}(${window}) applied to "${args.column}"\n` +
          `${"=".repeat(55)}\n` +
          `N values: ${n.toLocaleString()}\n` +
          `New column added: "${newColName}"\n` +
          `Null values at start: ${smoothed.filter(v => v === null).length}\n\n` +
          `Last 10 values:\n${previewTable}`,
      },
    ],
  };
}

// -----------------------------------------------------------------------

export async function handleForecast(args) {
  const ds = getDataset(args?.dataset);
  const vals = getNumericColumn(ds, args?.column).map(Number);
  const n = vals.length;
  const periods = Math.min(Number(args.periods) || 10, 100);
  const method = args?.method || "holt_winters";

  let forecasts, method_used, params_used;
  const insampleErrors = [];

  if (method === "linear_trend") {
    const x = Array.from({ length: n }, (_, i) => i);
    const reg = simpleLinReg(x, vals);
    forecasts = Array.from({ length: periods }, (_, i) => reg.intercept + reg.slope * (n + i));
    method_used = "Linear Trend Extrapolation";
    params_used = `slope=${fmtNum(reg.slope)}, R²=${fmtNum(reg.r2)}`;
    const fitted = x.map(xi => reg.intercept + reg.slope * xi);
    for (let i = 0; i < n; i++) insampleErrors.push(vals[i] - fitted[i]);
  } else if (method === "ses") {
    const alpha = args?.alpha || optimizeAlpha(vals);
    const result = ses(vals, alpha);
    forecasts = Array.from({ length: periods }, () => result.level);
    method_used = "Simple Exponential Smoothing";
    params_used = `alpha=${fmtNum(alpha)}`;
    insampleErrors.push(...result.residuals);
  } else {
    // Holt-Winters
    const period = args?.period;
    if (!period) throw new Error("'period' is required for Holt-Winters (e.g. 12 for monthly, 4 for quarterly).");
    const alpha = args?.alpha || 0.2;
    const beta = args?.beta || 0.1;
    const gamma = args?.gamma || 0.1;
    const result = holtWinters(vals, period, alpha, beta, gamma);
    forecasts = result.forecasts.slice(0, periods);
    method_used = "Holt-Winters Exponential Smoothing";
    params_used = `alpha=${alpha}, beta=${beta}, gamma=${gamma}, period=${period}`;
    insampleErrors.push(...result.residuals);
  }

  // Prediction intervals
  const rmse = Math.sqrt(ss.mean(insampleErrors.map(e => e * e)));
  const forecastRows = forecasts.map((f, i) => [
    `t+${i + 1}`,
    fmtNum(f),
    fmtNum(f - 1.645 * rmse),
    fmtNum(f + 1.645 * rmse),
    fmtNum(f - 1.960 * rmse),
    fmtNum(f + 1.960 * rmse),
  ]);

  const table = buildTable(
    ["Period", "Forecast", "90% Lower", "90% Upper", "95% Lower", "95% Upper"],
    forecastRows
  );

  return {
    content: [
      {
        type: "text",
        text:
          `Time Series Forecast: "${args.column}"\n` +
          `${"=".repeat(60)}\n` +
          `Method:    ${method_used}\n` +
          `Params:    ${params_used}\n` +
          `N history: ${n.toLocaleString()}\n` +
          `RMSE:      ${fmtNum(rmse)}\n\n` +
          table +
          `\nNote: Prediction intervals assume normally distributed errors. ` +
          `Actual uncertainty may be wider for longer horizons.`,
      },
    ],
  };
}

// -----------------------------------------------------------------------
// Time series algorithm implementations
// -----------------------------------------------------------------------

function computeACF(vals, maxLags) {
  const n = vals.length;
  const mean = ss.mean(vals);
  const variance = vals.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / n;
  const acf = [1];
  for (let lag = 1; lag <= maxLags; lag++) {
    let cov = 0;
    for (let t = lag; t < n; t++) cov += (vals[t] - mean) * (vals[t - lag] - mean);
    acf.push(cov / (n * variance));
  }
  return acf;
}

function computePACF(vals, maxLags) {
  const n = vals.length;
  const acf = computeACF(vals, maxLags);
  const pacf = [1];
  const phi = [];

  for (let k = 1; k <= maxLags; k++) {
    const phiK = [];
    if (k === 1) {
      phiK[0] = acf[1];
    } else {
      const prevPhi = phi[k - 2] || [];
      let num = acf[k];
      let den = 1;
      for (let j = 1; j < k; j++) {
        num -= prevPhi[j - 1] * acf[k - j];
        den -= prevPhi[j - 1] * acf[j];
      }
      phiK[k - 1] = den !== 0 ? num / den : 0;
      for (let j = 1; j < k; j++) {
        phiK[j - 1] = (prevPhi[j - 1] || 0) - phiK[k - 1] * (prevPhi[k - j - 1] || 0);
      }
    }
    phi.push(phiK);
    pacf.push(phiK[k - 1] || 0);
  }
  return pacf;
}

function mannKendall(vals) {
  const n = vals.length;
  let S = 0;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      const diff = vals[j] - vals[i];
      if (diff > 0) S++;
      else if (diff < 0) S--;
    }
  }
  const varS = (n * (n - 1) * (2 * n + 5)) / 18;
  const z = S > 0 ? (S - 1) / Math.sqrt(varS) : S < 0 ? (S + 1) / Math.sqrt(varS) : 0;
  const tau = S / (n * (n - 1) / 2);
  const p = 2 * (1 - normCdfApprox(Math.abs(z)));
  return { S, z, tau, p };
}

function adfTest(vals) {
  const n = vals.length;
  const diffs = vals.slice(1).map((v, i) => v - vals[i]);
  const laggedVals = vals.slice(0, n - 1);
  const reg = simpleLinReg(laggedVals, diffs);
  const stat = reg.slope / (reg.seSlope || 1);
  return { stat };
}

function ljungBox(acf, n, maxLag) {
  let Q = 0;
  for (let k = 1; k <= Math.min(maxLag, acf.length); k++) {
    Q += (acf[k - 1] * acf[k - 1]) / (n - k);
  }
  Q *= n * (n + 2);
  const p = 1 - gammaIncompleteApprox(maxLag / 2, Q / 2);
  return { q: Q, p };
}

function gammaIncompleteApprox(a, x) {
  if (x === 0) return 0;
  let sum = 1 / a, term = 1 / a;
  for (let i = 1; i < 100; i++) {
    term *= x / (a + i);
    sum += term;
    if (term < 1e-10) break;
  }
  return Math.min(1, sum * Math.exp(-x + a * Math.log(x) - lgammaApprox(a)));
}

function lgammaApprox(z) {
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  let x = z;
  let sum = c[0];
  for (let i = 1; i < g + 2; i++) sum += c[i] / (x + i);
  const t = x + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(sum / x);
}

function detectPeriod(vals, acf) {
  // Find first significant peak in ACF beyond lag 1
  for (let lag = 2; lag < Math.min(acf.length, 30); lag++) {
    if (acf[lag] > 0.3 && acf[lag] > acf[lag - 1] && acf[lag] > (acf[lag + 1] || 0)) {
      return lag;
    }
  }
  return 12; // default monthly
}

function computeSMA(vals, window) {
  return vals.map((_, i) => {
    if (i < window - 1) return null;
    return ss.mean(vals.slice(i - window + 1, i + 1));
  });
}

function computeEMA(vals, alpha) {
  const result = [vals[0]];
  for (let i = 1; i < vals.length; i++) {
    result.push(alpha * vals[i] + (1 - alpha) * result[i - 1]);
  }
  return result;
}

function computeWMA(vals, window) {
  const weights = Array.from({ length: window }, (_, i) => i + 1);
  const weightSum = weights.reduce((s, w) => s + w, 0);
  return vals.map((_, i) => {
    if (i < window - 1) return null;
    const slice = vals.slice(i - window + 1, i + 1);
    return slice.reduce((s, v, j) => s + v * weights[j], 0) / weightSum;
  });
}

function ses(vals, alpha) {
  const n = vals.length;
  const fitted = [vals[0]];
  const residuals = [0];
  let level = vals[0];
  for (let i = 1; i < n; i++) {
    const prev = level;
    level = alpha * vals[i] + (1 - alpha) * prev;
    fitted.push(prev);
    residuals.push(vals[i] - prev);
  }
  return { level, fitted, residuals };
}

function optimizeAlpha(vals) {
  let bestAlpha = 0.2, bestMSE = Infinity;
  for (let a = 0.05; a <= 0.95; a += 0.05) {
    const { residuals } = ses(vals, a);
    const mse = ss.mean(residuals.slice(1).map(r => r * r));
    if (mse < bestMSE) { bestMSE = mse; bestAlpha = a; }
  }
  return bestAlpha;
}

function holtWinters(vals, period, alpha, beta, gamma) {
  const n = vals.length;
  if (n < 2 * period) throw new Error(`Need at least ${2 * period} observations for Holt-Winters with period=${period}.`);

  // Initialization
  let level = ss.mean(vals.slice(0, period));
  let trend = (ss.mean(vals.slice(period, 2 * period)) - ss.mean(vals.slice(0, period))) / period;
  let seasonal = [];
  for (let i = 0; i < period; i++) {
    seasonal.push(vals[i] / (level || 1));
  }

  const fitted = [];
  const residuals = [];

  for (let t = 0; t < n; t++) {
    const s = seasonal[t % period];
    const forecast = (level + trend) * s;
    fitted.push(forecast);
    residuals.push(vals[t] - forecast);

    const prevLevel = level;
    level = alpha * (vals[t] / (s || 1)) + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
    seasonal[t % period] = gamma * (vals[t] / (level || 1)) + (1 - gamma) * s;
  }

  // Produce forecasts
  const forecasts = [];
  for (let h = 1; h <= 100; h++) {
    forecasts.push((level + h * trend) * seasonal[(n + h - 1) % period]);
  }

  return { fitted, residuals, forecasts };
}

function simpleLinReg(x, y) {
  const n = x.length;
  const meanX = ss.mean(x), meanY = ss.mean(y);
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += Math.pow(x[i] - meanX, 2);
    sxy += (x[i] - meanX) * (y[i] - meanY);
  }
  const slope = sxx !== 0 ? sxy / sxx : 0;
  const intercept = meanY - slope * meanX;
  const fitted = x.map(xi => intercept + slope * xi);
  const ss_res = y.reduce((s, yi, i) => s + Math.pow(yi - fitted[i], 2), 0);
  const ss_tot = y.reduce((s, yi) => s + Math.pow(yi - meanY, 2), 0);
  const r2 = ss_tot > 0 ? 1 - ss_res / ss_tot : 0;
  const mse = ss_res / (n - 2);
  const seSlope = sxx > 0 ? Math.sqrt(mse / sxx) : 0;
  return { slope, intercept, r2, mse, seSlope };
}

function buildBar(r, maxVal, width) {
  const normalized = Math.min(1, Math.abs(r) / maxVal);
  const len = Math.round(normalized * width);
  const half = Math.floor(width / 2);
  let bar;
  if (r >= 0) {
    bar = " ".repeat(half) + "#".repeat(len);
  } else {
    const spaces = Math.max(0, half - len);
    bar = " ".repeat(spaces) + "#".repeat(len);
  }
  return `|${bar.slice(0, width).padEnd(width)}|`;
}

function normCdfApprox(z) {
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989422820 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
  return 1 - p;
}
