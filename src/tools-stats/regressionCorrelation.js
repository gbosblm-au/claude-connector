// tools/regressionCorrelation.js
// Correlation analysis and regression modelling:
//   - Pearson, Spearman, Kendall correlations + correlation matrix
//   - Simple linear, multiple linear, polynomial regression
//   - Logistic regression
//   - Regression diagnostics (residuals, VIF, heteroscedasticity)

import * as ss from "simple-statistics";
import { Matrix } from "ml-matrix";
import SLRpkg from "ml-regression-simple-linear";
const { default: SimpleLinearRegression } = SLRpkg.__esModule ? SLRpkg : { default: SLRpkg };
import MLRpkg from "ml-regression-multivariate-linear";
const MultivariateLinearRegression = MLRpkg.default || MLRpkg;
import { PolynomialRegression } from "ml-regression-polynomial";
import { getDataset, getNumericColumn, getCategoricalColumn, getNumericMatrix } from "../store/dataStore.js";
import { fmtNum, formatP, buildTable, kv, interpretCorrelation, interpretR2 } from "../utils/format.js";

// -----------------------------------------------------------------------
// Tool Definitions
// -----------------------------------------------------------------------

export const correlationToolDefinition = {
  name: "stats_correlation",
  description:
    "Computes a correlation matrix for multiple numeric columns. " +
    "Supports Pearson (linear), Spearman (rank-based, non-parametric), and Kendall correlations. " +
    "Includes p-values for each pair and highlights significant correlations.",
  inputSchema: {
    type: "object",
    properties: {
      dataset: { type: "string", description: "Dataset name." },
      columns: {
        type: "array",
        items: { type: "string" },
        description: "Numeric columns to correlate. Uses all numeric columns if omitted.",
      },
      method: {
        type: "string",
        description: "Correlation method: 'pearson' (default), 'spearman', or 'kendall'.",
        enum: ["pearson", "spearman", "kendall"],
      },
      min_abs: {
        type: "number",
        description: "Only show pairs with |correlation| >= this value (e.g. 0.3 to filter weak correlations).",
        minimum: 0, maximum: 1,
      },
    },
    required: ["dataset"],
  },
};

export const regressionToolDefinition = {
  name: "stats_regression",
  description:
    "Fits regression models: simple linear, multiple linear, polynomial, or logistic. " +
    "Returns coefficients, standard errors, t-statistics, p-values, R-squared, " +
    "adjusted R-squared, F-statistic, AIC/BIC, and residual diagnostics.",
  inputSchema: {
    type: "object",
    properties: {
      dataset: { type: "string", description: "Dataset name." },
      target: { type: "string", description: "Dependent variable (Y) column." },
      features: {
        type: "array",
        items: { type: "string" },
        description: "Independent variable (X) columns.",
      },
      type: {
        type: "string",
        description: "Regression type: 'linear' (simple or multiple), 'polynomial', or 'logistic'.",
        enum: ["linear", "polynomial", "logistic"],
      },
      degree: {
        type: "number",
        description: "Polynomial degree (only for type='polynomial', default 2).",
        minimum: 2, maximum: 10,
      },
      include_intercept: {
        type: "boolean",
        description: "Whether to include an intercept term. Default true.",
      },
    },
    required: ["dataset", "target", "features", "type"],
  },
};

export const partialCorrelationToolDefinition = {
  name: "stats_partial_correlation",
  description:
    "Computes the partial correlation between two variables controlling for one or more other variables. " +
    "Useful for isolating the relationship between two variables when others are confounded.",
  inputSchema: {
    type: "object",
    properties: {
      dataset: { type: "string", description: "Dataset name." },
      x: { type: "string", description: "First variable." },
      y: { type: "string", description: "Second variable." },
      controlling_for: {
        type: "array",
        items: { type: "string" },
        description: "Variables to control for.",
      },
    },
    required: ["dataset", "x", "y", "controlling_for"],
  },
};

// -----------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------

