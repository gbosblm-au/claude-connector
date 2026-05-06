// tools/inferentialStats.js
// Hypothesis tests, confidence intervals, ANOVA, and non-parametric tests.

import * as ss from "simple-statistics";
import { getDataset, getNumericColumn, getCategoricalColumn } from "../store/dataStore.js";
import { fmtNum, formatP, buildTable, kv, section, formatCI, interpretCohenD } from "../utils/format.js";

// -----------------------------------------------------------------------
// Tool Definitions
// -----------------------------------------------------------------------

export const tTestToolDefinition = {
  name: "stats_ttest",
  description:
    "Performs t-tests: one-sample (test if mean equals a value), " +
    "two-sample independent (compare means of two groups), or paired (compare matched pairs). " +
    "Returns test statistic, p-value, effect size (Cohen's d), and 95% confidence interval.",
  inputSchema: {
    type: "object",
    properties: {
      dataset: { type: "string", description: "Dataset name." },
      type: {
        type: "string",
        description: "Test type: 'one_sample', 'two_sample', or 'paired'.",
        enum: ["one_sample", "two_sample", "paired"],
      },
      column1: { type: "string", description: "Primary numeric column." },
      column2: { type: "string", description: "Second column (required for two_sample and paired tests)." },
      group_column: { type: "string", description: "Column defining groups for two_sample test (alternative to column2)." },
      group1: { type: "string", description: "Value of group_column for group 1." },
      group2: { type: "string", description: "Value of group_column for group 2." },
      mu: { type: "number", description: "Hypothesised mean for one_sample test (default 0)." },
      alternative: {
        type: "string",
        description: "Alternative hypothesis: 'two_sided', 'greater', or 'less'. Default 'two_sided'.",
        enum: ["two_sided", "greater", "less"],
      },
      alpha: { type: "number", description: "Significance level (default 0.05).", minimum: 0.001, maximum: 0.5 },
    },
    required: ["dataset", "type", "column1"],
  },
};

export const anovaToolDefinition = {
  name: "stats_anova",
  description:
    "Performs one-way ANOVA to test whether means differ across 3+ groups. " +
    "Returns F-statistic, p-value, effect size (eta-squared), and Tukey HSD post-hoc comparisons " +
    "identifying which specific groups differ significantly.",
  inputSchema: {
    type: "object",
    properties: {
      dataset: { type: "string", description: "Dataset name." },
      value_column: { type: "string", description: "Numeric column containing the values to compare." },
      group_column: { type: "string", description: "Categorical column defining the groups." },
      alpha: { type: "number", description: "Significance level (default 0.05).", minimum: 0.001, maximum: 0.5 },
    },
    required: ["dataset", "value_column", "group_column"],
  },
};

export const chiSquareToolDefinition = {
  name: "stats_chi_square",
  description:
    "Chi-square goodness of fit test: tests whether observed frequencies match expected proportions. " +
    "Or chi-square independence test between two categorical columns. " +
    "Also computes Cramer's V effect size.",
  inputSchema: {
    type: "object",
    properties: {
      dataset: { type: "string", description: "Dataset name." },
      type: {
        type: "string",
        description: "'goodness_of_fit' (one column vs expected distribution) or 'independence' (two columns).",
        enum: ["goodness_of_fit", "independence"],
      },
      column1: { type: "string", description: "First categorical column." },
      column2: { type: "string", description: "Second column (independence test only)." },
      expected_proportions: {
        type: "object",
        description: "For goodness_of_fit: map of category -> expected proportion (must sum to 1).",
        additionalProperties: { type: "number" },
      },
    },
    required: ["dataset", "type", "column1"],
  },
};

export const confidenceIntervalToolDefinition = {
  name: "stats_confidence_interval",
  description:
    "Computes confidence intervals for the mean of a numeric column. " +
    "Uses t-distribution (appropriate for any sample size). " +
    "Returns mean, standard error, margin of error, and lower/upper bounds for 90%, 95%, and 99% CI.",
  inputSchema: {
    type: "object",
    properties: {
      dataset: { type: "string", description: "Dataset name." },
      column: { type: "string", description: "Numeric column name." },
      confidence: { type: "number", description: "Confidence level 0-100 (default 95).", minimum: 50, maximum: 99.9 },
    },
    required: ["dataset", "column"],
  },
};

