/**
 * youtube-auth.mjs — produit YOUTUBE_REFRESH_TOKEN, une seule fois, sur ton PC.
 * ------------------------------------------------------------------
 * MARKETING_PLAN.md, phase A. Le workflow GitHub publie les Shorts avec ce
 * jeton : il remplace ta connexion Google, sans jamais connaître ton mot de passe.
 *
 *   cd server
 *   npm run youtube:auth
 *
 * Le script demande le Client ID et le Client secret (rien n'est écrit sur le
 * disque), ouvre Google dans le navigateur, attend ton accord sur
 * http://127.0.0.1:<port>, puis affiche le refresh token à copier dans le
 * secret GitHub YOUTUBE_REFRESH_TOKEN.
 *
 * Choisis la CHAÎNE ArakIce (pas ton compte perso) quand Google le demande.
 * Aucune dépendance : Node 18+ (fetch intégré).
 */
import http from "node:http";
import { exec } from "node:child_process";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

// youtube.upload : publier. youtube.readonly : lire le nom de la chaîne pour
// vérifier qu'on publie au bon endroit (affiché à la fin).
const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
];

const rl = readline.createInterface({ input: stdin, output: stdout });
const clientId = (process.env.YOUTUBE_CLIENT_ID || (await rl.question("Client ID (…apps.googleusercontent.com) : "))).trim();
const clientSecret = (process.env.YOUTUBE_CLIENT_SECRET || (await rl.question("Client secret (GOCSPX-…) : "))).trim();
rl.close();

if (!clientId.endsWith(".apps.googleusercontent.com")) {
  console.error("\n✖ Ce n'est pas un Client ID : il doit finir par .apps.googleusercontent.com");
  process.exit(1);
}
if (!clientSecret) {
  console.error("\n✖ Client secret vide.");
  process.exit(1);
}

const server = http.createServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const redirectUri = `http://127.0.0.1:${server.address().port}`;

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline", // ← c'est ce qui donne un refresh token
    prompt: "consent",      // ← et celui-ci le redonne même si tu as déjà accepté
  });

console.log("\nOuvre ce lien s'il ne s'ouvre pas tout seul :\n\n" + authUrl + "\n");
const opener = process.platform === "win32" ? `start "" "${authUrl}"` : process.platform === "darwin" ? `open "${authUrl}"` : `xdg-open "${authUrl}"`;
exec(opener, () => {});

const code = await new Promise((resolve, reject) => {
  server.on("request", (req, res) => {
    const u = new URL(req.url, redirectUri);
    const err = u.searchParams.get("error");
    const c = u.searchParams.get("code");
    if (!err && !c) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(err
      ? `<h2>Refusé : ${err}</h2><p>Tu peux fermer cet onglet.</p>`
      : "<h2>C'est bon ✔</h2><p>Retourne dans le terminal. Tu peux fermer cet onglet.</p>");
    server.close();
    err ? reject(new Error(err)) : resolve(c);
  });
});

const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  }),
});
const tok = await tokenRes.json();
if (!tokenRes.ok) {
  console.error("\n✖ Google a refusé l'échange :", tok.error, tok.error_description || "");
  if (tok.error === "invalid_client") console.error("  → Client ID ou Client secret faux (ou d'un autre identifiant).");
  process.exit(1);
}
if (!tok.refresh_token) {
  console.error("\n✖ Pas de refresh token dans la réponse. Révoque l'accès sur https://myaccount.google.com/permissions puis relance.");
  process.exit(1);
}

// Vérifie sur quelle chaîne on publiera.
let channel = "(inconnue)";
try {
  const ch = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
    headers: { Authorization: `Bearer ${tok.access_token}` },
  }).then((r) => r.json());
  channel = ch.items?.[0]?.snippet?.title ?? "(aucune chaîne sur ce compte !)";
} catch { /* la vérification est un bonus */ }

console.log(`\n✔ Chaîne : ${channel}`);
console.log("\nYOUTUBE_REFRESH_TOKEN =\n\n" + tok.refresh_token + "\n");
console.log("Copie-le dans GitHub → Settings → Secrets and variables → Actions → New repository secret.");
console.log("Ne le colle nulle part ailleurs (ni dans le chat, ni dans un fichier du dépôt).\n");
