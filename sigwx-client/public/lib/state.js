// Request gate: every selection takes a token, and a response is applied
// only if its token is still the latest, so late responses are discarded.
// Browser-safe ES module.

export function createRequestGate() {
  let latest = 0;
  return {
    next: () => ++latest,
    isLatest: (token) => token === latest,
  };
}
