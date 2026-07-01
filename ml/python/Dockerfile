# Python 3.12 — wheels précompilés disponibles pour tous les packages ML
FROM python:3.12-slim

WORKDIR /app

# Dépendances système minimales
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Installer les dépendances Python
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copier le code et les modèles entraînés (si disponibles)
COPY ml_service.py .
COPY fetch_data.py .
COPY train.py .

# Copier les modèles XGBoost si déjà entraînés
# (sinon le service démarre en mode fallback règle-based)
COPY ../models ./models 2>/dev/null || true

EXPOSE 8000

# Utiliser gunicorn en prod pour la robustesse
CMD ["uvicorn", "ml_service:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
