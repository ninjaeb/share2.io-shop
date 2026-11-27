#!/usr/bin/env bash
# Upload the shop to cPanel over FTPS and ask Passenger to restart.
# The FTP account's home folder must be public_html/shop. Nothing is deleted.
set -euo pipefail
: "${FTP_SERVER:?missing secret}" "${FTP_USERNAME:?missing secret}" "${LFTP_PASSWORD:?missing secret}"
date -u +%FT%TZ > restart.txt
lftp -c "
set cmd:fail-exit true
set ftp:ssl-force true
set ftp:ssl-protect-data true
set net:max-retries 2
set net:timeout 30
open --user \"$FTP_USERNAME\" --env-password \"ftp://$FTP_SERVER\"
mirror --reverse --verbose public public
put server.js admin.js db.js package.json
mkdir -p -f tmp
put -O tmp restart.txt
"
