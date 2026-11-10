#!/usr/bin/env bash
# Jalankan dari folder induk laundry-akbar-fullstack
set -e
rm -f laundry-akbar-fullstack.zip
zip -r laundry-akbar-fullstack.zip laundry-akbar-fullstack -x "*/node_modules/*" "*/.git/*" "*/.env" "*.log"
echo "Selesai: laundry-akbar-fullstack.zip"