export const mannWhitneyToolDefinition = {
  name: "stats_mann_whitney",
  description:
    "Mann-Whitney U test (non-parametric alternative to independent t-test). " +
    "Tests whether two independent groups have the same distribution. " +
    "Appropriate when normality cannot be assumed. Also computes rank-biserial correlation effect size.",
  inputSchema: {
    type: "object",
    properties: {
      dataset: { type: "string", description: "Dataset name." },
      column: { type: "string", description: "Numeric column." },
      group_column: { type: "string", description: "Column defining two groups." },
      group1: { type: "string", description: "Value for group 1." },
      group2: { type: "string", description: "Value for group 2." },
    },
    required: ["dataset", "column", "group_column", "group1", "group2"],
  },
};

export const proportionTestToolDefinition = {
  name: "stats_proportion_test",
  description:
    "Tests whether a proportion equals a hypothesised value (one-sample) " +
    "or whether two proportions differ (two-sample). " +
    "Uses Z-test for proportions with continuity correction.",
  inputSchema: {
    type: "object",
    properties: {
      dataset: { type: "string", description: "Dataset name." },
      column: { type: "string", description: "Column containing binary/boolean or 0/1 values." },
      success_value: { type: "string", description: "Value to count as 'success' (default '1' or 'true')." },
      p0: { type: "number", description: "Hypothesised proportion for one-sample test.", minimum: 0, maximum: 1 },
      group_column: { type: "string", description: "Column defining two groups for two-sample test." },
      group1: { type: "string", description: "Group 1 value." },
      group2: { type: "string", description: "Group 2 value." },
    },
    required: ["dataset", "column"],
  },
};

// -----------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------

