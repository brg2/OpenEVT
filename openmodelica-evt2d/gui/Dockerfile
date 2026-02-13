FROM openmodelica/openmodelica:v1.26.1-gui

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    fluxbox \
    x11vnc \
    supervisor \
    xterm \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash omuser

COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY entrypoint.sh /entrypoint.sh
COPY bootstrap.mos /bootstrap.mos
RUN chmod +x /entrypoint.sh

WORKDIR /work

EXPOSE 5900

ENTRYPOINT ["/entrypoint.sh"]
