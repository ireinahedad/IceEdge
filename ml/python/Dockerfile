# Python 3.12 — wheels précompilés disponibles pour tous les packages ML
FROM python:3.12-slim

# IMPORTANT — build context must be the ml/ directory (the parent of python/),
# so the trained models in ml/models are inside the context and actually ship.
# Build with:   docker build -f Dockerfile        -t iceedge-ml ..   (from ml/python)
#          or:  docker build -f python/Dockerfile -t iceedge-ml .    (from ml/)
# NOTE: -f is resolved relative to your shell's cwd, NOT the build context.
# From ml/python the Dockerfile is ./Dockerfile, so `-f python/Dockerfile` here
# wrongly resolves to ml/python/python/Dockerfile and fails.
# See ml/.dockerignore for what's excluded.

WORKDIR /app

# tini forwards signals to uvicorn; curl is used by the HEALTHCHECK below.
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc tini curl \
    && rm -rf /var/lib/apt/lists/*

# Installer les dépendances Python
COPY python/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copier le code
COPY python/ml_service.py python/fetch_data.py python/train.py ./

# Copier les modèles entraînés. They live in ml/models (sibling of python/), so
# this only resolves when the build context is ml/ — see the note above. If the
# models are absent the service still boots in rule-based fallback mode.
COPY models ./models

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