export async function handleTTest(args) {
  const ds = getDataset(args?.dataset);
  const alpha = args?.alpha || 0.05;
  const alt = args?.alternative || "two_sided";
  const type = args?.type;

  let x, y, mu;
  let label1 = args.column1, label2 = "";

  if (type === "one_sample") {
    x = getNumericColumn(ds, args.column1).map(Number);
    mu = args?.mu ?? 0;
    label2 = `mu = ${mu}`;
  } else if (type === "two_sample") {
    if (args?.group_column) {
      const groupCol = getCategoricalColumn(ds, args.group_column);
      const valueCol = ds.columns.get(args.column1);
      x = []; y = [];
      for (let i = 0; i < ds.rowCount; i++) {
        const g = groupCol[i], v = valueCol?.[i];
        if (v === null || isNaN(Number(v))) continue;
        if (String(g) === String(args.group1)) x.push(Number(v));
        else if (String(g) === String(args.group2)) y.push(Number(v));
      }
      label1 = `${args.column1}[${args.group1}]`;
      label2 = `${args.column1}[${args.group2}]`;
    } else {
      x = getNumericColumn(ds, args.column1).map(Number);
      y = getNumericColumn(ds, args.column2).map(Number);
      label2 = args.column2;
    }
  } else if (type === "paired") {
    const col1 = ds.columns.get(args.column1);
    const col2 = ds.columns.get(args.column2);
    if (!col2) throw new Error("'column2' is required for paired test.");
    x = []; y = [];
    for (let i = 0; i < ds.rowCount; i++) {
      const v1 = col1?.[i], v2 = col2?.[i];
      if (v1 !== null && v2 !== null && !isNaN(Number(v1)) && !isNaN(Number(v2))) {
        x.push(Number(v1));
        y.push(Number(v2));
      }
    }
    label2 = args.column2;
  } else {
    throw new Error("type must be 'one_sample', 'two_sample', or 'paired'.");
  }

  // Compute t-statistic
  let t, df, n1, n2, mean1, mean2, se, pooledSd;

  if (type === "one_sample") {
    n1 = x.length;
    mean1 = ss.mean(x);
    const sd = ss.standardDeviation(x);
    se = sd / Math.sqrt(n1);
    t = (mean1 - (mu ?? 0)) / se;
    df = n1 - 1;
    pooledSd = sd;
    mean2 = mu ?? 0;
  } else if (type === "paired") {
    const diffs = x.map((xi, i) => xi - y[i]);
    n1 = diffs.length;
    mean1 = ss.mean(diffs);
    const sd = ss.standardDeviation(diffs);
    se = sd / Math.sqrt(n1);
    t = mean1 / se;
    df = n1 - 1;
    pooledSd = sd;
    mean2 = 0;
    label1 = `${label1} - ${label2} (differences)`;
    label2 = "";
  } else {
    n1 = x.length; n2 = y.length;
    mean1 = ss.mean(x); mean2 = ss.mean(y);
    const s1 = ss.standardDeviation(x), s2 = ss.standardDeviation(y);
    // Welch's t-test (unequal variances)
    const se1 = Math.pow(s1, 2) / n1, se2 = Math.pow(s2, 2) / n2;
    se = Math.sqrt(se1 + se2);
    t = (mean1 - mean2) / se;
    df = Math.pow(se1 + se2, 2) /
      (Math.pow(se1, 2) / (n1 - 1) + Math.pow(se2, 2) / (n2 - 1));
    pooledSd = Math.sqrt(((n1 - 1) * Math.pow(s1, 2) + (n2 - 1) * Math.pow(s2, 2)) / (n1 + n2 - 2));
  }

  // P-value using t-distribution (approximation)
  const p = tPValue(Math.abs(t), df, alt);

  // Cohen's d effect size
  const d = type === "one_sample"
    ? (mean1 - (mu ?? 0)) / pooledSd
    : type === "paired"
    ? t / Math.sqrt(n1)
    : (mean1 - mean2) / pooledSd;

  // 95% CI for difference
  const tCrit = tCritical(df, 0.025);
  const ciLower = (type === "one_sample" ? mean1 : mean1 - mean2) - tCrit * se;
  const ciUpper = (type === "one_sample" ? mean1 : mean1 - mean2) + tCrit * se;

  const conclusion = p < alpha
    ? `REJECT H₀ (p=${formatP(p)} < α=${alpha})`
    : `FAIL TO REJECT H₀ (p=${formatP(p)} >= α=${alpha})`;

  const lines = [
    `T-Test: ${type.replace("_", "-")}`,
    `${"=".repeat(50)}`,
    type !== "one_sample" ? `Group 1 (${label1}): n=${n1?.toLocaleString()}, mean=${fmtNum(mean1)}` : `Sample (${label1}): n=${n1?.toLocaleString()}, mean=${fmtNum(mean1)}`,
    type === "two_sample" ? `Group 2 (${label2}): n=${n2?.toLocaleString()}, mean=${fmtNum(mean2)}` : (type === "one_sample" ? `Hypothesised mean: ${fmtNum(mean2)}` : ""),
    ``,
    kv("t-statistic", fmtNum(t)),
    kv("Degrees of freedom", fmtNum(df, 2)),
    kv("p-value", formatP(p)),
    kv("Cohen's d", `${fmtNum(d)}  (${interpretCohenD(d)} effect)`),
    kv("95% CI", formatCI(ciLower, ciUpper)),
    kv("Standard Error", fmtNum(se)),
    ``,
    kv("H₀", type === "one_sample" ? `mean = ${mu ?? 0}` : type === "paired" ? "mean difference = 0" : "mean1 = mean2"),
    kv("H₁", type === "one_sample" ? `mean ${altSymbol(alt)} ${mu ?? 0}` : type === "paired" ? `mean difference ${altSymbol(alt)} 0` : `mean1 ${altSymbol(alt)} mean2`),
    kv("Alpha", alpha),
    kv("Conclusion", conclusion),
  ].filter(Boolean).join("\n");

  return { content: [{ type: "text", text: lines }] };
}

