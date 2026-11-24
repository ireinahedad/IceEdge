// Page de retour de la connexion TikTok (scripts/tiktok-auth.mjs). Tout reste
// dans le navigateur : rien n'est envoyé à un serveur. Le code est affiché via
// textContent (jamais innerHTML) et vérifié contre un format strict.
(function () {
  var q = new URLSearchParams(window.location.search);
  var status = document.getElementById('tk-status');
  var err = document.getElementById('tk-err');
  var code = q.get('code');
  var state = q.get('state') || '';
  var fail = function (msg) { status.hidden = true; err.hidden = false; err.textContent = msg; };

  if (q.get('error')) return fail('TikTok returned an error: ' + q.get('error') + (q.get('error_description') ? ' (' + q.get('error_description') + ')' : ''));
  if (!code) return fail('No code in this address. Start again from the terminal: node scripts/tiktok-auth.mjs');
  // Codes TikTok : lettres, chiffres et quelques symboles ; state : 32 hexadécimaux.
  if (!/^[A-Za-z0-9*!._~\-]{8,512}$/.test(code) || !/^[a-f0-9]{32}$/.test(state)) return fail('Unexpected code or state format. Start again from the terminal.');

  // Retirer le code de la barre d'adresse et de l'historique.
  try { window.history.replaceState(null, '', window.location.pathname); } catch (e) { /* ignore */ }

  var cmd = 'node scripts/tiktok-auth.mjs --code="' + code + '" --state=' + state;
  document.getElementById('tk-cmd').textContent = cmd;
  status.hidden = true;
  document.getElementById('tk-ok').hidden = false;
  document.getElementById('tk-copy').addEventListener('click', function () {
    var btn = this;
    navigator.clipboard.writeText(cmd).then(function () { btn.textContent = 'Copied'; }, function () { btn.textContent = 'Select the text above and copy it'; });
  });
})();
