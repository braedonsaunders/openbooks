#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
env_file="$repo_dir/.env.compose"

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
  admin_password=$(random_hex 18)
  postgres_password=$(random_hex 24)
  redis_password=$(random_hex 24)
  minio_password=$(random_hex 24)
  session_secret=$(random_hex 48)
  data_key=$(random_hex 32)
  internal_token=$(random_hex 48)

  {
    printf '%s\n' \
      'OPENBOOKS_IMAGE_TAG=latest' \
      'OPENBOOKS_PORT=4780' \
      'OPENBOOKS_APP_URL=http://localhost:4780' \
      "POSTGRES_PASSWORD=$postgres_password" \
      "REDIS_PASSWORD=$redis_password" \
      'MINIO_ROOT_USER=openbooks' \
      "MINIO_ROOT_PASSWORD=$minio_password" \
      "SESSION_SECRET=$session_secret" \
      "OPENBOOKS_DATA_KEY=$data_key" \
      "OPENBOOKS_INTERNAL_TOKEN=$internal_token" \
      'ORG_NAME=OpenBooks' \
      'ORG_CURRENCY=CAD' \
      'ORG_COUNTRY=CA' \
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