// -----------------------------------------------------------------------

export async function handleAnova(args) {
  const ds = getDataset(args?.dataset);
  const alpha = args?.alpha || 0.05;

  const valueCol = ds.columns.get(args.value_column);
  const groupCol = getCategoricalColumn(ds, args.group_column);
  if (!valueCol) throw new Error(`Column "${args.value_column}" not found.`);

  // Group data
  const groups = new Map();
  for (let i = 0; i < ds.rowCount; i++) {
    const g = groupCol[i], v = valueCol[i];
    if (g === null || v === null || isNaN(Number(v))) continue;
    const key = String(g);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(Number(v));
  }

  if (groups.size < 2) throw new Error("ANOVA requires at least 2 groups.");

  const groupNames = [...groups.keys()].sort();
  const groupData = groupNames.map((g) => groups.get(g));
  const allVals = groupData.flat();
  const grandMean = ss.mean(allVals);
  const N = allVals.length;
  const k = groups.size;

  // SS calculations
  const ssBetween = groupData.reduce((sum, g) => {
    const ni = g.length, gMean = ss.mean(g);
    return sum + ni * Math.pow(gMean - grandMean, 2);
  }, 0);

  const ssWithin = groupData.reduce((sum, g) => {
    const gMean = ss.mean(g);
    return sum + g.reduce((s, v) => s + Math.pow(v - gMean, 2), 0);
  }, 0);

  const dfBetween = k - 1;
  const dfWithin = N - k;
  const msBetween = ssBetween / dfBetween;
  const msWithin = ssWithin / dfWithin;
  const F = msBetween / msWithin;

  // P-value (F distribution approximation)
  const p = fPValue(F, dfBetween, dfWithin);

  // Eta-squared (effect size)
  const eta2 = ssBetween / (ssBetween + ssWithin);

  // Group summary table
  const groupRows = groupData.map((g, i) => [
    groupNames[i],
    g.length.toLocaleString(),
    fmtNum(ss.mean(g)),
    fmtNum(ss.standardDeviation(g)),
    fmtNum(Math.sqrt(ss.variance(g) / g.length)),
  ]);
  const groupTable = buildTable(["Group", "N", "Mean", "Std Dev", "Std Error"], groupRows);

  // ANOVA table
  const anovaRows = [
    ["Between Groups", fmtNum(ssBetween), dfBetween, fmtNum(msBetween), fmtNum(F), formatP(p)],
    ["Within Groups", fmtNum(ssWithin), dfWithin, fmtNum(msWithin), "", ""],
    ["Total", fmtNum(ssBetween + ssWithin), N - 1, "", "", ""],
  ];
  const anovaTable = buildTable(
    ["Source", "SS", "df", "MS", "F", "p-value"],
    anovaRows
  );

  // Tukey HSD post-hoc (if significant)
  let postHoc = "";
  if (p < alpha) {
    const qCrit = tukeyQ(k, dfWithin, alpha); // approximate
    const hsd = qCrit * Math.sqrt(msWithin / (N / k));
    const comparisons = [];
    for (let i = 0; i < groupNames.length; i++) {
      for (let j = i + 1; j < groupNames.length; j++) {
        const diff = Math.abs(ss.mean(groupData[i]) - ss.mean(groupData[j]));
        const sig = diff > hsd ? "* Significant" : "  Not significant";
        comparisons.push([
          `${groupNames[i]} vs ${groupNames[j]}`,
          fmtNum(ss.mean(groupData[i]) - ss.mean(groupData[j])),
          fmtNum(diff),
          fmtNum(hsd, 4),
          sig,
        ]);
      }
    }
    const phTable = buildTable(
      ["Comparison", "Mean Diff", "|Diff|", "HSD Critical", "Decision"],
      comparisons
    );
    postHoc = `\nTukey HSD Post-hoc Tests (α=${alpha}):\n${phTable}`;
  }

  return {
    content: [
      {
        type: "text",
        text:
          `One-Way ANOVA: ${args.value_column} by ${args.group_column}\n` +
          `${"=".repeat(60)}\n` +
          `Group Summary:\n${groupTable}\n\n` +
          `ANOVA Table:\n${anovaTable}\n\n` +
          kv("F-statistic", fmtNum(F)) + "\n" +
          kv("p-value", formatP(p)) + "\n" +
          kv("Eta-squared (η²)", fmtNum(eta2) + `  (${interpretEta2(eta2)})`) + "\n" +
          kv("Conclusion", p < alpha ? `REJECT H₀: at least one group mean differs` : `FAIL TO REJECT H₀: no significant difference`) +
          postHoc,
      },
    ],
  };
}

