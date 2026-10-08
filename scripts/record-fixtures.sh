#!/usr/bin/env bash
# Records real HTTP responses used by test/main/ingest/MetadataResolver.test.ts.
# Run once with network access; tests never touch the network.
set -euo pipefail
out="test/fixtures/http"
mkdir -p "$out"
get() { curl -sSfL -H "Accept: $2" "$1" -o "$3"; }
CSL="application/vnd.citationstyles.csl+json"
BIB="application/x-bibtex"
get "https://doi.org/10.1109/ICWS.2017.13" "$CSL" "$out/drain.csl.json"
get "https://doi.org/10.1109/ICWS.2017.13" "$BIB" "$out/drain.bib"
get "https://api.openalex.org/works/doi:10.1109/ICWS.2017.13" "application/json" "$out/drain.openalex.json"
get "https://doi.org/10.48550/arXiv.2008.06448" "$CSL" "$out/loghub.csl.json"
get "https://doi.org/10.48550/arXiv.2008.06448" "$BIB" "$out/loghub.bib"
get "https://api.openalex.org/works/doi:10.48550/arXiv.2008.06448" "application/json" "$out/loghub.openalex.json"
echo "fixtures written to $out"
