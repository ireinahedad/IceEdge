// predictions-cron — lance à l'heure le workflow « Bilan — probabilités du matin ».
//
// Pourquoi : le cron de GitHub Actions a été retardé d'environ 6 h les 3 et 4 novembre 2026
// (passages à 20:50 et 21:09 UTC au lieu de 15:00). Un samedi, les matchs de l'après-midi
// (17:30 UTC au plus tôt) sortiraient du bilan public. Les crons Cloudflare partent à l'heure.
//
// Ce que fait le Worker : un POST workflow_dispatch vers GitHub, rien d'autre. Le workflow
// ne fait rien si le fichier du jour existe déjà : deux passages (15:03 et 16:03 UTC) sont
// donc sans risque, et le cron GitHub du workflow reste en secours.
//
// Pas de route HTTP : `workers_dev = false`, aucune URL publique.
// Secret : GITHUB_TOKEN (jeton fine-grained limité au dépôt, permission « Actions: Read and write »).

export const WORKFLOW = 'predictions-morning.yml';

/** Lance le workflow. Rend { ok, status, body } ; ne lève pas. */
export async function dispatch(env, fetchImpl = fetch) {
  const owner = env.GITHUB_OWNER, repo = env.GITHUB_REPO, ref = env.GITHUB_REF || 'master';
  if (!env.GITHUB_TOKEN || !owner || !repo) {
    return { ok: false, status: 0, body: 'GITHUB_TOKEN, GITHUB_OWNER et GITHUB_REPO sont requis' };
  }
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${WORKFLOW}/dispatches`;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'arakice-predictions-cron',
        'content-type': 'application/json',
      },
      // Pas de date : le script prend « aujourd'hui, heure de l'Est ».
      body: JSON.stringify({ ref }),
    });
    const body = res.status === 204 ? '' : (await res.text()).slice(0, 300);
    return { ok: res.status === 204, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: String(e?.message ?? e) };
  }
}

export default {
  async scheduled(controller, env, ctx) {
    const r = await dispatch(env);
    const when = new Date(controller.scheduledTime).toISOString();
    if (r.ok) console.log(`[predictions-cron] ${when} : workflow lancé`);
    // Une exception marque l'exécution en échec dans le tableau de bord Cloudflare.
    else throw new Error(`[predictions-cron] ${when} : échec HTTP ${r.status} ${r.body}`);
  },
};
