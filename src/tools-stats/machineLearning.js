// tools/machineLearning.js
// Machine learning methods:
//   - K-Means clustering
//   - Hierarchical clustering (agglomerative)
//   - Principal Component Analysis (PCA)
//   - K-Nearest Neighbours (KNN) classifier
//   - Naive Bayes classifier
//   - Decision Tree (CART approximation)
//   - Isolation Forest (anomaly detection)
//   - Feature importance (variance, mutual information)

import * as ss from "simple-statistics";
import { kmeans as KMeans } from "ml-kmeans";
import { PCA } from "ml-pca";
import { Matrix } from "ml-matrix";
import { getDataset, getNumericMatrix, getCategoricalColumn, storeDataset } from "../store/dataStore.js";
import { fmtNum, buildTable, kv, section } from "../utils/format.js";

// -----------------------------------------------------------------------
// Tool Definitions
// -----------------------------------------------------------------------

export const kmeansToolDefinition = {
  name: "ml_kmeans",
  description:
    "K-Means clustering: partitions data into K groups based on feature similarity. " +
    "Returns cluster assignments, centroids, within-cluster sum of squares, silhouette score, " +
    "and elbow method analysis for choosing optimal K. " +
    "Cluster assignments are stored as a new column in the dataset.",
  inputSchema: {
    type: "object",
    properties: {
      dataset: { type: "string", description: "Dataset name." },
      columns: { type: "array", items: { type: "string" }, description: "Numeric columns to cluster on." },
      k: { type: "number", description: "Number of clusters. If omitted, elbow method tested for k=2..8.", minimum: 2, maximum: 20 },
      max_iter: { type: "number", description: "Maximum iterations (default 300).", minimum: 10, maximum: 1000 },
      seed: { type: "number", description: "Random seed for reproducibility." },
      output_column: { type: "string", description: "Name for the cluster assignment column (default 'cluster_kmeans')." },
      scale: { type: "boolean", description: "Whether to standardise features before clustering (recommended, default true)." },
    },
    required: ["dataset", "columns"],
  },
};

export const pcaToolDefinition = {
  name: "ml_pca",
  description:
    "Principal Component Analysis: reduces dimensionality while preserving maximum variance. " +
    "Returns eigenvalues, eigenvectors (loadings), explained variance per component, " +
    "cumulative variance, and optionally stores the projected dataset as new columns.",
  inputSchema: {
    type: "object",
    properties: {
      dataset: { type: "string", description: "Dataset name." },
      columns: { type: "array", items: { type: "string" }, description: "Numeric columns to include." },
      n_components: { type: "number", description: "Number of principal components to retain (default: all).", minimum: 1 },
      scale: { type: "boolean", description: "Standardise features (recommended, default true)." },
      store_projection: { type: "boolean", description: "Store PC scores as new columns in the dataset (default true)." },
    },
    required: ["dataset", "columns"],
  },
};

export const knnToolDefinition = {
  name: "ml_knn",
  description:
    "K-Nearest Neighbours classifier with cross-validation. " +
    "Predicts a categorical target from numeric features using k nearest training examples. " +
    "Returns accuracy, precision, recall, F1-score, and confusion matrix.",
  inputSchema: {
    type: "object",
    properties: {
      dataset: { type: "string", description: "Dataset name." },
      features: { type: "array", items: { type: "string" }, description: "Numeric feature columns." },
      target: { type: "string", description: "Categorical target column." },
      k: { type: "number", description: "Number of neighbours (default 5).", minimum: 1, maximum: 50 },
      cv_folds: { type: "number", description: "Cross-validation folds (default 5).", minimum: 2, maximum: 10 },
      scale: { type: "boolean", description: "Standardise features (recommended, default true)." },
    },
    required: ["dataset", "features", "target"],
  },
};

export const naiveBayesToolDefinition = {
  name: "ml_naive_bayes",
  description:
    "Gaussian Naive Bayes classifier: fast probabilistic classifier assuming feature independence. " +
    "Returns accuracy, class-level precision/recall/F1, feature likelihoods, and confusion matrix.",
  inputSchema: {
    type: "object",
    properties: {
      dataset: { type: "string", description: "Dataset name." },
      features: { type: "array", items: { type: "string" }, description: "Numeric feature columns." },
      target: { type: "string", description: "Categorical target column." },
      cv_folds: { type: "number", description: "Cross-validation folds (default 5).", minimum: 2, maximum: 10 },
    },
    required: ["dataset", "features", "target"],
  },
};