export async function handleCorrelation(args) {
  const ds = getDataset(args?.dataset);
  const method = args?.method || "pearson";
  const minAbs = args?.min_abs || 0;

  // Default to all numeric columns
  const colNames = args?.columns?.length
    ? args.columns
    : ds.columnMeta.filter((m) => m.type === "numeric").map((m) => m.name);

  if (colNames.length < 2) throw new Error("Need at least 2 numeric columns for correlation.");
  if (colNames.length > 30) throw new Error("Maximum 30 columns for correlation matrix.");

  // Get data arrays
  const data = colNames.map((c) => {
    const vals = getNumericColumn(ds, c).map(Number);
    return method === "spearman" ? rankTransform(vals) : vals;
  });

  // Build correlation matrix
  const n = colNames.length;
  const corrMatrix = Array.from({ length: n }, () => new Array(n).fill(0));
  const pMatrix = Array.from({ length: n }, () => new Array(n).fill(0));

  // Pairwise complete observations
  for (let i = 0; i < n; i++) {
    corrMatrix[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      // Get rows where both values are non-null
      const pairs = [];
      const rawI = ds.columns.get(colNames[i]);
      const rawJ = ds.columns.get(colNames[j]);
      for (let k = 0; k < ds.rowCount; k++) {
        const vi = rawI?.[k], vj = rawJ?.[k];
        if (vi !== null && vj !== null && !isNaN(Number(vi)) && !isNaN(Number(vj))) {
          pairs.push([Number(vi), Number(vj)]);
        }
      }

      let r;
      if (method === "kendall") {
        r = kendallTau(pairs.map(p => p[0]), pairs.map(p => p[1]));
      } else {
        // Pearson or Spearman (Spearman uses ranked data)
        const xi = method === "spearman" ? rankTransform(pairs.map(p => p[0])) : pairs.map(p => p[0]);
        const yi = method === "spearman" ? rankTransform(pairs.map(p => p[1])) : pairs.map(p => p[1]);
        r = pairs.length >= 3 ? ss.sampleCorrelation(xi, yi) : 0;
      }

      const nr = pairs.length;
      const tStat = r * Math.sqrt((nr - 2) / (1 - r * r));
      const p = 2 * (1 - tCdfApprox(Math.abs(tStat), nr - 2));

      corrMatrix[i][j] = corrMatrix[j][i] = r;
      pMatrix[i][j] = pMatrix[j][i] = p;
    }
  }

  // Format correlation matrix
  const shortNames = colNames.map((c) => c.slice(0, 12));
  const headerRow = ["", ...shortNames];
  const dataRows = corrMatrix.map((row, i) =>
    [colNames[i].slice(0, 20), ...row.map((r, j) => {
      if (i === j) return "1.000";
      const abs = Math.abs(r);
      if (abs < minAbs) return "-";
      const stars = pMatrix[i][j] < 0.001 ? "***" : pMatrix[i][j] < 0.01 ? "**" : pMatrix[i][j] < 0.05 ? "*" : "";
      return fmtNum(r, 3) + stars;
    })]
  );

  const table = buildTable(headerRow, dataRows);

  // Strong correlations list
  const strong = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const r = corrMatrix[i][j];
      if (Math.abs(r) >= Math.max(minAbs, 0.3)) {
        strong.push([colNames[i], colNames[j], fmtNum(r, 4), formatP(pMatrix[i][j]), interpretCorrelation(r)]);
      }
    }
  }
  strong.sort((a, b) => Math.abs(Number(b[2])) - Math.abs(Number(a[2])));

  const strongTable = strong.length > 0
    ? "\nNotable Correlations (|r| ≥ 0.3):\n" + buildTable(["Variable 1", "Variable 2", `${method[0].toUpperCase()} r`, "p-value", "Interpretation"], strong)
    : "";

  return {
    content: [
      {
        type: "text",
        text:
          `${method.charAt(0).toUpperCase() + method.slice(1)} Correlation Matrix\n` +
          `Dataset: "${ds.name}"  N cols: ${n}\n` +
          `Significance: * p<0.05  ** p<0.01  *** p<0.001\n\n` +
          table +
          strongTable,
      },
    ],
  };
}

// -----------------------------------------------------------------------