// -----------------------------------------------------------------------

export async function handleChiSquare(args) {
  const ds = getDataset(args?.dataset);
  const type = args?.type || "independence";

  if (type === "goodness_of_fit") {
    const col = getCategoricalColumn(ds, args.column1).filter((v) => v !== null);
    const freq = new Map();
    for (const v of col) freq.set(v, (freq.get(v) || 0) + 1);
    const total = col.length;
    const expected = args?.expected_proportions || {};

    // Default to uniform if no expected given
    const cats = [...freq.keys()];
    const expProps = Object.keys(expected).length > 0 ? expected
      : Object.fromEntries(cats.map((c) => [c, 1 / cats.length]));

    let chi2 = 0, df = cats.length - 1;
    const rows = cats.map((cat) => {
      const obs = freq.get(cat) || 0;
      const prop = expProps[cat] || 0;
      const exp = total * prop;
      const contrib = exp > 0 ? Math.pow(obs - exp, 2) / exp : 0;
      chi2 += contrib;
      return [cat, obs.toLocaleString(), fmtNum(exp), fmtNum(prop * 100, 1) + "%", fmtNum(contrib)];
    });

    const p = chiSquarePValue(chi2, df);
    const table = buildTable(["Category", "Observed", "Expected", "Expected%", "Chi2 Contrib"], rows);

    return {
      content: [
        {
          type: "text",
          text:
            `Chi-Square Goodness of Fit: "${args.column1}"\n` +
            `${"=".repeat(55)}\n` +
            table + "\n\n" +
            kv("Chi2 statistic", fmtNum(chi2)) + "\n" +
            kv("df", df) + "\n" +
            kv("p-value", formatP(p)) + "\n" +
            kv("Conclusion", p < 0.05 ? "Significant deviation from expected distribution" : "No significant deviation"),
        },
      ],
    };
  } else {
    // Independence
    if (!args?.column2) throw new Error("'column2' is required for independence test.");
    const rowVals = getCategoricalColumn(ds, args.column1);
    const colVals = getCategoricalColumn(ds, args.column2);
    const rowCats = [...new Set(rowVals.filter((v) => v !== null))].sort();
    const colCats = [...new Set(colVals.filter((v) => v !== null))].sort();

    const counts = {};
    for (const r of rowCats) { counts[r] = {}; for (const c of colCats) counts[r][c] = 0; }
    let total = 0;
    for (let i = 0; i < ds.rowCount; i++) {
      const r = rowVals[i], c = colVals[i];
      if (r !== null && c !== null && counts[r]?.[c] !== undefined) { counts[r][c]++; total++; }
    }

    const rowTotals = Object.fromEntries(rowCats.map((r) => [r, colCats.reduce((s, c) => s + counts[r][c], 0)]));
    const colTotals = Object.fromEntries(colCats.map((c) => [c, rowCats.reduce((s, r) => s + counts[r][c], 0)]));

    let chi2 = 0;
    for (const r of rowCats) {
      for (const c of colCats) {
        const exp = (rowTotals[r] * colTotals[c]) / total;
        if (exp > 0) chi2 += Math.pow(counts[r][c] - exp, 2) / exp;
      }
    }

    const df = (rowCats.length - 1) * (colCats.length - 1);
    const p = chiSquarePValue(chi2, df);
    const cramersV = Math.sqrt(chi2 / (total * Math.min(rowCats.length - 1, colCats.length - 1)));

    return {
      content: [
        {
          type: "text",
          text:
            `Chi-Square Independence: "${args.column1}" x "${args.column2}"\n` +
            `${"=".repeat(55)}\n` +
            kv("N", total.toLocaleString()) + "\n" +
            kv("Chi2 statistic", fmtNum(chi2)) + "\n" +
            kv("df", df) + "\n" +
            kv("p-value", formatP(p)) + "\n" +
            kv("Cramer's V", fmtNum(cramersV) + `  (${interpretCramersV(cramersV)})`) + "\n" +
            kv("Conclusion", p < 0.05 ? "Significant association between variables" : "No significant association"),
        },
      ],
    };
  }
}

