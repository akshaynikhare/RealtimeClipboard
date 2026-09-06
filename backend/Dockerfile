# RealtimeClipboard relay.
#
# One Python file, no database, no disk. The image is correspondingly boring,
# and the two things worth arguing about are both here on purpose:
#
#   - It runs as a non-root user. The relay holds ciphertext in RAM and writes
#     nothing, so a container break-out buys an attacker very little — but
#     "very little" is a claim that stops being true the moment somebody adds a
#     feature, and the time to run unprivileged is before that.
#   - There is no VOLUME and no writable path. That is not an oversight; a
#     relay that can persist is a relay that can be subpoenaed, and the whole
#     privacy claim is that this one cannot.

FROM python:3.13-slim AS base

# PYTHONUNBUFFERED so `docker logs` shows the startup warnings (replica pinning,
# bad env values) as they happen rather than when a buffer happens to flush.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Requirements first, so a change to main.py does not re-resolve the whole
# dependency tree on every rebuild.
#
# BOTH files. requirements-ha.txt is one pure-Python package, and leaving it out
# is what made deploy/helm's replica guard a lie: the chart refuses replicas > 1
# unless redis.enabled is set, and then deploys THIS image, which could not
# import redis — so shared.py fell back to inert and every pod ran its own
# private room table. The operator followed the instruction and got the exact
# split-brain the instruction exists to prevent. An image that can be scaled is
# worth more than the few hundred kilobytes.
COPY requirements.txt requirements-ha.txt ./
RUN pip install --no-cache-dir -r requirements.txt -r requirements-ha.txt

# shared.py too: main.py imports it unconditionally at module scope, so an image
# without it fails at import, not at the first cross-replica publish.
COPY main.py shared.py ./

# --system-site-packages is not needed and the user owns nothing: there is
# nothing in this image the relay should be able to modify at runtime.
RUN useradd --system --create-home --shell /usr/sbin/nologin relay
USER relay

EXPOSE 8000

# /health is already the endpoint a client uses to tell a live relay from a
# stale deploy, so it is the honest thing for an orchestrator to ask too.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2).status == 200 else 1)"

# --proxy-headers so X-Forwarded-For survives Caddy/nginx in front: _country_of
# reads it for the landing page's globe, and without it every session appears to
# come from the reverse proxy.
CMD ["python", "-m", "uvicorn", "main:app", \
     "--host", "0.0.0.0", "--port", "8000", \
     "--proxy-headers", "--forwarded-allow-ips", "*"]