export async function handleRegression(args) {
  const ds = getDataset(args?.dataset);
  const type = args?.type || "linear";
  const includeIntercept = args?.include_intercept !== false;

  const yRaw = ds.columns.get(args.target);
  if (!yRaw) throw new Error(`Target column "${args.target}" not found.`);

  const features = args.features || [];
  if (features.length === 0) throw new Error("'features' must have at least one column.");

  // Get complete cases
  const rows = [];
  for (let i = 0; i < ds.rowCount; i++) {
    const y = yRaw[i];
    if (y === null || isNaN(Number(y))) continue;
    const xRow = features.map((f) => {
      const v = ds.columns.get(f)?.[i];
      return v === null ? null : Number(v);
    });
    if (xRow.some((v) => v === null || isNaN(v))) continue;
    rows.push({ y: Number(y), x: xRow });
  }

  const n = rows.length;
  if (n < features.length + 2) throw new Error(`Insufficient data (${n} complete rows, need at least ${features.length + 2}).`);

  const yArr = rows.map((r) => r.y);
  const xArr = rows.map((r) => r.x);

  if (type === "polynomial") {
    if (features.length !== 1) throw new Error("Polynomial regression requires exactly 1 feature column.");
    const degree = Math.min(args?.degree || 2, 10);
    const xFlat = xArr.map((r) => r[0]);
    const reg = new PolynomialRegression(xFlat, yArr, degree);
    const yPred = xFlat.map((x) => reg.predict(x));
    const { r2, adjR2, rss, tss, residuals } = computeRegressionStats(yArr, yPred, degree + 1);

    const coeffRows = reg.coefficients.map((c, i) => [
      i === 0 ? "Intercept" : `x^${i}`,
      fmtNum(c),
      "", "", ""
    ]);

    return {
      content: [
        {
          type: "text",
          text:
            `Polynomial Regression (degree=${degree})\n` +
            `Y: ${args.target}  X: ${features[0]}  N: ${n.toLocaleString()}\n` +
            `${"=".repeat(55)}\n` +
            buildTable(["Term", "Coefficient", "Std Error", "t-stat", "p-value"], coeffRows) + "\n\n" +
            kv("R-squared", fmtNum(r2) + `  (${interpretR2(r2)})`) + "\n" +
            kv("Adj R-squared", fmtNum(adjR2)) + "\n" +
            kv("Residual SS", fmtNum(rss)) + "\n" +
            kv("Total SS", fmtNum(tss)),
        },
      ],
    };
  }

  if (type === "logistic") {
    const result = fitLogisticRegression(xArr, yArr, includeIntercept);
    const paramNames = includeIntercept ? ["Intercept", ...features] : features;
    const coeffRows = result.coefficients.map((c, i) => [
      paramNames[i],
      fmtNum(c),
      fmtNum(result.stdErrors[i]),
      fmtNum(result.zStats[i]),
      formatP(result.pValues[i]),
      fmtNum(Math.exp(c), 4),
    ]);

    return {
      content: [
        {
          type: "text",
          text:
            `Logistic Regression\n` +
            `Y: ${args.target}  Features: ${features.join(", ")}  N: ${n.toLocaleString()}\n` +
            `${"=".repeat(60)}\n` +
            buildTable(["Term", "Coeff", "Std Error", "z-stat", "p-value", "Odds Ratio"], coeffRows) + "\n\n" +
            kv("Log-Likelihood", fmtNum(result.logLikelihood)) + "\n" +
            kv("AIC", fmtNum(result.aic)) + "\n" +
            kv("Pseudo R² (McFadden)", fmtNum(result.pseudoR2)) + "\n" +
            `\nNote: Significance: * p<0.05  ** p<0.01  *** p<0.001`,
        },
      ],
    };
  }

  // Linear regression (simple or multiple)
  if (features.length === 1) {
    const xFlat = xArr.map((r) => r[0]);
    const reg = new SimpleLinearRegression(xFlat, yArr);
    const yPred = xFlat.map((x) => reg.predict(x));
    const { r2, adjR2, rss, tss, mse, residuals } = computeRegressionStats(yArr, yPred, 2);
    const { slope, intercept } = reg;

    // Standard errors
    const sxx = ss.sum(xFlat.map((x) => Math.pow(x - ss.mean(xFlat), 2)));
    const slopeSe = Math.sqrt(mse / sxx);
    const interceptSe = Math.sqrt(mse * (1 / n + Math.pow(ss.mean(xFlat), 2) / sxx));
    const slopeT = slope / slopeSe;
    const interceptT = intercept / interceptSe;
    const slopeP = 2 * (1 - tCdfApprox(Math.abs(slopeT), n - 2));
    const interceptP = 2 * (1 - tCdfApprox(Math.abs(interceptT), n - 2));

    const f = (r2 / 1) / ((1 - r2) / (n - 2));
    const fP = fPValueApprox(f, 1, n - 2);

    return {
      content: [
        {
          type: "text",
          text:
            `Simple Linear Regression\n` +
            `Y: ${args.target}  X: ${features[0]}  N: ${n.toLocaleString()}\n` +
            `${"=".repeat(55)}\n` +
            `Equation: ${args.target} = ${fmtNum(intercept)} + ${fmtNum(slope)} * ${features[0]}\n\n` +
            buildTable(
              ["Term", "Coefficient", "Std Error", "t-stat", "p-value"],
              [
                ["Intercept", fmtNum(intercept), fmtNum(interceptSe), fmtNum(interceptT), formatP(interceptP)],
                [features[0], fmtNum(slope), fmtNum(slopeSe), fmtNum(slopeT), formatP(slopeP)],
              ]
            ) + "\n\n" +
            kv("R-squared", fmtNum(r2) + `  (${interpretR2(r2)})`) + "\n" +
            kv("Adj R-squared", fmtNum(adjR2)) + "\n" +
            kv("F-statistic", fmtNum(f) + `  (p=${formatP(fP)})`) + "\n" +
            kv("Root MSE", fmtNum(Math.sqrt(mse))) + "\n" +
            kv("RSS", fmtNum(rss)) + "\n" +
            kv("N", n.toLocaleString()),
        },
      ],
    };
  }

  // Multiple linear regression
  const Xmat = includeIntercept
    ? xArr.map((r) => [1, ...r])
    : xArr;
  const paramNames = includeIntercept ? ["Intercept", ...features] : features;

  const reg = new MultivariateLinearRegression(xArr, yArr.map((y) => [y]));
  const yPred = xArr.map((x) => reg.predict(x)[0]);
  const k = paramNames.length;
  const { r2, adjR2, rss, tss, mse } = computeRegressionStats(yArr, yPred, k);

  // Compute coefficient standard errors via (X'X)^-1 * MSE
  let seArr = new Array(k).fill(NaN);
  try {
    const Xm = new Matrix(Xmat);
    const XtX = Xm.transpose().mmul(Xm);
    const XtXinv = XtX.inverse();
    seArr = XtXinv.diagonal().map((d) => Math.sqrt(Math.abs(d) * mse));
  } catch { /* matrix may be singular */ }

  const coeffs = includeIntercept
    ? [reg.intercept[0], ...reg.weights.flat()]
    : reg.weights.flat();

  const tStats = coeffs.map((c, i) => c / (seArr[i] || 1));
  const pVals = tStats.map((t) => 2 * (1 - tCdfApprox(Math.abs(t), n - k)));

  const coeffRows = coeffs.map((c, i) => [
    paramNames[i],
    fmtNum(c),
    isNaN(seArr[i]) ? "N/A" : fmtNum(seArr[i]),
    isNaN(seArr[i]) ? "N/A" : fmtNum(tStats[i]),
    isNaN(seArr[i]) ? "N/A" : formatP(pVals[i]),
  ]);

  const f = (r2 / (k - 1)) / ((1 - r2) / (n - k));
  const fP = fPValueApprox(f, k - 1, n - k);

  // VIF for each feature
  const vifLines = [];
  if (features.length >= 2) {
    for (let i = 0; i < features.length; i++) {
      try {
        const otherX = xArr.map((r) => r.filter((_, j) => j !== i));
        const thisX = xArr.map((r) => [r[i]]);
        const vifReg = new MultivariateLinearRegression(otherX, thisX);
        const vifPred = otherX.map((x) => vifReg.predict(x)[0]);
        const vifR2 = computeRegressionStats(xArr.map((r) => r[i]), vifPred, features.length).r2;
        const vif = 1 / (1 - vifR2);
        vifLines.push(`  ${features[i].padEnd(25)} VIF = ${fmtNum(vif, 2)}  ${vif > 10 ? "(HIGH - multicollinearity)" : vif > 5 ? "(moderate)" : "(OK)"}`);
      } catch { vifLines.push(`  ${features[i]}: VIF calculation failed`); }
    }
  }

  return {
    content: [
      {
        type: "text",
        text:
          `Multiple Linear Regression\n` +
          `Y: ${args.target}  X: ${features.join(", ")}  N: ${n.toLocaleString()}\n` +
          `${"=".repeat(60)}\n` +
          buildTable(["Term", "Coefficient", "Std Error", "t-stat", "p-value"], coeffRows) + "\n\n" +
          kv("R-squared", fmtNum(r2) + `  (${interpretR2(r2)})`) + "\n" +
          kv("Adj R-squared", fmtNum(adjR2)) + "\n" +
          kv("F-statistic", fmtNum(f) + `  (p=${formatP(fP)})`) + "\n" +
          kv("Root MSE", fmtNum(Math.sqrt(mse))) + "\n" +
          kv("AIC", fmtNum(n * Math.log(rss / n) + 2 * k)) + "\n" +
          kv("BIC", fmtNum(n * Math.log(rss / n) + k * Math.log(n))) + "\n" +
          (vifLines.length ? "\nVariance Inflation Factors (multicollinearity):\n" + vifLines.join("\n") : "") +
          `\n\nSignificance: * p<0.05  ** p<0.01  *** p<0.001`,
      },
    ],
  };
}