export const anomalyDetectionToolDefinition = {
  name: "ml_anomaly_detection",
  description:
    "Detects anomalies/outliers in numeric data using multiple methods: " +
    "Z-score (statistical outliers), IQR fence method, Isolation Forest approximation, " +
    "and Mahalanobis distance for multivariate outliers. " +
    "Stores anomaly flags as a new column.",
  inputSchema: {
    type: "object",
    properties: {
      dataset: { type: "string", description: "Dataset name." },
      columns: { type: "array", items: { type: "string" }, description: "Columns to check for anomalies." },
      method: {
        type: "string",
        description: "'zscore' (|z|>3), 'iqr' (1.5*IQR fence), 'isolation_forest', 'mahalanobis', or 'ensemble' (all methods, flag if 2+ agree).",
        enum: ["zscore", "iqr", "isolation_forest", "mahalanobis", "ensemble"],
      },
      threshold: { type: "number", description: "Detection threshold (z-score: default 3.0, contamination for IF: default 0.05)." },
      output_column: { type: "string", description: "Column name for anomaly flags (default 'is_anomaly')." },
    },
    required: ["dataset", "columns", "method"],
  },
};

export const featureImportanceToolDefinition = {
  name: "ml_feature_importance",
  description:
    "Assesses which features (columns) are most predictive of a target variable. " +
    "Uses variance analysis, correlation with target, mutual information approximation, " +
    "and univariate F-test. Ranks features by importance score.",
  inputSchema: {
    type: "object",
    properties: {
      dataset: { type: "string", description: "Dataset name." },
      features: { type: "array", items: { type: "string" }, description: "Numeric feature columns to evaluate." },
      target: { type: "string", description: "Target column (numeric or categorical)." },
    },
    required: ["dataset", "features", "target"],
  },
};

// -----------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------

export async function handleKMeans(args) {
  const ds = getDataset(args?.dataset);
  const cols = args?.columns || [];
  if (cols.length < 1) throw new Error("At least one column required.");

  const matrix = getNumericMatrix(ds, cols);
  const n = matrix.length;
  if (n < 4) throw new Error(`Need at least 4 complete rows (have ${n}).`);

  const doScale = args?.scale !== false;
  const { scaled, means: colMeans, stds: colStds } = scaleMatrix(matrix, doScale);

  const outCol = args?.output_column || "cluster_kmeans";

  // If k not specified, run elbow method k=2..8
  if (!args?.k) {
    const elbowData = [];
    for (let k = 2; k <= Math.min(8, Math.floor(n / 2)); k++) {
      const result = KMeans(scaled, k, { seed: args?.seed || 42 });
      const wcss = computeWCSS(scaled, result.clusters, k);
      elbowData.push([k, fmtNum(wcss), fmtNum(computeSilhouette(scaled, result.clusters, k))]);
    }
    const elbowTable = buildTable(["K", "WCSS", "Silhouette Score"], elbowData);
    return {
      content: [
        {
          type: "text",
          text:
            `K-Means Elbow Analysis (k=2..${elbowData.length + 1})\n` +
            `Dataset: "${ds.name}"  N: ${n.toLocaleString()}  Features: ${cols.join(", ")}\n\n` +
            elbowTable +
            `\n\nTip: Higher silhouette score = better separation. ` +
            `Look for the "elbow" in WCSS where improvement slows. ` +
            `Run again with your chosen k to get cluster assignments.`,
        },
      ],
    };
  }

  const k = Number(args.k);
  const result = KMeans(scaled, k, {
    seed: args?.seed || 42,
    maxIterations: args?.max_iter || 300,
  });

  const wcss = computeWCSS(scaled, result.clusters, k);
  const silhouette = computeSilhouette(scaled, result.clusters, k);

  // Map cluster assignments back to original rows (including null rows)
  const clusterAssignments = new Array(ds.rowCount).fill(null);
  let completeIdx = 0;
  for (let i = 0; i < ds.rowCount; i++) {
    const vals = cols.map((c) => ds.columns.get(c)?.[i]);
    if (vals.every((v) => v !== null && !isNaN(Number(v)))) {
      clusterAssignments[i] = result.clusters[completeIdx++];
    }
  }

  // Store cluster assignments
  ds.columns.set(outCol, clusterAssignments);
  if (!ds.columnNames.includes(outCol)) ds.columnNames.push(outCol);

  // Cluster summary
  const clusterRows = [];
  for (let c = 0; c < k; c++) {
    const memberIndices = result.clusters.map((cl, i) => cl === c ? i : -1).filter(i => i >= 0);
    const size = memberIndices.length;
    const centroid = result.centroids[c].map((v, fi) => {
      // Unscale centroid
      return doScale ? v * (colStds[fi] || 1) + colMeans[fi] : v;
    });
    clusterRows.push([
      `Cluster ${c}`,
      size.toLocaleString(),
      fmtNum((size / n) * 100, 1) + "%",
      centroid.map(v => fmtNum(v, 3)).join(", "),
    ]);
  }

  const clusterTable = buildTable(["Cluster", "Size", "Proportion", `Centroid [${cols.join(", ")}]`], clusterRows);

  return {
    content: [
      {
        type: "text",
        text:
          `K-Means Clustering (k=${k})\n` +
          `Dataset: "${ds.name}"  N: ${n.toLocaleString()}  Features: ${cols.join(", ")}\n` +
          `Scaling: ${doScale ? "yes (standardised)" : "no"}\n` +
          `${"=".repeat(60)}\n` +
          clusterTable + "\n\n" +
          kv("WCSS (inertia)", fmtNum(wcss)) + "\n" +
          kv("Silhouette score", fmtNum(silhouette) + `  ${interpretSilhouette(silhouette)}`) + "\n" +
          kv("Cluster column added", `"${outCol}"`),
      },
    ],
  };
}

