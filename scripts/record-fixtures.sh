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

# OpenAlex citation data (stage 3a). These files are committed trimmed (fewer references and results) so the tests
# stay readable: re-recording them means updating the expectations in test/main/citations/*.test.ts.
OA="https://api.openalex.org"
JSON="application/json"
get "$OA/works/W2754665629?select=id,doi,referenced_works,cited_by_count" "$JSON" "$out/drain.refs.openalex.json"
get "$OA/works/doi:10.48550/arxiv.2008.06448?select=id,doi,referenced_works,cited_by_count" "$JSON" "$out/loghub.refs.openalex.json"
get "$OA/works?search=Drain%3A%20An%20Online%20Log%20Parsing%20Approach%20with%20Fixed%20Depth%20Tree&filter=publication_year:2017&select=id,title,publication_year&per-page=10" "$JSON" "$out/drain.search.openalex.json"
get "$OA/works?filter=cites:W3049160591&select=id&per-page=2&cursor=*" "$JSON" "$out/loghub.cites-1.openalex.json"
cursor=$(node -e "process.stdout.write(encodeURIComponent(require('./$out/loghub.cites-1.openalex.json').meta.next_cursor))")
get "$OA/works?filter=cites:W3049160591&select=id&per-page=2&cursor=$cursor" "$JSON" "$out/loghub.cites-2.openalex.json"
get "$OA/works?filter=ids.openalex:W1532325895%7CW2153470728%7CW2527994611&select=id,doi,title,publication_year,authorships,cited_by_count&per-page=100" "$JSON" "$out/refs.batch.openalex.json"

echo "fixtures written to $out"
