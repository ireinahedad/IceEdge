# Python 3.12 — wheels précompilés disponibles pour tous les packages ML
FROM python:3.12-slim

# IMPORTANT — ce Dockerfile vit dans ml/, pas dans ml/python/, et c'est délibéré :
# le contexte de build doit être ml/ pour que les modèles entraînés (ml/models,
# frère de ml/python) soient dans le contexte et embarqués dans l'image. Le
# placer ici le rend aussi détectable automatiquement par Railway/Render quand
# le root directory du service est `ml` — aucune variable de config à poser.
#
# Build local :   cd ml && docker build -t iceedge-ml .
# Voir ml/.dockerignore pour ce qui est exclu.

WORKDIR /app

# Sans ça, stdout n'est pas un TTY donc Python bufferise par blocs (~8 ko) : les
# `print("[ML] ✅ …")` du chargement des modèles n'apparaissent JAMAIS dans les
# logs Railway, alors que ceux d'uvicorn (via logging → stderr) passent. On perd
# le seul indicateur qui dit si les modèles sont chargés.
ENV PYTHONUNBUFFERED=1

# tini forwards signals to uvicorn; curl is used by the HEALTHCHECK below.
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc tini curl \
    && rm -rf /var/lib/apt/lists/*

# Installer les dépendances Python
COPY python/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copier le code.
# score_model.py est INDISPENSABLE : ml_service.py fait `from score_model import
# …` au niveau module. Sans lui l'image ne démarre pas du tout — ImportError
# avant même le premier log de chargement des modèles.
COPY python/ml_service.py python/score_model.py python/fetch_data.py python/train.py ./

# Copier les modèles entraînés. Ils vivent dans ml/models (frère de python/),
# donc ce COPY n'existe que parce que le contexte est ml/ — cf. la note en tête.
COPY models ./models

# Le code est aplati à la racine de /app, alors qu'en local il est dans
# ml/python/ : le chemin relatif "../models" du service pointerait sur /models.
# On fixe la destination explicitement, sinon le service démarre en mode règles
# sans la moindre erreur — panne silencieuse, exactement celle qu'on ne voit pas.
ENV MODELS_DIR=/app/models

# Run as a non-root user.
RUN useradd --create-home --uid 10001 appuser && chown -R appuser:appuser /app
USER appuser

# Platforms like Railway/Render inject $PORT; default to 8000 for local runs.
ENV PORT=8000
EXPOSE 8000

# Container-level liveness. Uses $PORT so it tracks whatever the platform injects.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD curl -fsS "http://localhost:${PORT}/health" || exit 1

# tini as PID 1 → clean shutdown of the uvicorn workers.
# sh -c + exec: expand $PORT, then replace the shell so uvicorn is tini's direct
# child (clean signal forwarding). $PORT lets Railway/Render set the bind port.
#
# --host :: (not 0.0.0.0) — Railway's private network is IPv6; environments
# created before 2025-10-16 resolve *.railway.internal to IPv6 ONLY, so a socket
# bound to 0.0.0.0 (IPv4) is simply unreachable from the backend. Binding to ::
# also accepts IPv4 through v4-mapped addresses (Linux default bindv6only=0), so
# local runs and public domains keep working.
ENTRYPOINT ["tini", "--"]
CMD ["sh", "-c", "exec uvicorn ml_service:app --host :: --port ${PORT:-8000} --workers 2"]
