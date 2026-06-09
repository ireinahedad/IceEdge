/**
 * hockeyProps.ts — intentionally empty.
 *
 * All player prop and futures data is now generated dynamically:
 *   - Player props  → built from /api/nhl/players (real stats + pace calculation)
 *   - Season futures → built from /api/nhl/standings (top teams by points)
 *   - Probabilities → POST /api/predict/player-prop  (LLM endpoint)
 *   - Futures odds  → POST /api/predict/futures       (LLM endpoint)
 *   - Waterfall      → POST /api/predict/factors       (LLM endpoint)
 *
 * See predictionApiService.ts → factorsApiService for the API contracts.
 */
