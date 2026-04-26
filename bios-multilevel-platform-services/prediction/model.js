function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function inferStepSeconds(series) {
  const diffs = [];
  for (let i = 1; i < series.length; i += 1) {
    const diff = series[i].timestamp - series[i - 1].timestamp;
    if (diff > 0) diffs.push(diff);
  }
  if (diffs.length === 0) return 3600;
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)];
}

function linearFit(series) {
  const n = series.length;
  if (n < 2) return { slope: 0, intercept: series[0]?.value || 0 };
  const x0 = series[0].timestamp;
  const xs = series.map(point => (point.timestamp - x0) / 3600);
  const ys = series.map(point => point.value);
  const xMean = mean(xs);
  const yMean = mean(ys);
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i += 1) {
    numerator += (xs[i] - xMean) * (ys[i] - yMean);
    denominator += (xs[i] - xMean) ** 2;
  }
  const slope = denominator === 0 ? 0 : numerator / denominator;
  return { slope, intercept: yMean - slope * xMean, x0 };
}

function linearPredict(model, timestamp) {
  return model.intercept + model.slope * ((timestamp - model.x0) / 3600);
}

function seasonalHourlyModel(series) {
  const buckets = new Map();
  for (const point of series) {
    const hour = new Date(point.timestamp * 1000).getUTCHours();
    if (!buckets.has(hour)) buckets.set(hour, []);
    buckets.get(hour).push(point.value);
  }
  const globalMean = mean(series.map(point => point.value));
  return { buckets, globalMean };
}

function seasonalPredict(model, timestamp) {
  const hour = new Date(timestamp * 1000).getUTCHours();
  const values = model.buckets.get(hour);
  return values && values.length ? mean(values) : model.globalMean;
}

function rmse(actual, predict) {
  if (actual.length === 0) return Number.POSITIVE_INFINITY;
  const error = actual.reduce((sum, point) => {
    const diff = point.value - predict(point.timestamp);
    return sum + diff * diff;
  }, 0);
  return Math.sqrt(error / actual.length);
}

function chooseModel(series) {
  if (series.length < 4) {
    return {
      name: 'mean-baseline',
      error: 0,
      predict: () => mean(series.map(point => point.value)),
      comparisons: [],
      reason: 'too_few_samples_for_holdout',
      holdoutSize: 0,
    };
  }

  const split = Math.max(2, Math.floor(series.length * 0.8));
  const train = series.slice(0, split);
  const holdout = series.slice(split);
  const linear = linearFit(train);
  const seasonal = seasonalHourlyModel(train);

  const candidates = [
    {
      name: 'linear-regression',
      error: rmse(holdout, timestamp => linearPredict(linear, timestamp)),
      predict: timestamp => linearPredict(linear, timestamp),
      params: { slope: linear.slope, intercept: linear.intercept },
    },
    {
      name: 'seasonal-hourly-baseline',
      error: rmse(holdout, timestamp => seasonalPredict(seasonal, timestamp)),
      predict: timestamp => seasonalPredict(seasonal, timestamp),
      params: { hoursCovered: seasonal.buckets.size, globalMean: seasonal.globalMean },
    },
  ];

  candidates.sort((a, b) => a.error - b.error);
  const winner = candidates[0];
  return {
    ...winner,
    comparisons: candidates.slice(1).map(candidate => ({
      name: candidate.name,
      error: Number(candidate.error.toFixed(4)),
    })),
    reason: 'lowest_holdout_rmse',
    holdoutSize: holdout.length,
    trainSize: train.length,
  };
}

function forecast(series, horizonHours) {
  if (series.length === 0) throw new Error('not enough data for forecast');
  const cappedHorizon = Math.min(Math.max(Number(horizonHours) || 24, 1), 48);
  const step = inferStepSeconds(series);
  const steps = Math.max(1, Math.ceil((cappedHorizon * 3600) / step));
  const model = chooseModel(series);
  const lastTs = series[series.length - 1].timestamp;
  const values = series.map(point => point.value);
  const sigma = Math.sqrt(mean(values.map(value => (value - mean(values)) ** 2)));

  const points = [];
  for (let i = 1; i <= steps; i += 1) {
    const timestamp = lastTs + step * i;
    const value = model.predict(timestamp);
    points.push({
      timestamp,
      value: Number(value.toFixed(4)),
      lower: Number((value - sigma).toFixed(4)),
      upper: Number((value + sigma).toFixed(4)),
    });
  }

  return {
    model: model.name,
    residualError: Number((Number.isFinite(model.error) ? model.error : 0).toFixed(4)),
    horizonHours: cappedHorizon,
    sigma: Number(sigma.toFixed(4)),
    modelComparisons: model.comparisons || [],
    modelParams: model.params || null,
    modelReason: model.reason || null,
    trainSize: model.trainSize || 0,
    holdoutSize: model.holdoutSize || 0,
    points,
  };
}

function anomalies(series) {
  if (series.length < 6) return [];
  const model = chooseModel(series.slice(0, Math.max(3, Math.floor(series.length * 0.7))));
  const values = series.map(point => point.value);
  const avg = mean(values);
  const sigma = Math.sqrt(mean(values.map(value => (value - avg) ** 2))) || 1;

  return series.flatMap(point => {
    const expected = model.predict(point.timestamp);
    const deviation = Math.abs(point.value - expected);
    if (deviation < sigma * 2) return [];
    return [{
      timestamp: point.timestamp,
      actual: point.value,
      expected: Number(expected.toFixed(4)),
      deviation: Number(deviation.toFixed(4)),
      severity: deviation >= sigma * 3 ? 'high' : 'medium',
    }];
  });
}

module.exports = { forecast, anomalies, chooseModel, inferStepSeconds };