// -----------------------------------------------------------------------

export async function handlePCA(args) {
  const ds = getDataset(args?.dataset);
  const cols = args?.columns || [];
  if (cols.length < 2) throw new Error("PCA requires at least 2 columns.");

  const matrix = getNumericMatrix(ds, cols);
  const n = matrix.length;
  if (n < cols.length) throw new Error(`Need at least ${cols.length} complete rows (have ${n}).`);

  const doScale = args?.scale !== false;
  const nComponents = Math.min(args?.n_components || cols.length, cols.length, n - 1);

  const pca = new PCA(matrix, { center: true, scale: doScale });
  const eigenvalues = pca.getEigenvalues();
  const cumVar = eigenvalues.map((_, i) => eigenvalues.slice(0, i + 1).reduce((s, v) => s + v, 0));
  const totalVar = eigenvalues.reduce((s, v) => s + v, 0);

  const explainedVar = eigenvalues.map(v => (v / totalVar) * 100);
  const cumExplained = cumVar.map(v => (v / totalVar) * 100);

  // Loadings
  const loadings = pca.getLoadings().to2DArray();

  // Variance table
  const varRows = eigenvalues.slice(0, nComponents).map((ev, i) => [
    `PC${i + 1}`,
    fmtNum(ev, 4),
    fmtNum(explainedVar[i], 2) + "%",
    fmtNum(cumExplained[i], 2) + "%",
  ]);
  const varTable = buildTable(["Component", "Eigenvalue", "Explained %", "Cumulative %"], varRows);

  // Loadings table
  const loadingRows = cols.map((col, ci) =>
    [col, ...loadings.slice(0, nComponents).map(pc => fmtNum(pc[ci], 4))]
  );
  const loadingHeaders = ["Variable", ...Array.from({ length: nComponents }, (_, i) => `PC${i + 1}`)];
  const loadingTable = buildTable(loadingHeaders, loadingRows);

  // Store projections
  if (args?.store_projection !== false) {
    const projected = pca.predict(matrix);
    const projArray = projected.to2DArray();
    for (let i = 0; i < nComponents; i++) {
      const colName = `PC${i + 1}`;
      const vals = new Array(ds.rowCount).fill(null);
      let idx = 0;
      for (let row = 0; row < ds.rowCount; row++) {
        const rowVals = cols.map(c => ds.columns.get(c)?.[row]);
        if (rowVals.every(v => v !== null && !isNaN(Number(v)))) {
          vals[row] = projArray[idx++][i];
        }
      }
      ds.columns.set(colName, vals);
      if (!ds.columnNames.includes(colName)) ds.columnNames.push(colName);
    }
  }

  // Kaiser criterion: components with eigenvalue > 1
  const kaiserCount = eigenvalues.filter(ev => ev > 1).length;
  // 80% variance threshold
  const threshold80 = cumExplained.findIndex(cv => cv >= 80) + 1;

  return {
    content: [
      {
        type: "text",
        text:
          `Principal Component Analysis\n` +
          `Dataset: "${ds.name}"  N: ${n.toLocaleString()}  Variables: ${cols.length}\n` +
          `Scaling: ${doScale ? "yes (standardised)" : "no"}\n` +
          `${"=".repeat(60)}\n\n` +
          `Explained Variance:\n${varTable}\n\n` +
          `Factor Loadings:\n${loadingTable}\n\n` +
          `Selection guidance:\n` +
          `  Kaiser criterion (eigenvalue > 1): retain ${kaiserCount} component${kaiserCount !== 1 ? "s" : ""}\n` +
          `  80% variance threshold: retain ${threshold80 || nComponents} component${threshold80 !== 1 ? "s" : ""}\n\n` +
          (args?.store_projection !== false ? `PC scores stored as columns: ${Array.from({ length: nComponents }, (_, i) => `PC${i + 1}`).join(", ")}` : ""),
      },
    ],
  };
}

// -----------------------------------------------------------------------

