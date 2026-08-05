#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
env_file="$repo_dir/.env.compose"

official_openbooks_image=ghcr.io/braedonsaunders/openbooks:0.1.0-alpha.3
supplied_openbooks_image=${OPENBOOKS_IMAGE:-}
configured_openbooks_image=$supplied_openbooks_image
if [ -z "$configured_openbooks_image" ] && [ -f "$env_file" ]; then
  configured_openbooks_image=$(sed -n 's/^OPENBOOKS_IMAGE=//p' "$env_file" | tail -1)
fi
if [ -z "$configured_openbooks_image" ]; then
  configured_openbooks_image=$official_openbooks_image
fi

if ! printf '%s\n' "$configured_openbooks_image" | grep -Eq '^.+@sha256:[0-9a-f]{64}$'; then
  if [ "$configured_openbooks_image" != "$official_openbooks_image" ]; then
    echo "OPENBOOKS_IMAGE must be an immutable sha256 digest reference." >&2
    echo "The only tag accepted by the installer is the official release: $official_openbooks_image" >&2
    exit 1
  fi

  echo "Resolving $official_openbooks_image to its immutable multi-platform digest..."
  docker pull "$official_openbooks_image"
  configured_openbooks_image=$(
    docker image inspect "$official_openbooks_image" \
      --format '{{range .RepoDigests}}{{println .}}{{end}}' \
      | sed -n '\|^ghcr.io/braedonsaunders/openbooks@sha256:[0-9a-f]\{64\}$|p' \
      | head -1
  )
  if ! printf '%s\n' "$configured_openbooks_image" | grep -Eq '^ghcr\.io/braedonsaunders/openbooks@sha256:[0-9a-f]{64}$'; then
    echo "Docker did not return an immutable digest for $official_openbooks_image." >&2
    exit 1
  fi
  echo "Using $configured_openbooks_image"
fi

case "$configured_openbooks_image" in
  example.invalid/*)
    echo "The example.invalid OpenBooks image is intentionally non-runnable; replace it with the approved release digest." >&2
    exit 1
    ;;
esac

if [ -n "$supplied_openbooks_image" ] && [ -f "$env_file" ]; then
  current_openbooks_image=$(sed -n 's/^OPENBOOKS_IMAGE=//p' "$env_file" | tail -1)
  if [ "$current_openbooks_image" != "$configured_openbooks_image" ]; then
    next_env_file="$env_file.tmp.$$"
    awk -v image="$configured_openbooks_image" '
      BEGIN { replaced = 0 }
      /^OPENBOOKS_IMAGE=/ { print "OPENBOOKS_IMAGE=" image; replaced = 1; next }
      { print }
      END { if (!replaced) print "OPENBOOKS_IMAGE=" image }
    ' "$env_file" > "$next_env_file"
    chmod 600 "$next_env_file"
    mv "$next_env_file" "$env_file"
    echo "Updated $env_file to the resolved image digest."
  fi
fi

random_hex() {
  byte_count=$1
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$byte_count"
  else
    od -An -N "$byte_count" -tx1 /dev/urandom | tr -d ' \n'
  fi
}

if [ ! -f "$env_file" ]; then
  umask 077
  org_country=${ORG_COUNTRY:-}
  org_currency=${ORG_CURRENCY:-}
  if [ -z "$org_country" ] || [ -z "$org_currency" ]; then
    if [ -t 0 ]; then
      printf 'Organization country (ISO 3166-1 alpha-2, e.g. US, CA, GB): '
      IFS= read -r org_country
      printf 'Base currency (ISO 4217, e.g. USD, CAD, EUR): '
      IFS= read -r org_currency
    else
      echo "ORG_COUNTRY and ORG_CURRENCY are required for an unattended first install." >&2
      echo "Example: ORG_COUNTRY=US ORG_CURRENCY=USD ./scripts/compose-up.sh" >&2
      exit 1
    fi
  fi
  org_country=$(printf '%s' "$org_country" | tr '[:lower:]' '[:upper:]')
  org_currency=$(printf '%s' "$org_currency" | tr '[:lower:]' '[:upper:]')
  case "$org_country" in
    [A-Z][A-Z]) ;;
    *) echo "ORG_COUNTRY must be a two-letter ISO country code." >&2; exit 1 ;;
  esac
  case "$org_currency" in
    [A-Z][A-Z][A-Z]) ;;
    *) echo "ORG_CURRENCY must be a three-letter ISO currency code." >&2; exit 1 ;;
  esac
  admin_password=$(random_hex 18)
  postgres_owner_password=$(random_hex 24)
  openbooks_db_password=$(random_hex 24)
  redis_password=$(random_hex 24)
  minio_password=$(random_hex 24)
  session_secret=$(random_hex 48)
  data_key=$(random_hex 32)
  internal_token=$(random_hex 48)

  {
    printf '%s\n' \
      "OPENBOOKS_IMAGE=$configured_openbooks_image" \
      'OPENBOOKS_PORT=4780' \
      'OPENBOOKS_APP_URL=http://localhost:4780' \
      "POSTGRES_OWNER_PASSWORD=$postgres_owner_password" \
      "OPENBOOKS_DB_PASSWORD=$openbooks_db_password" \
      "REDIS_PASSWORD=$redis_password" \
      'MINIO_ROOT_USER=openbooks' \
      "MINIO_ROOT_PASSWORD=$minio_password" \
      "SESSION_SECRET=$session_secret" \
      "OPENBOOKS_DATA_KEY=$data_key" \
      "OPENBOOKS_INTERNAL_TOKEN=$internal_token" \
      'ORG_NAME=OpenBooks' \
      "ORG_CURRENCY=$org_currency" \
      "ORG_COUNTRY=$org_country" \
      'ADMIN_EMAIL=admin@openbooks.local' \
      'ADMIN_NAME=Administrator' \
      "ADMIN_PASSWORD=$admin_password"
  } > "$env_file"
  chmod 600 "$env_file"
  echo "Created $env_file with random local credentials."
fi

cd "$repo_dir"
docker compose --env-file "$env_file" up -d --pull always --wait --wait-timeout 300

admin_email=$(sed -n 's/^ADMIN_EMAIL=//p' "$env_file")
admin_password=$(sed -n 's/^ADMIN_PASSWORD=//p' "$env_file")
app_url=$(sed -n 's/^OPENBOOKS_APP_URL=//p' "$env_file")

printf '\nOpenBooks is ready.\n'
printf 'URL:      %s\n' "$app_url"
printf 'Email:    %s\n' "$admin_email"
printf 'Password: %s\n' "$admin_password"
printf '\nCredentials are stored in .env.compose (mode 600). Back up that file securely.\n'