// -----------------------------------------------------------------------

export async function handleConfidenceInterval(args) {
  const ds = getDataset(args?.dataset);
  const vals = getNumericColumn(ds, args?.column).map(Number);
  const n = vals.length;
  if (n < 2) throw new Error("Need at least 2 observations.");

  const mean = ss.mean(vals);
  const stdDev = ss.standardDeviation(vals);
  const se = stdDev / Math.sqrt(n);
  const df = n - 1;

  const levels = [90, 95, 99];
  const rows = levels.map((level) => {
    const alpha = 1 - level / 100;
    const tCrit = tCritical(df, alpha / 2);
    const margin = tCrit * se;
    return [
      `${level}%`,
      fmtNum(tCrit),
      fmtNum(margin),
      fmtNum(mean - margin),
      fmtNum(mean + margin),
    ];
  });

  const table = buildTable(["Confidence", "t Critical", "Margin of Error", "Lower Bound", "Upper Bound"], rows);

  return {
    content: [
      {
        type: "text",
        text:
          `Confidence Intervals: "${args?.column}"\n` +
          `${"=".repeat(55)}\n` +
          kv("N", n.toLocaleString()) + "\n" +
          kv("Mean", fmtNum(mean)) + "\n" +
          kv("Std Deviation", fmtNum(stdDev)) + "\n" +
          kv("Std Error", fmtNum(se)) + "\n" +
          kv("df", df) + "\n\n" +
          table,
      },
    ],
  };
}

// -----------------------------------------------------------------------

export async function handleMannWhitney(args) {
  const ds = getDataset(args?.dataset);
  const groupCol = getCategoricalColumn(ds, args.group_column);
  const valueCol = ds.columns.get(args.column);

  const x = [], y = [];
  for (let i = 0; i < ds.rowCount; i++) {
    const g = groupCol[i], v = valueCol?.[i];
    if (v === null || isNaN(Number(v))) continue;
    if (String(g) === String(args.group1)) x.push(Number(v));
    else if (String(g) === String(args.group2)) y.push(Number(v));
  }

  if (x.length < 2 || y.length < 2) throw new Error("Each group must have at least 2 values.");

  const n1 = x.length, n2 = y.length;
  const N = n1 + n2;

  // Compute U statistic
  let u1 = 0;
  for (const xi of x) {
    for (const yi of y) {
      if (xi > yi) u1++;
      else if (xi === yi) u1 += 0.5;
    }
  }
  const u2 = n1 * n2 - u1;
  const U = Math.min(u1, u2);

  // Normal approximation for large samples
  const meanU = (n1 * n2) / 2;
  const sdU = Math.sqrt((n1 * n2 * (N + 1)) / 12);
  const z = (U - meanU) / sdU;
  const p = 2 * (1 - normCdf(Math.abs(z)));

  // Effect size: rank-biserial correlation
  const rRbc = 1 - (2 * U) / (n1 * n2);

  return {
    content: [
      {
        type: "text",
        text:
          `Mann-Whitney U Test: ${args.column}\n` +
          `${"=".repeat(50)}\n` +
          kv(`Group ${args.group1}`, `n=${n1}, median=${fmtNum(ss.median(x))}`) + "\n" +
          kv(`Group ${args.group2}`, `n=${n2}, median=${fmtNum(ss.median(y))}`) + "\n\n" +
          kv("U statistic", fmtNum(U)) + "\n" +
          kv("Z score", fmtNum(z)) + "\n" +
          kv("p-value (2-sided)", formatP(p)) + "\n" +
          kv("Rank-biserial r", fmtNum(rRbc)) + "\n\n" +
          kv("Conclusion", p < 0.05 ? "Significant difference in distributions" : "No significant difference"),
      },
    ],
  };
}