export async function handleKNN(args) {
  const ds = getDataset(args?.dataset);
  const k = args?.k || 5;
  const folds = args?.cv_folds || 5;
  const doScale = args?.scale !== false;

  const matrix = getNumericMatrix(ds, args.features);
  const targetRaw = getCategoricalColumn(ds, args.target);

  // Align target with complete rows
  const data = [];
  let idx = 0;
  for (let i = 0; i < ds.rowCount; i++) {
    const vals = args.features.map(f => ds.columns.get(f)?.[i]);
    if (vals.every(v => v !== null && !isNaN(Number(v))) && targetRaw[i] !== null) {
      data.push({ x: matrix[idx++], y: String(targetRaw[i]) });
    }
  }

  const n = data.length;
  if (n < k + 1) throw new Error(`Need at least ${k + 1} complete rows (have ${n}).`);

  const classes = [...new Set(data.map(d => d.y))].sort();

  // Cross-validation
  const foldSize = Math.floor(n / folds);
  const allPredictions = [];
  const allActuals = [];

  // Scale globally for fair CV
  const { scaled: scaledAll, means, stds } = scaleMatrix(data.map(d => d.x), doScale);

  for (let fold = 0; fold < folds; fold++) {
    const testStart = fold * foldSize;
    const testEnd = fold === folds - 1 ? n : (fold + 1) * foldSize;

    const trainX = [], trainY = [], testX = [], testY = [];
    for (let i = 0; i < n; i++) {
      if (i >= testStart && i < testEnd) {
        testX.push(scaledAll[i]);
        testY.push(data[i].y);
      } else {
        trainX.push(scaledAll[i]);
        trainY.push(data[i].y);
      }
    }

    for (const tx of testX) {
      const dists = trainX.map((trx, i) => ({
        dist: euclidean(tx, trx),
        label: trainY[i],
      })).sort((a, b) => a.dist - b.dist);

      const topK = dists.slice(0, k);
      const votes = {};
      for (const { label } of topK) votes[label] = (votes[label] || 0) + 1;
      allPredictions.push(Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0]);
    }
    allActuals.push(...testY);
  }

  const metrics = computeClassificationMetrics(allActuals, allPredictions, classes);

  return {
    content: [
      {
        type: "text",
        text:
          `KNN Classifier (k=${k}, ${folds}-fold CV)\n` +
          `Dataset: "${ds.name}"  N: ${n.toLocaleString()}\n` +
          `Features: ${args.features.join(", ")}\n` +
          `Target: ${args.target}  Classes: ${classes.join(", ")}\n` +
          `${"=".repeat(60)}\n\n` +
          `Overall Accuracy: ${fmtNum(metrics.accuracy * 100, 2)}%\n\n` +
          `Per-Class Metrics:\n` +
          buildTable(
            ["Class", "Precision", "Recall", "F1 Score", "Support"],
            classes.map(c => [c, fmtNum(metrics.precision[c] || 0, 4), fmtNum(metrics.recall[c] || 0, 4), fmtNum(metrics.f1[c] || 0, 4), metrics.support[c] || 0])
          ) + "\n\n" +
          `Confusion Matrix:\n` +
          buildTable(
            ["Actual \\ Pred", ...classes],
            classes.map(actual => [actual, ...classes.map(pred => metrics.confMatrix[actual]?.[pred] || 0)])
          ),
      },
    ],
  };
}

// -----------------------------------------------------------------------

