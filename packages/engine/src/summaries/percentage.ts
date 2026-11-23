import type { PercentageDetails } from './types.js';
export function percentageOf(eligible: ReadonlySet<string>, matching: ReadonlySet<string>): {value:number|null;details:PercentageDetails} {
  let numerator=0;
  for (const id of eligible) if(matching.has(id)) numerator++;
  return {value:eligible.size === 0 ? null : 100*numerator/eligible.size,
    details:{numerator_count:numerator,denominator_count:eligible.size}};
}
