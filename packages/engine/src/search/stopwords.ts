// Conservative English FUNCTION-WORD list, shared by the recall lane (finding #3),
// the strict-AND lane's loose tokens, the navigational gate, and snippet highlight
// terms (Cycle 3.5). Deliberately excludes content words that look common but carry
// query intent (planning, trip, proposal, deal, notes, meeting): over-pruning is
// worse than under-pruning because exactness for function words still lives in
// quoted phrases and the exact-title lane.
export const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the',
  'and', 'or', 'but', 'nor', 'so', 'yet',
  'of', 'to', 'in', 'on', 'at', 'by', 'for', 'from', 'with', 'about', 'as',
  'into', 'onto', 'over', 'under', 'up', 'out', 'off',
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'have', 'has', 'had',
  'this', 'that', 'these', 'those',
  'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your', 'he', 'she', 'it', 'its', 'they', 'them', 'their',
  'what', 'which', 'who', 'whom', 'whose',
  'not', 'no', 'if', 'then', 'than', 'there', 'here',
  'some', 'any', 'all', 'each', 'both',
]);