export async function handleNaiveBayes(args) {
  const ds = getDataset(args?.dataset);
  const folds = args?.cv_folds || 5;

  const matrix = getNumericMatrix(ds, args.features);
  const targetRaw = getCategoricalColumn(ds, args.target);

  const data = [];
  let idx = 0;
  for (let i = 0; i < ds.rowCount; i++) {
    const vals = args.features.map(f => ds.columns.get(f)?.[i]);
    if (vals.every(v => v !== null && !isNaN(Number(v))) && targetRaw[i] !== null) {
      data.push({ x: matrix[idx++], y: String(targetRaw[i]) });
    }
  }

  const n = data.length;
  const classes = [...new Set(data.map(d => d.y))].sort();

  // Cross-validation
  const foldSize = Math.floor(n / folds);
  const allPredictions = [];
  const allActuals = [];

  for (let fold = 0; fold < folds; fold++) {
    const testStart = fold * foldSize;
    const testEnd = fold === folds - 1 ? n : (fold + 1) * foldSize;

    const train = data.filter((_, i) => i < testStart || i >= testEnd);
    const test = data.filter((_, i) => i >= testStart && i < testEnd);

    // Fit Gaussian NB on training data
    const model = fitGaussianNB(train, classes, args.features.length);

    // Predict test data
    for (const { x } of test) {
      allPredictions.push(predictGaussianNB(model, x, classes));
    }
    allActuals.push(...test.map(d => d.y));
  }

  const metrics = computeClassificationMetrics(allActuals, allPredictions, classes);

  // Feature importance (show per-class means)
  const fullModel = fitGaussianNB(data, classes, args.features.length);
  const featureRows = args.features.map((f, fi) => [
    f,
    ...classes.map(c => fmtNum(fullModel.means[c]?.[fi] || 0, 4)),
  ]);

  return {
    content: [
      {
        type: "text",
        text:
          `Gaussian Naive Bayes (${folds}-fold CV)\n` +
          `Dataset: "${ds.name}"  N: ${n.toLocaleString()}\n` +
          `Features: ${args.features.join(", ")}\n` +
          `Target: ${args.target}  Classes: ${classes.join(", ")}\n` +
          `${"=".repeat(60)}\n\n` +
          `Overall Accuracy: ${fmtNum(metrics.accuracy * 100, 2)}%\n\n` +
          `Per-Class Metrics:\n` +
          buildTable(
            ["Class", "Precision", "Recall", "F1 Score", "Support"],
            classes.map(c => [c, fmtNum(metrics.precision[c] || 0, 4), fmtNum(metrics.recall[c] || 0, 4), fmtNum(metrics.f1[c] || 0, 4), metrics.support[c] || 0])
          ) + "\n\n" +
          `Feature Means by Class:\n` +
          buildTable(["Feature", ...classes], featureRows) + "\n\n" +
          `Confusion Matrix:\n` +
          buildTable(
            ["Actual \\ Pred", ...classes],
            classes.map(actual => [actual, ...classes.map(pred => metrics.confMatrix[actual]?.[pred] || 0)])
          ),
      },
    ],
  };
}

// -----------------------------------------------------------------------

export async function handleAnomalyDetection(args) {
  const ds = getDataset(args?.dataset);
  const cols = args?.columns || [];
  const method = args?.method || "zscore";
  const outCol = args?.output_column || "is_anomaly";
  const threshold = args?.threshold;

  const anomalyFlags = new Array(ds.rowCount).fill(0);

  if (method === "zscore" || method === "ensemble") {
    const zThresh = threshold || 3.0;
    for (const col of cols) {
      const vals = ds.columns.get(col) || [];
      const numeric = vals.filter(v => v !== null && !isNaN(Number(v))).map(Number);
      const mean = ss.mean(numeric);
      const std = ss.standardDeviation(numeric);
      vals.forEach((v, i) => {
        if (v !== null && !isNaN(Number(v))) {
          if (Math.abs((Number(v) - mean) / (std || 1)) > zThresh) anomalyFlags[i]++;
        }
      });
    }
  }

  if (method === "iqr" || method === "ensemble") {
    for (const col of cols) {
      const vals = ds.columns.get(col) || [];
      const numeric = vals.filter(v => v !== null && !isNaN(Number(v))).map(Number).sort((a, b) => a - b);
      const q1 = ss.quantile(numeric, 0.25);
      const q3 = ss.quantile(numeric, 0.75);
      const iqr = q3 - q1;
      const lo = q1 - 1.5 * iqr, hi = q3 + 1.5 * iqr;
      vals.forEach((v, i) => {
        if (v !== null && !isNaN(Number(v))) {
          if (Number(v) < lo || Number(v) > hi) anomalyFlags[i]++;
        }
      });
    }
  }

  if (method === "mahalanobis" || method === "ensemble") {
    try {
      const matrix = [];
      const validIdx = [];
      for (let i = 0; i < ds.rowCount; i++) {
        const row = cols.map(c => ds.columns.get(c)?.[i]);
        if (row.every(v => v !== null && !isNaN(Number(v)))) {
          matrix.push(row.map(Number));
          validIdx.push(i);
        }
      }
      if (matrix.length >= cols.length + 2) {
        const mDists = mahalanobisDistances(matrix);
        const critValue = threshold || (cols.length + 3 * Math.sqrt(2 * cols.length));
        mDists.forEach((d, j) => { if (d > critValue) anomalyFlags[validIdx[j]]++; });
      }
    } catch { /* singular matrix - skip */ }
  }

  if (method === "isolation_forest" || method === "ensemble") {
    const contamination = threshold || 0.05;
    const matrix = [];
    const validIdx = [];
    for (let i = 0; i < ds.rowCount; i++) {
      const row = cols.map(c => ds.columns.get(c)?.[i]);
      if (row.every(v => v !== null && !isNaN(Number(v)))) {
        matrix.push(row.map(Number));
        validIdx.push(i);
      }
    }
    const scores = isolationForestScores(matrix);
    const threshold_score = ss.quantile(scores.slice().sort((a, b) => b - a), contamination);
    scores.forEach((s, j) => { if (s >= threshold_score) anomalyFlags[validIdx[j]]++; });
  }

  // Apply threshold for ensemble
  const minVotes = method === "ensemble" ? 2 : 1;
  const finalFlags = anomalyFlags.map(f => f >= minVotes ? 1 : 0);

  // Store results
  ds.columns.set(outCol, finalFlags);
  if (!ds.columnNames.includes(outCol)) ds.columnNames.push(outCol);

  const totalAnomalies = finalFlags.reduce((s, v) => s + v, 0);
  const rate = (totalAnomalies / ds.rowCount) * 100;

  // Summary of anomalous rows
  const anomalyIndices = finalFlags.map((f, i) => f === 1 ? i : -1).filter(i => i >= 0).slice(0, 20);
  const previewCols = cols.slice(0, 5);
  const previewRows = anomalyIndices.map(i =>
    [i + 1, ...previewCols.map(c => fmtNum(ds.columns.get(c)?.[i], 4))]
  );

  return {
    content: [
      {
        type: "text",
        text:
          `Anomaly Detection (method: ${method})\n` +
          `Dataset: "${ds.name}"  N: ${ds.rowCount.toLocaleString()}\n` +
          `Columns: ${cols.join(", ")}\n` +
          `${"=".repeat(55)}\n` +
          kv("Total anomalies", `${totalAnomalies.toLocaleString()} (${fmtNum(rate, 2)}%)`) + "\n" +
          kv("Normal observations", `${(ds.rowCount - totalAnomalies).toLocaleString()}`) + "\n" +
          kv("Anomaly column added", `"${outCol}"`) + "\n\n" +
          (previewRows.length > 0 ?
            `First ${previewRows.length} anomalous rows:\n` +
            buildTable(["Row", ...previewCols], previewRows) : "No anomalies detected."),
      },
    ],
  };
}

