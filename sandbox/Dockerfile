# Jojo sandbox base image.
# Deliberately broad toolchain coverage so containerizing execution doesn't
# quietly narrow what stacks the agent can build/verify (JS/TS, Python, Go,
# plus common native build deps). Add more toolchains here as needed instead
# of falling back to host exec for them.

FROM node:20-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv \
      golang \
      git curl ca-certificates \
      build-essential \
      && rm -rf /var/lib/apt/lists/*

# Non-root user — containers run as this by default (see --cap-add list in
# sandbox.js, which grants just enough of root's normal capabilities for
# `npm install` / `pip install` to work without running as uid 0).
RUN useradd -m -u 1000 -s /bin/bash jojo
USER jojo
WORKDIR /workspace

CMD ["sleep", "infinity"]

