/**
 * IceedgeLogo — ArakIce brand mark.
 *
 * ⚠️ NE PAS REPOINTER VERS /arakice-logo.png. Ce fichier est le master 1024×1024
 * et pèse 1,49 Mo. Il était servi ici tel quel, redimensionné par le navigateur
 * à 28–72 px : chaque écran qui affiche la marque (connexion, accueil, Pro, 404,
 * Conditions, Confidentialité, Support, succès d'abonnement) téléchargeait donc
 * 1,49 Mo pour peindre une vignette. Sur un forfait mobile c'est plusieurs
 * secondes et autant de données, à chaque premier chargement.
 *
 * Les variantes ci-dessous sont le MÊME visuel réduit (96/192/288 px, 8/24/49 ko).
 * Trois tailles parce que la plus grande utilisation est 72 px CSS, soit 216 px
 * sur un écran ×3. `sizes` dit au navigateur la largeur d'affichage réelle, donc
 * il ne télécharge que la variante nécessaire — 8 ko dans la barre de navigation.
 *
 * Le master reste dans /public : il sert de source pour régénérer ces variantes.
 */

interface IceedgeLogoProps {
  size?: number;
  wordmark?: boolean;
  className?: string;
}

export function IceedgeLogo({ size = 40, wordmark = true, className = "" }: IceedgeLogoProps) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`} style={{ lineHeight: 1 }}>
      <img
        src="/arakice-mark-192.png"
        srcSet="/arakice-mark-96.png 96w, /arakice-mark-192.png 192w, /arakice-mark-288.png 288w"
        sizes={`${size}px`}
        alt="ArakIce"
        width={size}
        height={size}
        decoding="async"
        style={{ width: size, height: size, objectFit: "contain", display: "block" }}
      />

      {wordmark && (
        <span
          style={{
            fontFamily: "'Oswald', 'Arial Narrow', sans-serif",
            fontWeight: 700,
            fontSize: size * 0.4,
            letterSpacing: "0.12em",
            color: "white",
            textTransform: "uppercase" as const,
          }}
        >
          ARAKICE
        </span>
      )}
    </div>
  );
}