// -----------------------------------------------------------------------

export async function handleFeatureImportance(args) {
  const ds = getDataset(args?.dataset);
  const features = args.features;
  const targetMeta = ds.columnMeta.find(m => m.name === args.target);
  const targetIsNumeric = targetMeta?.type === "numeric";

  const scores = [];

  for (const feat of features) {
    const featVals = ds.columns.get(feat)?.filter((v, i) => {
      const t = ds.columns.get(args.target)?.[i];
      return v !== null && !isNaN(Number(v)) && t !== null;
    }).map(Number) || [];

    const targetVals = ds.columns.get(args.target)?.filter((v, i) => {
      const f = ds.columns.get(feat)?.[i];
      return v !== null && f !== null && !isNaN(Number(f));
    }) || [];

    if (featVals.length < 5) { scores.push({ feat, score: 0, method: "insufficient data" }); continue; }

    let score = 0, method = "";

    if (targetIsNumeric) {
      const numTarget = targetVals.map(Number);
      // Pearson correlation
      const r = Math.abs(ss.sampleCorrelation(featVals, numTarget));
      // Mutual information approximation
      const mi = approxMutualInfo(featVals, numTarget);
      score = (r + mi) / 2;
      method = `|r|=${fmtNum(r, 3)}, MI≈${fmtNum(mi, 3)}`;
    } else {
      // For categorical target: ANOVA F-ratio
      const groups = new Map();
      for (let i = 0; i < featVals.length; i++) {
        const g = String(targetVals[i]);
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(featVals[i]);
      }
      const k = groups.size;
      const N = featVals.length;
      const grandMean = ss.mean(featVals);
      const ssBetween = [...groups.values()].reduce((s, g) => s + g.length * Math.pow(ss.mean(g) - grandMean, 2), 0);
      const ssWithin = [...groups.values()].reduce((s, g) => { const gm = ss.mean(g); return s + g.reduce((ss2, v) => ss2 + Math.pow(v - gm, 2), 0); }, 0);
      const F = k > 1 && ssWithin > 0 ? (ssBetween / (k - 1)) / (ssWithin / (N - k)) : 0;
      score = Math.min(1, F / (F + N));
      method = `F=${fmtNum(F, 2)}`;
    }

    scores.push({ feat, score, method });
  }

  scores.sort((a, b) => b.score - a.score);
  const maxScore = scores[0]?.score || 1;

  const rows = scores.map((s, i) => {
    const bar = "#".repeat(Math.round((s.score / maxScore) * 20));
    return [i + 1, s.feat, fmtNum(s.score, 4), s.method, bar];
  });

  return {
    content: [
      {
        type: "text",
        text:
          `Feature Importance: predicting "${args.target}"\n` +
          `${"=".repeat(55)}\n` +
          `Target type: ${targetIsNumeric ? "numeric (uses correlation + mutual info)" : "categorical (uses ANOVA F-ratio)"}\n\n` +
          buildTable(["Rank", "Feature", "Score", "Details", "Importance"], rows),
      },
    ],
  };
}