// -----------------------------------------------------------------------

export async function handlePartialCorrelation(args) {
  const ds = getDataset(args?.dataset);
  const allCols = [args.x, args.y, ...(args.controlling_for || [])];
  const matrix = getNumericMatrix(ds, allCols);
  const n = matrix.length;
  if (n < allCols.length + 2) throw new Error("Insufficient complete observations.");

  // Partial correlation via residuals approach
  const xVals = matrix.map((r) => r[0]);
  const yVals = matrix.map((r) => r[1]);
  const zVals = matrix.map((r) => r.slice(2));

  const residX = computeResiduals(xVals, zVals);
  const residY = computeResiduals(yVals, zVals);

  const partR = ss.sampleCorrelation(residX, residY);
  const df = n - allCols.length;
  const tStat = partR * Math.sqrt(df / (1 - partR * partR));
  const p = 2 * (1 - tCdfApprox(Math.abs(tStat), df));

  return {
    content: [
      {
        type: "text",
        text:
          `Partial Correlation: ${args.x} ~ ${args.y} | ${args.controlling_for.join(", ")}\n` +
          `${"=".repeat(55)}\n` +
          kv("N (complete obs)", n.toLocaleString()) + "\n" +
          kv("Partial correlation r", fmtNum(partR)) + "\n" +
          kv("Degrees of freedom", df) + "\n" +
          kv("t-statistic", fmtNum(tStat)) + "\n" +
          kv("p-value", formatP(p)) + "\n" +
          kv("Interpretation", interpretCorrelation(partR)) + "\n\n" +
          `Note: Controls for: ${args.controlling_for.join(", ")}`,
      },
    ],
  };
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function computeRegressionStats(y, yPred, k) {
  const n = y.length;
  const meanY = ss.mean(y);
  const residuals = y.map((yi, i) => yi - yPred[i]);
  const rss = residuals.reduce((s, r) => s + r * r, 0);
  const tss = y.reduce((s, yi) => s + Math.pow(yi - meanY, 2), 0);
  const r2 = Math.max(0, 1 - rss / tss);
  const adjR2 = 1 - ((1 - r2) * (n - 1)) / (n - k);
  const mse = rss / (n - k);
  return { r2, adjR2, rss, tss, mse, residuals };
}

function rankTransform(arr) {
  const sorted = [...arr].map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(arr.length);
  for (let i = 0; i < sorted.length; i++) ranks[sorted[i][1]] = i + 1;
  return ranks;
}

function kendallTau(x, y) {
  const n = x.length;
  let concordant = 0, discordant = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = x[i] - x[j], dy = y[i] - y[j];
      if (dx * dy > 0) concordant++;
      else if (dx * dy < 0) discordant++;
    }
  }
  return (concordant - discordant) / (n * (n - 1) / 2);
}

