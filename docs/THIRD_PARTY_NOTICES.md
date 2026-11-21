# Third-Party Notices

## Espressif esptool-js

- Version: `0.7.0`
- Upstream: https://github.com/espressif/esptool-js
- Package integrity: `sha512-9wHuW/s9t4Vs6HKcr3pra3gbRVWwaN0eabMWodWH4KEJHEYZxgmWwZ3s0F4xcWVCZOc/L98bGZ4uWoZvR8KBKA==`
- Vendored browser bundle SHA-256: `00ebe6fb0b202976d3e2a3c6b9a6bd438c26a81d2af6739c95ac276a64c1a84e`
- License: Apache License 2.0; unmodified upstream license is shipped beside the bundle at `static/vendor/esptool-js-0.7.0.LICENSE.txt`.

The bundle is served locally from ShareSerial. The application does not load esptool-js or its dependencies from a CDN and does not add an npm runtime dependency.

The upstream browser bundle also includes code from:

- `pako` `2.1.0`, licensed under MIT and zlib; see `static/vendor/pako-2.1.0.LICENSE.txt`.
- `atob-lite` `2.0.0`, licensed under MIT; see `static/vendor/atob-lite-2.0.0.LICENSE.txt`.