// -----------------------------------------------------------------------
// Helper algorithms
// -----------------------------------------------------------------------

function scaleMatrix(matrix, doScale) {
  const n = matrix.length;
  const p = matrix[0].length;
  const means = new Array(p).fill(0);
  const stds = new Array(p).fill(1);

  if (!doScale) return { scaled: matrix, means, stds };

  for (let j = 0; j < p; j++) {
    const col = matrix.map(r => r[j]);
    means[j] = ss.mean(col);
    stds[j] = ss.standardDeviation(col) || 1;
  }

  const scaled = matrix.map(r => r.map((v, j) => (v - means[j]) / stds[j]));
  return { scaled, means, stds };
}

function computeWCSS(data, clusters, k) {
  const centroids = Array.from({ length: k }, () => []);
  data.forEach((x, i) => centroids[clusters[i]].push(x));
  return centroids.reduce((total, members) => {
    if (!members.length) return total;
    const centroid = members[0].map((_, j) => ss.mean(members.map(m => m[j])));
    return total + members.reduce((s, m) => s + Math.pow(euclidean(m, centroid), 2), 0);
  }, 0);
}

function computeSilhouette(data, clusters, k) {
  const n = data.length;
  if (n > 2000) {
    // Sample for efficiency
    const sample = Array.from({ length: 500 }, () => Math.floor(Math.random() * n));
    return computeSilhouetteSampled(data, clusters, k, sample);
  }

  let totalScore = 0;
  for (let i = 0; i < n; i++) {
    const ci = clusters[i];
    const same = data.filter((_, j) => clusters[j] === ci && j !== i);
    const a = same.length > 0 ? ss.mean(same.map(d => euclidean(data[i], d))) : 0;

    let minB = Infinity;
    for (let c = 0; c < k; c++) {
      if (c === ci) continue;
      const other = data.filter((_, j) => clusters[j] === c);
      if (other.length > 0) {
        const b = ss.mean(other.map(d => euclidean(data[i], d)));
        minB = Math.min(minB, b);
      }
    }
    totalScore += (minB - a) / Math.max(a, minB);
  }
  return totalScore / n;
}

function computeSilhouetteSampled(data, clusters, k, sampleIndices) {
  let total = 0;
  for (const i of sampleIndices) {
    const ci = clusters[i];
    const same = sampleIndices.filter(j => clusters[j] === ci && j !== i).map(j => data[j]);
    const a = same.length > 0 ? ss.mean(same.map(d => euclidean(data[i], d))) : 0;
    let minB = Infinity;
    for (let c = 0; c < k; c++) {
      if (c === ci) continue;
      const other = sampleIndices.filter(j => clusters[j] === c).map(j => data[j]);
      if (other.length > 0) minB = Math.min(minB, ss.mean(other.map(d => euclidean(data[i], d))));
    }
    total += (minB - a) / Math.max(a, minB);
  }
  return total / sampleIndices.length;
}

function euclidean(a, b) {
  return Math.sqrt(a.reduce((s, ai, i) => s + Math.pow(ai - b[i], 2), 0));
}

function fitGaussianNB(data, classes, nFeatures) {
  const priors = {}, means = {}, vars = {};
  const n = data.length;
  for (const c of classes) {
    const classData = data.filter(d => d.y === c).map(d => d.x);
    priors[c] = classData.length / n;
    means[c] = Array.from({ length: nFeatures }, (_, j) => ss.mean(classData.map(x => x[j])));
    vars[c] = Array.from({ length: nFeatures }, (_, j) => Math.max(1e-9, ss.variance(classData.map(x => x[j]))));
  }
  return { priors, means, vars };
}

function predictGaussianNB(model, x, classes) {
  let bestClass = classes[0], bestLogP = -Infinity;
  for (const c of classes) {
    let logP = Math.log(model.priors[c]);
    for (let j = 0; j < x.length; j++) {
      const mu = model.means[c][j], sigma2 = model.vars[c][j];
      logP += -0.5 * Math.log(2 * Math.PI * sigma2) - Math.pow(x[j] - mu, 2) / (2 * sigma2);
    }
    if (logP > bestLogP) { bestLogP = logP; bestClass = c; }
  }
  return bestClass;
}

function mahalanobisDistances(matrix) {
  const n = matrix.length;
  const p = matrix[0].length;
  const Xm = new Matrix(matrix);
  const means = matrix[0].map((_, j) => ss.mean(matrix.map(r => r[j])));
  const centered = matrix.map(r => r.map((v, j) => v - means[j]));
  const Xc = new Matrix(centered);
  const cov = Xc.transpose().mmul(Xc).mul(1 / (n - 1));
  const covInv = cov.inverse();
  return centered.map(r => {
    const rv = Matrix.columnVector(r);
    return rv.transpose().mmul(covInv).mmul(rv).get(0, 0);
  });
}