function tCdfApprox(t, df) {
  if (df <= 0) return 0.5;
  const x = df / (df + t * t);
  let ib = incompleteBetaApprox(x, df / 2, 0.5);
  return 1 - ib / 2;
}

function incompleteBetaApprox(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (x > (a + 1) / (a + b + 2)) return 1 - incompleteBetaApprox(1 - x, b, a);
  const lbeta = lgamma(a) + lgamma(b) - lgamma(a + b);
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lbeta) / a;
  let c = 1, d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d; let h = d * front;
  for (let m = 1; m <= 100; m++) {
    let m2 = 2 * m;
    let aa = m * (b - m) * x / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < 1e-10) break;
  }
  return h;
}

function lgamma(z) {
  const coeffs = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = z, x = z, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const c of coeffs) { y++; ser += c / y; }
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

function fPValueApprox(F, df1, df2) {
  if (F <= 0) return 1;
  const x = df2 / (df2 + df1 * F);
  return incompleteBetaApprox(x, df2 / 2, df1 / 2);
}

function computeResiduals(y, X) {
  const n = y.length;
  if (X[0].length === 0) return y;
  const reg = new MultivariateLinearRegression(X, y.map(v => [v]));
  return y.map((yi, i) => yi - reg.predict(X[i])[0]);
}

