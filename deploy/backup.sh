#!/usr/bin/env bash
# MarkSync backup script - copies SQLite DB to backups/ and prunes old files.

set -euo pipefail

PROJECT_DIR="/vol2/1000/important-folders/it-projects/MarkSync"
DB_PATH="${PROJECT_DIR}/backend/data/bookmarks.db"
BACKUP_DIR="${PROJECT_DIR}/backups"
RETENTION_DAYS=30

mkdir -p "$BACKUP_DIR"

if [[ ! -f "$DB_PATH" ]]; then
  echo "[$(date +'%F %T')] DB not found at $DB_PATH, skipping" >&2
  exit 0
fi

TIMESTAMP=$(date +'%Y%m%d-%H%M%S')
DEST="$BACKUP_DIR/bookmarks-${TIMESTAMP}.db"

# SQLite online backup (safe with WAL)
sqlite3 "$DB_PATH" ".backup '${DEST}'"
gzip "$DEST"

echo "[$(date +'%F %T')] Backup: ${DEST}.gz"

# Prune older than RETENTION_DAYS
find "$BACKUP_DIR" -name 'bookmarks-*.db.gz' -mtime +${RETENTION_DAYS} -delete
echo "[$(date +'%F %T')] Pruned backups older than ${RETENTION_DAYS} days"