// -----------------------------------------------------------------------

export async function handleProportionTest(args) {
  const ds = getDataset(args?.dataset);
  const col = ds.columns.get(args.column);
  if (!col) throw new Error(`Column "${args.column}" not found.`);
  const successVal = String(args?.success_value ?? "1").toLowerCase();

  if (args?.group_column) {
    // Two-sample
    const groupCol = getCategoricalColumn(ds, args.group_column);
    let n1 = 0, k1 = 0, n2 = 0, k2 = 0;
    for (let i = 0; i < ds.rowCount; i++) {
      const g = String(groupCol[i]), v = String(col[i]).toLowerCase();
      if (g === String(args.group1)) { n1++; if (v === successVal || v === "true") k1++; }
      else if (g === String(args.group2)) { n2++; if (v === successVal || v === "true") k2++; }
    }
    const p1 = k1 / n1, p2 = k2 / n2;
    const pPool = (k1 + k2) / (n1 + n2);
    const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
    const z = (p1 - p2) / se;
    const p = 2 * (1 - normCdf(Math.abs(z)));

    return {
      content: [
        {
          type: "text",
          text:
            `Two-Sample Proportion Test: ${args.column}\n${"=".repeat(50)}\n` +
            kv(`Group ${args.group1}`, `n=${n1}, successes=${k1}, p̂=${fmtNum(p1)}`) + "\n" +
            kv(`Group ${args.group2}`, `n=${n2}, successes=${k2}, p̂=${fmtNum(p2)}`) + "\n\n" +
            kv("Difference (p1-p2)", fmtNum(p1 - p2)) + "\n" +
            kv("Z statistic", fmtNum(z)) + "\n" +
            kv("p-value", formatP(p)) + "\n" +
            kv("Conclusion", p < 0.05 ? "Significant difference in proportions" : "No significant difference"),
        },
      ],
    };
  } else {
    // One-sample
    const p0 = args?.p0 ?? 0.5;
    let n = 0, k = 0;
    for (const v of col) {
      if (v !== null) { n++; if (String(v).toLowerCase() === successVal || String(v).toLowerCase() === "true") k++; }
    }
    const pHat = k / n;
    const se = Math.sqrt(p0 * (1 - p0) / n);
    const z = (pHat - p0) / se;
    const p = 2 * (1 - normCdf(Math.abs(z)));
    const ciLower = pHat - 1.96 * Math.sqrt(pHat * (1 - pHat) / n);
    const ciUpper = pHat + 1.96 * Math.sqrt(pHat * (1 - pHat) / n);

    return {
      content: [
        {
          type: "text",
          text:
            `One-Sample Proportion Test: ${args.column}\n${"=".repeat(50)}\n` +
            kv("N", n.toLocaleString()) + "\n" +
            kv("Successes", k.toLocaleString()) + "\n" +
            kv("Observed proportion (p̂)", fmtNum(pHat)) + "\n" +
            kv("Hypothesised proportion", fmtNum(p0)) + "\n\n" +
            kv("Z statistic", fmtNum(z)) + "\n" +
            kv("p-value", formatP(p)) + "\n" +
            kv("95% CI", formatCI(ciLower, ciUpper)) + "\n" +
            kv("Conclusion", p < 0.05 ? "Proportion differs significantly from p₀" : "No significant difference from p₀"),
        },
      ],
    };
  }
}

// -----------------------------------------------------------------------
// Statistical distribution helpers (pure JS implementations)
// -----------------------------------------------------------------------