function fitLogisticRegression(X, y, intercept = true) {
  const n = X.length;
  const p = X[0].length + (intercept ? 1 : 0);
  let beta = new Array(p).fill(0);

  // Newton-Raphson iterations
  for (let iter = 0; iter < 100; iter++) {
    const mu = X.map((x, i) => {
      const xb = (intercept ? beta[0] : 0) + x.reduce((s, xi, j) => s + xi * beta[j + (intercept ? 1 : 0)], 0);
      return 1 / (1 + Math.exp(-xb));
    });

    // Gradient
    const grad = new Array(p).fill(0);
    for (let i = 0; i < n; i++) {
      const r = y[i] - mu[i];
      if (intercept) grad[0] += r;
      for (let j = 0; j < X[i].length; j++) grad[j + (intercept ? 1 : 0)] += r * X[i][j];
    }

    // Hessian (diagonal approximation)
    const hess = new Array(p).fill(0);
    for (let i = 0; i < n; i++) {
      const w = mu[i] * (1 - mu[i]);
      if (intercept) hess[0] -= w;
      for (let j = 0; j < X[i].length; j++) hess[j + (intercept ? 1 : 0)] -= w * X[i][j] * X[i][j];
    }

    let maxDelta = 0;
    for (let j = 0; j < p; j++) {
      if (Math.abs(hess[j]) > 1e-10) {
        const delta = grad[j] / (-hess[j]);
        beta[j] += delta;
        maxDelta = Math.max(maxDelta, Math.abs(delta));
      }
    }
    if (maxDelta < 1e-6) break;
  }

  // Compute standard errors, z-stats, p-values
  const mu = X.map((x, i) => {
    const xb = (intercept ? beta[0] : 0) + x.reduce((s, xi, j) => s + xi * beta[j + (intercept ? 1 : 0)], 0);
    return 1 / (1 + Math.exp(-xb));
  });

  // Compute log-likelihood
  const logLikelihood = mu.reduce((sum, mui, i) => {
    return sum + y[i] * Math.log(Math.max(mui, 1e-15)) + (1 - y[i]) * Math.log(Math.max(1 - mui, 1e-15));
  }, 0);

  // Null log-likelihood
  const meanY = y.reduce((s, yi) => s + yi, 0) / n;
  const logLikNull = n * (meanY * Math.log(Math.max(meanY, 1e-15)) + (1 - meanY) * Math.log(Math.max(1 - meanY, 1e-15)));
  const pseudoR2 = 1 - logLikelihood / logLikNull;
  const aic = -2 * logLikelihood + 2 * p;

  // Fisher information for SEs
  const weights = mu.map(m => m * (1 - m));
  const seArr = new Array(p).fill(NaN);
  try {
    const Xmat = X.map((x) => intercept ? [1, ...x] : x);
    const Xm = new Matrix(Xmat);
    const W = Matrix.diagonal(weights);
    const XtWX = Xm.transpose().mmul(W).mmul(Xm);
    const XtWXinv = XtWX.inverse();
    for (let j = 0; j < p; j++) seArr[j] = Math.sqrt(Math.abs(XtWXinv.get(j, j)));
  } catch { /* singular matrix */ }

  const zStats = beta.map((b, i) => b / (seArr[i] || 1));
  const pValues = zStats.map((z) => 2 * (1 - normCdfApprox(Math.abs(z))));

  return { coefficients: beta, stdErrors: seArr, zStats, pValues, logLikelihood, aic, pseudoR2 };
}

function normCdfApprox(z) {
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989422820 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
  return 1 - p;
}
