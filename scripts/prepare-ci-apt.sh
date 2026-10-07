#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" != github-hosted || "${GITHUB_ACTIONS:-}" != true || "${RUNNER_OS:-}" != Linux ]]; then
  echo 'System package preparation requires the GitHub-hosted Linux workflow runner.' >&2
  exit 1
fi

# Keep Ubuntu's signed package verification while avoiding a stalled mirror
# holding every package installation until the entire job is cancelled.
if [[ -f /etc/apt/apt-mirrors.txt ]]; then
  printf '%s\n' 'https://archive.ubuntu.com/ubuntu/' | sudo tee /etc/apt/apt-mirrors.txt >/dev/null
fi
sudo tee /etc/apt/apt.conf.d/99openbooks-ci-network >/dev/null <<'APT'
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
Acquire::Retries "2";
APT