function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422820 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
  return z > 0 ? 1 - p : p;
}

function tCritical(df, alpha) {
  // Approximation using Hill (1970) inverse t
  if (df >= 1000) return 1.96; // z-approximation
  // Common values lookup for common df
  const a = alpha; // two-tailed alpha/2
  // Newton-Raphson on t CDF
  let t = 2.0;
  for (let i = 0; i < 50; i++) {
    const cdf = tCdf(t, df);
    const pdf = tPdf(t, df);
    const delta = (cdf - (1 - a)) / pdf;
    t -= delta;
    if (Math.abs(delta) < 1e-8) break;
  }
  return t;
}

function tPdf(t, df) {
  const logBeta = logGamma((df + 1) / 2) - logGamma(df / 2) - 0.5 * Math.log(Math.PI * df);
  return Math.exp(logBeta - ((df + 1) / 2) * Math.log(1 + t * t / df));
}

function tCdf(t, df) {
  const x = df / (df + t * t);
  return 1 - 0.5 * incompleteBeta(x, df / 2, 0.5);
}

function tPValue(t, df, alt = "two_sided") {
  const p1 = 1 - tCdf(Math.abs(t), df);
  if (alt === "two_sided") return Math.min(1, 2 * p1);
  if (alt === "greater") return t >= 0 ? p1 : 1 - p1;
  return t <= 0 ? p1 : 1 - p1;
}

function fPValue(F, df1, df2) {
  if (F <= 0) return 1;
  return incompleteBeta(df2 / (df2 + df1 * F), df2 / 2, df1 / 2);
}

function chiSquarePValue(chi2, df) {
  return 1 - gammaIncomplete(df / 2, chi2 / 2);
}

function gammaIncomplete(a, x) {
  if (x < 0 || a <= 0) return 0;
  if (x === 0) return 0;
  // Series expansion
  let sum = 1 / a, term = 1 / a;
  for (let i = 1; i < 200; i++) {
    term *= x / (a + i);
    sum += term;
    if (Math.abs(term) < 1e-10 * Math.abs(sum)) break;
  }
  return Math.min(1, sum * Math.exp(-x + a * Math.log(x) - logGamma(a)));
}

function incompleteBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  // Continued fraction
  const lbeta = logGamma(a) + logGamma(b) - logGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta);
  return front * betaCF(x, a, b) / a;
}

function betaCF(x, a, b) {
  let qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 100; m++) {
    let m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-10) break;
  }
  return h;
}

function logGamma(z) {
  const coeffs = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = z, x = z, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const c of coeffs) { y++; ser += c / y; }
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

function tukeyQ(k, df, alpha) {
  // Approximate critical value for Tukey HSD
  // Using simple approximation
  const qTable = {
    2: { 5: 3.64, 10: 3.15, 20: 2.95, 30: 2.89, Inf: 2.77 },
    3: { 5: 4.60, 10: 3.88, 20: 3.58, 30: 3.49, Inf: 3.31 },
    4: { 5: 5.22, 10: 4.33, 20: 3.96, 30: 3.85, Inf: 3.63 },
    5: { 5: 5.67, 10: 4.65, 20: 4.23, 30: 4.10, Inf: 3.86 },
    6: { 5: 6.03, 10: 4.91, 20: 4.45, 30: 4.30, Inf: 4.03 },
  };
  const kKey = Math.min(k, 6);
  const dfKey = df >= 30 ? "Inf" : df >= 20 ? 20 : df >= 10 ? 10 : 5;
  return qTable[kKey]?.[dfKey] || 4.0;
}

function altSymbol(alt) {
  if (alt === "greater") return ">";
  if (alt === "less") return "<";
  return "≠";
}

function interpretEta2(e) {
  if (e >= 0.14) return "large effect";
  if (e >= 0.06) return "medium effect";
  return "small effect";
}

function interpretCramersV(v) {
  if (v >= 0.5) return "strong association";
  if (v >= 0.3) return "moderate association";
  if (v >= 0.1) return "weak association";
  return "negligible association";
}
