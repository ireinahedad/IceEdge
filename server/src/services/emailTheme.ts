// ============================================================
//  Thème des courriels ArakIce (Resend)
// ============================================================
// Source unique de l'apparence de TOUS les courriels envoyés par ArakIce :
// codes (inscription, mot de passe, suppression), cycle de vie de l'essai Pro,
// et notifications internes (scripts/lib/parlayPublish.ts).
//
// Les couleurs reprennent le design system de l'app (client : LoginPage,
// pro/ProSections, BottomNav) : accent bleu glace #86d1ea, surfaces #0A0E0C /
// #131A12, bordure #283323. Changer une couleur ici la change partout.
//
// Logo : image hébergée (les clients courriel ne lisent ni SVG ni data: URI de
// façon fiable). On sert la variante 192 px affichée à 48 px → nette sur un
// écran ×3, 24 ko au lieu des 1,49 Mo du master. ⚠️ Gmail met les images en
// cache via son proxy : renommer le fichier si le logo change.
//
// Pur (aucune dépendance) : importable depuis src/ comme depuis scripts/.

export const EMAIL_COLORS = {
  bg:      '#0A0E0C',
  surface: '#131A12',
  border:  '#283323',
  accent:  '#86d1ea',
  onAccent:'#0A0E0C',
  text:    '#F3F7F0',
  subtle:  '#B7C4AD',
  muted:   '#92A08A',
  warning: '#FACC15',
} as const;

// Domaine public fixe (comme les liens PRO_URL d'email.service) : CLIENT_URL
// peut pointer sur un aperçu Vercel, qu'on ne veut pas voir dans un courriel.
export const EMAIL_LOGO_URL = 'https://arakice.com/arakice-mark-192.png';

const FONT = "-apple-system,Segoe UI,Roboto,Arial,sans-serif";

/** En-tête : logo + mot-symbole ARAKICE, et un libellé optionnel (ex. « TikTok · ESSAI »). */
export function emailHeader(label?: string): string {
  const c = EMAIL_COLORS;
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;border-collapse:collapse">
      <tr>
        <td style="vertical-align:middle;padding:0 12px 0 0">
          <img src="${EMAIL_LOGO_URL}" width="48" height="48" alt="ArakIce" style="display:block;width:48px;height:48px;border:0;outline:none;text-decoration:none">
        </td>
        <td style="vertical-align:middle">
          <div style="font-family:Oswald,'Arial Narrow',${FONT};font-size:20px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:${c.text};line-height:1">ARAKICE</div>
          ${label ? `<div style="font-family:${FONT};font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:${c.accent};margin-top:6px">${label}</div>` : ''}
        </td>
      </tr>
    </table>`;
}

/** Enveloppe commune : fond sombre de l'app, en-tête avec logo, puis le contenu. */
export function emailLayout(body: string, opts: { label?: string; maxWidth?: number } = {}): string {
  const c = EMAIL_COLORS;
  return `
  <div style="background:${c.bg};padding:16px 0">
  <div style="font-family:${FONT};max-width:${opts.maxWidth ?? 480}px;margin:0 auto;padding:32px 24px;background:${c.bg};color:${c.text};border:1px solid ${c.border};border-radius:16px">
    ${emailHeader(opts.label)}
    ${body}
  </div>
  </div>`;
}

/** Bloc du code à 6 chiffres. */
export function emailCodeBox(code: string): string {
  const c = EMAIL_COLORS;
  return `<div style="font-size:34px;font-weight:700;letter-spacing:10px;text-align:center;padding:20px;background:${c.surface};border:1px solid ${c.border};border-radius:12px;color:${c.accent}">${code}</div>`;
}

/** Bouton d'action. */
export function emailButton(label: string, url: string): string {
  const c = EMAIL_COLORS;
  return `<a href="${url}" style="display:inline-block;margin:8px 0 22px;padding:12px 22px;background:${c.accent};color:${c.onAccent};font-weight:700;text-decoration:none;border-radius:10px">${label}</a>`;
}