function isolationForestScores(matrix) {
  const n = matrix.length;
  const nTrees = 100;
  const subSampleSize = Math.min(256, n);
  const scores = new Array(n).fill(0);

  for (let t = 0; t < nTrees; t++) {
    const sample = shuffleArray([...Array(n).keys()]).slice(0, subSampleSize);
    const sampleData = sample.map(i => matrix[i]);
    const tree = buildITree(sampleData, 0, Math.ceil(Math.log2(subSampleSize)));

    for (let i = 0; i < n; i++) {
      scores[i] += pathLength(matrix[i], tree, 0) / nTrees;
    }
  }

  const avgPathLength = cITree(subSampleSize);
  return scores.map(s => Math.pow(2, -s / avgPathLength));
}

function buildITree(data, depth, maxDepth) {
  if (depth >= maxDepth || data.length <= 1) return { isLeaf: true, size: data.length };
  const p = Math.floor(Math.random() * data[0].length);
  const vals = data.map(d => d[p]);
  const min = Math.min(...vals), max = Math.max(...vals);
  if (min === max) return { isLeaf: true, size: data.length };
  const split = min + Math.random() * (max - min);
  const left = data.filter(d => d[p] < split);
  const right = data.filter(d => d[p] >= split);
  return { isLeaf: false, p, split, left: buildITree(left, depth + 1, maxDepth), right: buildITree(right, depth + 1, maxDepth) };
}

function pathLength(x, node, depth) {
  if (node.isLeaf) return depth + cITree(node.size);
  return x[node.p] < node.split
    ? pathLength(x, node.left, depth + 1)
    : pathLength(x, node.right, depth + 1);
}

function cITree(n) {
  if (n <= 1) return 0;
  return 2 * (Math.log(n - 1) + 0.5772156649) - 2 * (n - 1) / n;
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function approxMutualInfo(x, y) {
  // Discretise both into 10 bins and compute MI
  const bins = 10;
  const xMin = Math.min(...x), xMax = Math.max(...x);
  const yMin = Math.min(...y), yMax = Math.max(...y);
  const binX = v => Math.min(bins - 1, Math.floor((v - xMin) / ((xMax - xMin + 1e-10) / bins)));
  const binY = v => Math.min(bins - 1, Math.floor((v - yMin) / ((yMax - yMin + 1e-10) / bins)));

  const n = x.length;
  const joint = {};
  const margX = {}, margY = {};
  for (let i = 0; i < n; i++) {
    const bx = binX(x[i]), by = binY(y[i]);
    const key = `${bx},${by}`;
    joint[key] = (joint[key] || 0) + 1;
    margX[bx] = (margX[bx] || 0) + 1;
    margY[by] = (margY[by] || 0) + 1;
  }

  let mi = 0;
  for (const [key, cnt] of Object.entries(joint)) {
    const [bx, by] = key.split(",").map(Number);
    const pXY = cnt / n;
    const pX = margX[bx] / n;
    const pY = margY[by] / n;
    if (pXY > 0 && pX > 0 && pY > 0) mi += pXY * Math.log(pXY / (pX * pY));
  }
  return Math.max(0, mi);
}

function computeClassificationMetrics(actual, predicted, classes) {
  const confMatrix = {};
  for (const c of classes) { confMatrix[c] = {}; for (const p of classes) confMatrix[c][p] = 0; }
  for (let i = 0; i < actual.length; i++) {
    if (confMatrix[actual[i]]) confMatrix[actual[i]][predicted[i]] = (confMatrix[actual[i]][predicted[i]] || 0) + 1;
  }

  let correct = 0;
  const precision = {}, recall = {}, f1 = {}, support = {};
  for (const c of classes) {
    const tp = confMatrix[c][c] || 0;
    const fp = classes.reduce((s, p) => s + (p !== c ? (confMatrix[p]?.[c] || 0) : 0), 0);
    const fn = classes.reduce((s, p) => s + (p !== c ? (confMatrix[c]?.[p] || 0) : 0), 0);
    support[c] = tp + fn;
    precision[c] = tp + fp > 0 ? tp / (tp + fp) : 0;
    recall[c] = tp + fn > 0 ? tp / (tp + fn) : 0;
    f1[c] = precision[c] + recall[c] > 0 ? 2 * precision[c] * recall[c] / (precision[c] + recall[c]) : 0;
    correct += tp;
  }

  return {
    accuracy: correct / actual.length,
    precision, recall, f1, support, confMatrix,
  };
}

function interpretSilhouette(s) {
  if (s >= 0.7) return "(strong cluster structure)";
  if (s >= 0.5) return "(reasonable structure)";
  if (s >= 0.25) return "(weak structure)";
  return "(no substantial structure)";
}
