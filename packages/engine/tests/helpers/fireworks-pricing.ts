const MODEL = 'accounts/fireworks/models/qwen3p8-max';
// Minimal rendered markup from fireworks.ai/models/fireworks/qwen3p8-max,
// verified 2026-09-13. React comment separators are part of the live format.
export function ratePage(model = MODEL, rates = '$<!-- -->2.00 / $0.25 / $6.00', units = '1M Tokens', labels = 'input/cached input/output'): string {
  return `<span>model path:</span><span>${model}</span><h3>Available Serverless</h3><p>Run queries immediately, pay only for usage</p><div><div>${rates}</div><div>Per <!-- -->${units} (${labels})</div></div>`;
}
