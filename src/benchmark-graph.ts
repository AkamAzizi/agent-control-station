export function renderBenchmarkGraph(report: {
  summaries: {
    variant: string;
    precision: number | null;
    recall: number | null;
    medianExplorationBytes: number | null;
    failures: number;
    runs: number;
  }[];
}): string {
  const width = 720;
  const height = 340;
  const baseline = report.summaries.find((row) => row.variant === 'baseline');
  const maxExplore = Math.max(1, ...report.summaries.map((row) => row.medianExplorationBytes ?? 0));
  const barWidth = 36;
  const gap = 86;
  const originX = 90;
  const originY = 250;
  const axisH = 180;
  const colors: Record<string, string> = {
    baseline: '#6e6e73',
    context: '#0071e3',
    packs: '#1f8a38',
  };
  const bars = report.summaries.map((row, index) => {
    const x = originX + index * gap;
    const explore = row.medianExplorationBytes ?? 0;
    const exploreH = (explore / maxExplore) * axisH;
    const precisionH = (row.precision ?? 0) * axisH;
    const recallH = (row.recall ?? 0) * axisH;
    const color = colors[row.variant] ?? '#1d1d1f';
    const relative =
      baseline?.medianExplorationBytes && row.medianExplorationBytes != null
        ? `${Math.round((row.medianExplorationBytes / baseline.medianExplorationBytes) * 100)}%`
        : 'n/a';
    return `
      <g transform="translate(${x},0)">
        <rect x="0" y="${originY - exploreH}" width="${barWidth}" height="${exploreH}" fill="${color}" opacity="0.9"/>
        <rect x="${barWidth + 6}" y="${originY - precisionH}" width="16" height="${precisionH}" fill="${color}" opacity="0.45"/>
        <rect x="${barWidth + 26}" y="${originY - recallH}" width="16" height="${recallH}" fill="${color}" opacity="0.25"/>
        <text x="${barWidth}" y="${originY + 22}" text-anchor="middle" font-size="12">${row.variant}</text>
        <text x="${barWidth}" y="${originY + 38}" text-anchor="middle" font-size="11" fill="#6e6e73">${relative} exploration</text>
      </g>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Benchmark exploration, precision, and recall">
  <rect width="100%" height="100%" fill="#f6f6f8"/>
  <text x="24" y="32" font-size="16" font-family="system-ui, sans-serif">Seeded corpus · exploration and quality</text>
  <text x="24" y="52" font-size="11" fill="#6e6e73" font-family="system-ui, sans-serif">Tall bar: median exploration bytes. Small bars: precision then recall. Fixture reviewer, not a model-quality claim.</text>
  <line x1="${originX - 20}" y1="${originY}" x2="${originX + gap * report.summaries.length}" y2="${originY}" stroke="#d2d2d7"/>
  ${bars.join('\n')}
  <g font-family="system-ui, sans-serif" font-size="11" fill="#6e6e73">
    <rect x="24" y="300" width="12" height="12" fill="#0071e3"/>
    <text x="42" y="310">exploration</text>
    <rect x="140" y="300" width="12" height="12" fill="#0071e3" opacity="0.45"/>
    <text x="158" y="310">precision</text>
    <rect x="240" y="300" width="12" height="12" fill="#0071e3" opacity="0.25"/>
    <text x="258" y="310">recall</text>
  </g>
</svg>
`;
}
