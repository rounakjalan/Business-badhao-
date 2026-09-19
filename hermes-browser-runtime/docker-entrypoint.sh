#!/bin/sh
set -e

# A bind-mounted PROFILES_DIR (docker-compose.yml's ./profiles) can arrive
# from the host owned by whatever user created it — commonly root, since
# Docker auto-creates a missing bind-mount source directory as root before
# the container ever starts. The image itself chowns /data/profiles to the
# `hermes` user at build time, but that ownership is invisible the moment a
# host directory is mounted over it, silently leaving the non-root runtime
# user unable to create any organization's profile directory. Fixed here,
# every start, as root, before dropping to the real runtime user via gosu —
# the standard pattern official images (postgres, redis) use for exactly
# this bind-mount-ownership problem.
mkdir -p "${PROFILES_DIR:-/data/profiles}"
chown -R hermes:hermes "${PROFILES_DIR:-/data/profiles}" 2>/dev/null || true

exec gosu hermes "$@"
