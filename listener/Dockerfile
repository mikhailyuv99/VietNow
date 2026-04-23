FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY . .

# Session file lives in /data so it survives container restarts.
# On Railway/Fly mount a persistent volume at /data.
ENV TG_SESSION=/data/vn_listener.session
VOLUME ["/data"]

CMD ["python", "live.py"]
